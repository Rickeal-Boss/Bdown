/**
 * 下载「后半段变慢」的两个结构性根因的回归测试（不联网）。
 *
 * 这两条都是 v1.4.23 之前**静默存在**的问题：
 *
 *  1. 响应体读取没有任何超时 —— doFetch 的 30s 只计到响应头。
 *     服务端一旦"先回响应头、再慢慢滴灌"，这一片会无限期读下去，
 *     其余分片早已下完，总进度卡在最后几个百分点。
 *     用户感知到的"被限速"，绝大多数就是这一片在拖。
 *
 *  2. 所有并发分片固定打 list[0] —— backupUrls 只当故障切换用，
 *     从不参与负载均衡，8 路并发全挤在同一台 CDN 主机上。
 *
 * 顺带锁住 sink 写入链不得被单次失败"毒化"（一次写失败 → 整个文件再也写不进去）。
 *
 * 运行：node tools/test-stall-rotation.mjs
 */
import { readBody, downloadRanged, setFetchImpl, DownloadAborted } from '../src/core/downloader.js';
import { FileHandleSink } from '../src/core/sink.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/** 造一个可控的流式 body：脚本化地吐 chunk，可故意卡住不吐。 */
function streamResponse(chunks, { hangAfter = false } = {}) {
  let cancelled = false;
  let i = 0;
  let pending = null;
  const body = {
    getReader() {
      return {
        read() {
          if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
          if (hangAfter) {
            // 永远不 resolve —— 模拟"连接活着但不给数据"
            return new Promise((resolve) => { pending = resolve; });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
        cancel() {
          cancelled = true;
          // 兑现挂起的 read，避免测试进程留着未决 promise
          if (pending) pending({ done: true, value: undefined });
          return Promise.resolve();
        },
      };
    },
  };
  return { body, isCancelled: () => cancelled };
}

console.log('\n[1] ★ 停滞检测：连接活着但不给数据时必须主动放弃');
{
  const r = streamResponse([new Uint8Array(10)], { hangAfter: true });
  const started = Date.now();
  let err = null;
  try {
    await readBody(r, { stallMs: 60 });
  } catch (e) {
    err = e;
  }
  const dt = Date.now() - started;
  ok('零字节停滞会抛错', err !== null, '一直读下去了 —— 分片会永久挂住整条下载');
  ok('错误带 stalled 标记', err?.stalled === true, `err.stalled=${err?.stalled}`);
  ok('在阈值附近触发（不会无限等）', dt < 2000, `耗时 ${dt}ms`);
  ok('放弃时关掉了 reader（不白占连接）', r.isCancelled() === true, 'reader 没被 cancel');
}

console.log('\n[2] 正常流式读取：多块拼接且总长正确');
{
  const r = streamResponse([new Uint8Array(3), new Uint8Array(5), new Uint8Array(2)]);
  const bytes = await readBody(r, { stallMs: 200 });
  ok('拼出的总长度正确', bytes.length === 10, `实际 ${bytes.length}`);
  ok('非空响应不会误判为停滞', bytes instanceof Uint8Array, '类型不对');
}

console.log('\n[3] ★ 取消必须贯穿 body 读取阶段');
{
  const r = streamResponse([], { hangAfter: true });
  const ctrl = new AbortController();
  let err = null;
  const p = readBody(r, { stallMs: 5000, signal: ctrl.signal }).catch((e) => { err = e; });
  setTimeout(() => ctrl.abort(), 20);
  await p;
  ok('外部 abort 会让读取立刻结束', err !== null, '读取没有被取消');
  ok('抛的是 DownloadAborted', err instanceof DownloadAborted, `实际 ${err?.name}`);
  ok('取消时也关掉了 reader', r.isCancelled() === true, 'reader 没被 cancel');
}

/**
 * 造一个"什么都支持"的假 CDN 响应。
 * 必须同时给出 accept-ranges: bytes，否则 downloadRanged 会判定"不支持 Range"
 * 而退回 downloadSequential（那条路不带 Range 头，会让下面的分片断言失去意义）。
 */
function cdnResponse(TOTAL, init, onUrl) {
  if (onUrl) onUrl();
  const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range || '');
  const s = m ? Number(m[1]) : 0;
  const e = m ? Number(m[2]) : TOTAL - 1;
  return {
    status: 206,
    headers: {
      get: (h) => {
        const k = String(h).toLowerCase();
        if (k === 'accept-ranges') return 'bytes';
        if (k === 'content-range') return `bytes ${s}-${e}/${TOTAL}`;
        if (k === 'content-length') return String(e - s + 1);
        return null;
      },
    },
    arrayBuffer: async () => new Uint8Array(e - s + 1).buffer,
  };
}

console.log('\n[4] ★ 并发分片必须分摊到多个地址（不能 8 路全打 list[0]）');
{
  const TOTAL = 8 * 1024 * 1024;
  const urls = [
    'https://a.cdn.test/video.m4s',
    'https://b.cdn.test/video.m4s',
    'https://c.cdn.test/video.m4s',
  ];
  const used = new Map();
  setFetchImpl(async (url, init) =>
    cdnResponse(TOTAL, init, () => used.set(url, (used.get(url) || 0) + 1)));

  const sink = { writes: 0, writeAt: async () => { sink.writes += 1; } };
  const res = await downloadRanged({ urls, size: TOTAL, sink, concurrency: 4, probe: true });

  ok('下载完成', res.bytes === TOTAL, `bytes=${res.bytes} / ${TOTAL}`);
  ok('用到了不止一个地址', used.size >= 2, `实际只用了 ${used.size} 个：${[...used.keys()].join(', ')}`);
  // 轮换是"每个 worker 从自己的地址起跳"，所以主地址仍会用，但不该独占
  const totalReqs = [...used.values()].reduce((a, b) => a + b, 0);
  const primaryShare = (used.get(urls[0]) || 0) / totalReqs;
  ok('主地址不再独占全部请求', primaryShare < 0.95, `主地址占比 ${(primaryShare * 100).toFixed(0)}%`);
}

console.log('\n[5] 备用地址连续失败时自动关掉轮换（backupUrls 可能缺签参）');
{
  const TOTAL = 8 * 1024 * 1024;
  const urls = ['https://primary.cdn.test/v.m4s', 'https://backup.cdn.test/v.m4s'];
  let backupAttempts = 0;
  setFetchImpl(async (url, init) => {
    if (url === urls[1]) {
      backupAttempts += 1;
      throw new Error('HTTP 403');
    }
    return cdnResponse(TOTAL, init);
  });
  const sink = { writeAt: async () => {} };
  const res = await downloadRanged({ urls, size: TOTAL, sink, concurrency: 4, probe: true });

  ok('备用地址全挂也能靠主地址下完', res.bytes === TOTAL, `bytes=${res.bytes}`);
  // 16 个分片里约一半会起跳到备用地址；若不关轮换，每个都会重试 3 次 ≈ 24 次以上。
  // 关掉后只允许最初那一两次探路失败。
  ok('备用地址的失败尝试被收敛', backupAttempts <= 12, `备用地址被尝试了 ${backupAttempts} 次（说明轮换没关掉）`);
}

console.log('\n[6] ★ sink 写入链不得被单次失败毒化');
{
  const sink = new FileHandleSink({});
  let failNext = true;
  sink.writable = {
    write: async ({ position, data }) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      void position;
      void data;
    },
  };

  let firstErr = null;
  try { await sink.writeAt(0, new Uint8Array(10)); } catch (e) { firstErr = e; }
  ok('第一次写入如实报错', firstErr !== null, '失败被吞掉了，调用方无从感知');

  let secondErr = null;
  try { await sink.writeAt(10, new Uint8Array(10)); } catch (e) { secondErr = e; }
  ok('★ 之后的写入必须仍然成功', secondErr === null, `后续写入被毒化：${secondErr?.message}`);

  let thirdErr = null;
  try { await sink.writeAt(20, new Uint8Array(10)); } catch (e) { thirdErr = e; }
  ok('第三次写入同样成功', thirdErr === null, `thirdErr=${thirdErr?.message}`);
  ok('size 只按成功的写入推进', sink.size === 30, `size=${sink.size}`);
}

