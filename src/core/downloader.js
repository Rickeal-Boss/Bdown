/**
 * 多线程（分片并发）下载引擎。
 *
 * 为什么能这么做：实测 B 站 CDN 返回 `Accept-Ranges: bytes` 与
 * `Access-Control-Allow-Origin: *`，因此扩展页面可以直接用 fetch + Range 并发拉取分片，
 * 再把分片写进随机访问目标（OPFS 临时文件或用户选定的文件）。
 *
 * 相比「一次性 fetch 整个文件」的好处：
 *  - 并发拉满带宽（默认 8 线程）；
 *  - 进度、速率、剩余时间可控；
 *  - 单个分片失败可以单独重试，不必重头再来；
 *  - 大文件不会把内存撑爆。
 *
 * ⚠️ 重要：B 站的 `playurl` 接口**不返回** DASH 轨的 `size` 字段，
 * 只能按 `bandwidth × duration / 8` 估算，误差可达数个百分点。若直接拿估算值去切分片，
 * 最后一个分片会越界（服务器返回的字节数少于请求量）从而整段失败。
 * 因此这里默认先发一个 `Range: bytes=0-0` 的探测请求拿到精确大小，
 * 并且在每个分片的响应里用 `Content-Range` 的总量做二次校正。
 */

import { retry, clamp } from './util.js';
import { missingRanges, completedBytes } from './resume.js';

/**
 * 允许注入的 fetch。默认用全局 fetch，测试时可替换成假实现，
 * 避免单测真的打到网络。
 */
let injectedFetch = null;
export function setFetchImpl(fn) {
  injectedFetch = fn;
}
function doFetch(url, init) {
  return (injectedFetch || globalThis.fetch)(url, init);
}

const DEFAULT_CONCURRENCY = 8;
const MIN_CHUNK = 512 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;

export class DownloadAborted extends Error {
  constructor() {
    super('下载已取消');
    this.name = 'DownloadAborted';
  }
}

/**
 * 探测远端文件大小（同时验证链接可用与是否支持 Range）。
 * @param {string} url
 * @param {{ signal?: AbortSignal, referer?: string }} [opts]
 * @returns {Promise<{ size: number, acceptRanges: boolean, contentType: string }>}
 */
export async function probeSize(url, { signal, referer } = {}) {
  const res = await doFetch(url, {
    method: 'GET',
    headers: {
      Range: 'bytes=0-0',
      ...(referer ? { Referer: referer } : {}),
    },
    credentials: 'omit',
    cache: 'no-store',
    signal,
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`探测文件大小失败：HTTP ${res.status}`);
  }
  const range = res.headers.get('Content-Range'); // bytes 0-0/12345
  let size = 0;
  if (range && range.includes('/')) {
    size = Number(range.split('/').pop());
  } else {
    size = Number(res.headers.get('Content-Length') || 0);
  }
  // 主动释放这次探测请求的 body
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
  return {
    size,
    acceptRanges: (res.headers.get('Accept-Ranges') || '').includes('bytes'),
    contentType: res.headers.get('Content-Type') || '',
  };
}

/** 从 Content-Range 里取出总量。 */
function totalFromContentRange(header) {
  if (!header || !header.includes('/')) return 0;
  const total = Number(header.split('/').pop());
  return Number.isFinite(total) ? total : 0;
}

/**
 * 并发分片下载到 sink。
 *
 * @param {object} o
 * @param {string[]} o.urls 首选 + 备用地址（自动在多个 CDN 之间回退）
 * @param {number} o.size 文件总大小的**估算值**（会被探测结果覆盖）
 * @param {{ writeAt(offset: number, bytes: Uint8Array): Promise<any> }} o.sink
 * @param {number} [o.concurrency]
 * @param {AbortSignal} [o.signal]
 * @param {(p: ProgressInfo) => void} [o.onProgress]
 * @param {string} [o.referer]
 * @param {boolean} [o.probe] 是否先探测精确大小（默认 true）
 * @param {(size: number) => void} [o.onResolvedSize] 拿到精确大小时回调
 * @returns {Promise<{ bytes: number, elapsed: number, size: number }>}
 */
