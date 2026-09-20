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
/**
 * 抛出一个**带 status 的** HTTP 错误。
 *
 * 为什么要带 status：B 站 CDN 的播放地址约 120 分钟失效，失效后返回 403 / 404。
 * 上层（engine.fetchTo）需要据此判断「是 URL 过期」而不是网络抖动，
 * 从而重新 playurl 换一批地址再试——否则只是拿同一个过期地址重试 2 次，必然全败。
 */
function httpError(res) {
  const err = new Error(`HTTP ${res.status}`);
  err.status = res.status;
  return err;
}

/**
 * 单个网络请求的**响应头**超时（毫秒）。
 *
 * 为什么必须有：原来这里是裸 `fetch`，没有任何超时。一旦连接挂起（半开连接、
 * 服务端不响应、代理卡住），`await` 会**永远不返回** —— 任务永久停在
 * `downloading`，`runningCount` 永不归还，dashboard 里 startAll 的等待循环也一直转，
 * 用户只能杀掉整个下载中心标签页。
 *
 * 为什么只计到响应头：一旦服务端开始返回数据，说明连接是活的；此时再掐断会误杀
 * 大分片下载（单个分片最大 16MB，弱网下传几十秒很正常）。
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 带响应头超时的 fetch，同时保留外部 signal（用户取消）的语义。
 */