console.log('\n[7] ★ 地址轮换的边界：单地址 / 分片数少于并发数都不能出问题');
{
  const TOTAL = 4 * 1024 * 1024;
  const only = ['https://solo.cdn.test/v.m4s'];
  const used = new Map();
  setFetchImpl(async (url, init) => cdnResponse(TOTAL, init, () => used.set(url, (used.get(url) || 0) + 1)));
  const sink = { writeAt: async () => {} };
  const res = await downloadRanged({ urls: only, size: TOTAL, sink, concurrency: 8, probe: true });
  ok('单地址也能下完（轮换开关正确关闭）', res.bytes === TOTAL, `bytes=${res.bytes}`);
  ok('单地址时不会编造出别的地址', [...used.keys()].join(',') === only[0], [...used.keys()].join(', '));

  // 分片数 < 并发数：8 路并发只切出 2 片，起跳下标不该越界
  const SMALL = 600 * 1024; // chunkSize 会被 clamp 到 MIN_CHUNK=512KB → 2 片
  const urls3 = ['https://a.t/x', 'https://b.t/x', 'https://c.t/x'];
  const used3 = new Map();
  setFetchImpl(async (url, init) => cdnResponse(SMALL, init, () => used3.set(url, (used3.get(url) || 0) + 1)));
  const res3 = await downloadRanged({ urls: urls3, size: SMALL, sink: { writeAt: async () => {} }, concurrency: 8, probe: true });
  ok('分片数少于并发数时也能下完', res3.bytes === SMALL, `bytes=${res3.bytes} / ${SMALL}`);
  ok('起跳下标不越界（只用列表内的地址）',
    [...used3.keys()].every((u) => urls3.includes(u)), [...used3.keys()].join(', '));
}