export async function downloadRanged({
  urls,
  size,
  sink,
  concurrency = DEFAULT_CONCURRENCY,
  signal,
  onProgress = () => {},
  referer = 'https://www.bilibili.com/',
  probe = true,
  onResolvedSize,
  /** 断点续传：已完成的字节区间 [{start, end})（半开区间）。不传则从零开始。 */
  resumeRanges = null,
  /** 注入 fetch 实现，便于测试。不传用全局 fetch。 */
  fetchImpl = null,
}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) throw new Error('没有可用的下载地址');

  /* ---------- 1. 拿到精确大小 ---------- */
  if (probe) {
    try {
      const info = await probeSize(list[0], { signal, referer });
      if (info.size > 0 && info.size !== size) {
        size = info.size;
      }
      if (info.size > 0) onResolvedSize?.(info.size);
      if (!info.acceptRanges) {
        // 服务器不支持 Range：退回单连接顺序下载
        return downloadSequential({ urls: list, sink, signal, onProgress, referer, knownSize: size });
      }
    } catch (err) {
      if (signal?.aborted) throw new DownloadAborted();
      // 探测失败不致命：继续用估算值，尾部截断会在下面被容忍
    }
  }
  if (!size) throw new Error('未知文件大小，无法分片下载');

  /* ---------- 2. 切分片 ---------- */
  const chunkSize = clamp(Math.ceil(size / (concurrency * 4)), MIN_CHUNK, MAX_CHUNK);
  // 断点续传：已完成的区间不必重下，只下载缺失部分（gaps 是半开区间 [start, end)）
  const doneRanges = Array.isArray(resumeRanges) ? resumeRanges : [];
  const gaps = doneRanges.length ? missingRanges(size, doneRanges) : [{ start: 0, end: size }];
  const ranges = [];
  for (const g of gaps) {
    for (let start = g.start; start < g.end; start += chunkSize) {
      // HTTP Range 是闭区间，故 end 要 -1
      ranges.push({ start, end: Math.min(g.end, start + chunkSize) - 1, done: false });
    }
  }

  const startedAt = performance.now();
  // 续传时把已下字节计入进度，但不计入瞬时速度（否则首 tick 会虚高）
  let downloaded = doneRanges.length ? completedBytes(doneRanges) : 0;
  let lastTick = startedAt;
  let lastBytes = downloaded;
  let speed = 0;
  let cursor = 0;
  /** 最近一个写入成功的分片，供 onProgress 回传（续传记账用） */
  let lastRange = null;

  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - lastTick < 300) return;
    const dt = (now - lastTick) / 1000;
    if (dt > 0.05) {
      const inst = (downloaded - lastBytes) / dt;
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      lastTick = now;
      lastBytes = downloaded;
    }
    const elapsed = (now - startedAt) / 1000;
    onProgress({
      downloaded,
      total: size,
      ratio: size ? downloaded / size : 0,
      speed,
      elapsed,
      eta: speed > 0 ? (size - downloaded) / speed : Infinity,
      // 最近完成的分片区间（闭区间，与 HTTP Range 一致）。
      // 断点续传靠它增量记录进度；不需要续传时可以忽略。
      range: lastRange ? { start: lastRange.start, end: lastRange.end } : null,
    });
  };

  const throwIfAborted = () => {
    if (signal?.aborted) throw new DownloadAborted();
  };

  /**
   * 拉取一个分片。
   *
   * 返回 `{ bytes, shortAtEof }`：当服务器返回的字节数少于请求量、且响应里的
   * `Content-Range` 表明已经到达文件末尾时，视为正常（估算大小偏大导致），
   * 由调用方用真实大小修正进度即可。
   */
  const fetchRange = async (url, range, workerSignal) => {
    const res = await doFetch(url, {
      headers: {
        Range: `bytes=${range.start}-${range.end}`,
        Referer: referer,
      },
      credentials: 'omit',
      cache: 'no-store',
      signal: workerSignal,
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const expected = range.end - range.start + 1;

    if (res.status === 206) {
      if (bytes.length === expected) return { bytes, shortAtEof: false };
      const total = totalFromContentRange(res.headers.get('Content-Range'));
      if (total > 0 && range.start + bytes.length >= total) {
        return { bytes, shortAtEof: true, total };
      }
      throw new Error(`分片长度不符：期望 ${expected}，实际 ${bytes.length}`);
    }

    // status 200：服务器忽略了 Range，返回的是整个文件
    if (bytes.length !== expected) return { bytes, shortAtEof: true, total: bytes.length };
    return { bytes, shortAtEof: false };
  };

  const worker = async () => {
    for (;;) {
      throwIfAborted();
      const index = cursor++;
      if (index >= ranges.length) return;
      const range = ranges[index];

      let lastError;
      // 依次尝试主地址与备用地址，每个地址内部再重试 2 次
      for (const url of list) {
        try {
          const out = await retry(() => fetchRange(url, range, signal), { times: 2, baseDelay: 500 });
          throwIfAborted();
          await sink.writeAt(range.start, out.bytes);
          range.done = true;
          lastRange = { start: range.start, end: range.start + out.bytes.length - 1 };
          downloaded += out.bytes.length;
          if (out.shortAtEof && out.total) {
            // 真实大小比估算值小：修正进度基准，避免进度永远到不了 100%
            size = Math.min(size, out.total);
          }
          report();
          lastError = null;
          break;
        } catch (err) {
          if (err instanceof DownloadAborted) throw err;
          if (signal?.aborted) throw new DownloadAborted();
          lastError = err;
        }
      }
      if (lastError) {
        throw new Error(`分片 ${range.start}-${range.end} 下载失败：${lastError.message}`);
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, ranges.length) }, () => worker());
  await Promise.all(workers);
  report(true);
  return { bytes: downloaded, elapsed: (performance.now() - startedAt) / 1000, size };
}

/**
 * 顺序下载（备用：CDN 不支持 Range 时使用）。
 */
export async function downloadSequential({
  urls,
  sink,
  signal,
  onProgress = () => {},
  referer = 'https://www.bilibili.com/',
  knownSize = 0,
}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) throw new Error('没有可用的下载地址');

  let downloaded = 0;
  const startedAt = performance.now();
  let lastTick = startedAt;
  let lastBytes = 0;
  let speed = 0;

  let lastError;
  for (const url of list) {
    try {
      const res = await doFetch(url, {
        headers: { Referer: referer },
        credentials: 'omit',
        cache: 'no-store',
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('Content-Length') || 0) || knownSize;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await sink.writeAt(downloaded, value);
        downloaded += value.length;
        const now = performance.now();
        const dt = (now - lastTick) / 1000;
        if (dt > 0.3) {
          const inst = (downloaded - lastBytes) / dt;
          speed = speed ? speed * 0.7 + inst * 0.3 : inst;
          lastTick = now;
          lastBytes = downloaded;
          onProgress({
            downloaded,
            total: total || downloaded,
            ratio: total ? downloaded / total : 0,
            speed,
            elapsed: (now - startedAt) / 1000,
            eta: speed > 0 && total ? (total - downloaded) / speed : Infinity,
          });
        }
      }
      onProgress({
        downloaded,
        total: total || downloaded,
        ratio: 1,
        speed,
        elapsed: (performance.now() - startedAt) / 1000,
        eta: 0,
      });
      return { bytes: downloaded, elapsed: (performance.now() - startedAt) / 1000, size: downloaded };
    } catch (err) {
      if (signal?.aborted) throw new DownloadAborted();
      lastError = err;
    }
  }
  throw lastError || new Error('顺序下载失败');
}

/**
 * @typedef {object} ProgressInfo
 * @property {number} downloaded
 * @property {number} total
 * @property {number} ratio
 * @property {number} speed 字节/秒
 * @property {number} elapsed 秒
 * @property {number} eta 秒
 */