async function doFetch(url, init, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const fetchImpl = injectedFetch || globalThis.fetch;
  const external = init?.signal;
  const ctrl = new AbortController();

  let timer = null;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`请求超时：${timeoutMs}ms 内未收到响应头`);
      err.timeout = true;
      ctrl.abort(err);
      reject(err);
    }, timeoutMs);
  });
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

  // ★ 必须把**外部 signal（用户取消）与超时 signal 合并**后传给 fetch。
  //
  // 只传自建的 ctrl.signal 会把外部取消断开；而"转发 abort 事件"的写法若在
  // 拿到响应头后移除监听，则**读取 body 阶段无法取消** —— 用户点了取消，
  // 大分片仍会把几十 MB 读完才停（v1.4.22 引入、随即修复）。
  // `AbortSignal.any` 让两个 signal 中任意一个 abort 都能立刻中断 fetch，
  // 且中断会贯穿 header 与 body 两个阶段。
  let combined = ctrl.signal;
  if (external && external.addEventListener && typeof AbortSignal.any === 'function') {
    try { combined = AbortSignal.any([external, ctrl.signal]); } catch { combined = ctrl.signal; }
  }

  try {
    // 竞速：谁先完成算谁。拿到 res（响应头）后立刻清掉计时器，
    // 后续读取 body 不再受此时限约束（避免误杀大分片下载）。
    const res = await Promise.race([fetchImpl(url, { ...init, signal: combined }), timeoutPromise]);
    clear();
    return res;
  } catch (err) {
    clear();
    throw err;
  }
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
    const e = httpError(res);
    e.message = `探测文件大小失败：${e.message}`;
    throw e;
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
  /**
   * 写入起点偏移。用于 durl 多段下载：每段按自己的 range 下，
   * 但要写到整个文件的对应位置，否则后一段会从 0 开始覆盖前一段。
   */
  writeOffset = 0,
  /**
   * **每个地址的额外重试次数**（settings.retries）。
   *
   * 语义：单个分片对同一个地址最多尝试 `retries + 1` 次（1 次首试 + retries 次重试）。
   * 旧实现把这里**硬编码成 2**，而设置页的 `retries`（"失败重试次数"）从来没人读 ——
   * 用户调整它完全没有效果（v1.4.22 修复）。
   *
   * 注意总尝试次数还要乘上地址数（主地址 + backupUrls）：`list.length × (retries + 1)`。
   */
  retries = 2,
}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) throw new Error('没有可用的下载地址');

  // 归一化：必须用 Number.isFinite 兜住 NaN —— 否则 NaN 会一路传进 retry() 的
  // `for (i = 0; i < times; i++)`，使循环**一次都不执行**，表现为"分片静默不下载"
  // 且抛出 undefined（错误信息全丢）。这个坑在 v1.4.22 真实踩过一次。
  const rawRetries = Number(retries);
  const safeRetries = Number.isFinite(rawRetries)
    ? Math.min(5, Math.max(0, Math.floor(rawRetries)))
    : 2; // 默认与旧硬编码行为一致
  const attemptsPerUrl = safeRetries + 1;

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
  /**
   * 自上次进度上报以来、已写入成功的分片区间（闭区间）。
   *
   * 注意：不能只记"最近一个"。report() 有 300ms 节流，一次上报之间可能
   * 完成好几个分片；只留最后一个会让续传清单丢区间，下次重下这些片。
   */
  let pendingRanges = [];

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

    // 本次上报周期内完成的全部分片区间（闭区间，与 HTTP Range 一致）。
    // 断点续传靠它增量记账；不需要续传时可以忽略。`range` 保留最后一个仅为兼容。
    //
    // ★ 必须先**取值再清空**。旧写法是
    //     ranges: pendingRanges.splice(0), range: pendingRanges[pendingRanges.length - 1]
    //   `splice(0)` 已经把数组清空了，下一行再取末位必然是 undefined →
    //   `range` 恒为 null（v1.4.22 修复）。
    const done = pendingRanges.slice();
    pendingRanges.length = 0;

    onProgress({
      downloaded,
      total: size,
      ratio: size ? downloaded / size : 0,
      speed,
      elapsed,
      eta: speed > 0 ? (size - downloaded) / speed : Infinity,
      ranges: done.length ? done : null,
      range: done.length ? done[done.length - 1] : null,
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
      throw httpError(res);
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

    // status 200：服务器**忽略了 Range 头**，返回的是整个文件而非请求的片段。
    //
    // ★ 绝不能把它当成"成功拿到了这个分片"——整个 body 会被写到该分片的偏移上，
    //   而其余分片也各自拿到整个 body 再写到各自偏移，结果是文件被反复覆盖、
    //   长度越界数倍、内容全是重叠垃圾（静默产出坏文件，v1.4.22 修复的 P1）。
    //
    // 正确做法：抛一个带 `rangeIgnored` 标记的明确错误，
    //   - 上层（engine.fetchTo）已有兜底：回退到 downloadSequential 单请求顺序下载
    //   - worker 循环见到该标记会立即放弃，不再重试、不再试备用地址
    //     （否则 8 个分片 × 重试次数 × 备用地址 = 把整个文件重复下载几十遍）
    throw Object.assign(
      new Error(
        `服务器忽略了 Range 请求（返回 200 全量 ${bytes.length} 字节，期望 ${expected} 字节），` +
          '该地址不支持分片下载',
      ),
      { rangeIgnored: true, status: 200 },
    );
  };

  const worker = async () => {
    for (;;) {
      throwIfAborted();
      const index = cursor++;
      if (index >= ranges.length) return;
      const range = ranges[index];

      let lastError;
      // 依次尝试主地址与备用地址，每个地址内部再重试 `retries` 次（见 attemptsPerUrl）
      for (const url of list) {
        try {
          // 两类错误**不重试**：
          //   - DownloadAborted（用户取消）：已取消还要跑满次数并 sleep 是纯延迟
          //   - rangeIgnored（服务器不支持 Range）：重试只会把整个文件再下一遍，
          //     8 分片 × (retries+1) 可达 24 次全量下载
          const out = await retry(() => fetchRange(url, range, signal), {
            times: attemptsPerUrl,
            baseDelay: 500,
            shouldRetry: (err) => !(err instanceof DownloadAborted) && !err?.rangeIgnored,
          });
          throwIfAborted();
          await sink.writeAt(range.start + writeOffset, out.bytes);
          range.done = true;
          pendingRanges.push({ start: range.start, end: range.start + out.bytes.length - 1 });
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
          // 服务器不支持 Range：分片下载这条路走不通，立即放弃。
          // 继续重试/换备用地址只会把整个文件重复下载一遍又一遍。
          if (err?.rangeIgnored) throw err;
          lastError = err;
        }
      }
      if (lastError) {
        const e = new Error(`分片 ${range.start}-${range.end} 下载失败：${lastError.message}`);
        // **必须保留 status**：上层靠它判断是不是「播放地址过期」（403/404）。
        // 之前这里重新 new Error 时把 status 丢了，导致过期重试永远不会触发。
        if (lastError.status !== undefined) e.status = lastError.status;
        throw e;
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
      if (!res.ok) throw httpError(res);
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