console.log('\n[8] ★ readBody 不得在 signal 上堆积 abort 监听');
{
  // 一个任务从头到尾共用同一个 signal，而 readBody 每个分片调一次。
  // 只挂不摘的话，几百个分片会在 signal 上堆几百个监听，每个都拽着一份
  // promise + reject 闭包 —— 直到 signal 被 GC 才释放（本轮 review 实测：
  // 20 次 readBody 留下 20 个监听）。
  const { getEventListeners } = await import('node:events');
  const ctrl = new AbortController();
  const before = getEventListeners(ctrl.signal, 'abort').length;
  for (let i = 0; i < 20; i++) {
    await readBody(streamResponse([new Uint8Array(4)]), { stallMs: 200, signal: ctrl.signal });
  }
  const after = getEventListeners(ctrl.signal, 'abort').length;
  ok('正常读完 20 次后不留监听', after === before, `before=${before} after=${after}`);

  // 中途放弃（停滞）同样要把监听摘掉 —— 这条路径走的是 catch 分支
  const hung = streamResponse([new Uint8Array(2)], { hangAfter: true });
  try { await readBody(hung, { stallMs: 40, signal: ctrl.signal }); } catch { /* 预期停滞 */ }
  const afterStall = getEventListeners(ctrl.signal, 'abort').length;
  ok('停滞放弃后也不留监听', afterStall === before, `after=${afterStall}`);

  // 取消路径也不能留
  const ctrl2 = new AbortController();
  const base2 = getEventListeners(ctrl2.signal, 'abort').length;
  const hang2 = streamResponse([], { hangAfter: true });
  const p = readBody(hang2, { stallMs: 5000, signal: ctrl2.signal }).catch(() => {});
  setTimeout(() => ctrl2.abort(), 20);
  await p;
  ok('取消路径也不留监听',
    getEventListeners(ctrl2.signal, 'abort').length === base2,
    `after=${getEventListeners(ctrl2.signal, 'abort').length}`);
}

setFetchImpl(null);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
