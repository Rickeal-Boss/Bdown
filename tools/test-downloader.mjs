/**
 * 下载器不变量自检（不联网）。
 *
 * 锁住几条"改坏了要等真机才暴露"的语义：
 *   1. 用户取消必须**贯穿整条请求**（含已拿到响应头、正在读 body 的阶段）
 *   2. 不该重试的错误（取消 / 服务器不支持 Range）不得重试
 *   3. `retry` 的 `times` 为 NaN 时至少执行一次（不能静默 no-op 并 throw undefined）
 *   4. 服务器忽略 Range 返回 200 全量时，必须抛错且**不重复全量下载**
 *
 * 运行：node tools/test-downloader.mjs
 */
import { downloadRanged, setFetchImpl, DownloadAborted } from '../src/core/downloader.js';
import { retry } from '../src/core/util.js';
import { MemorySink } from '../src/core/sink.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const TOTAL = 2048;
/** 造一个"响应头已到、body 读取挂起"的响应，且能响应 signal。 */
function hangingBodyResponse(signal) {
  return {
    status: 206,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-range' ? `bytes 0-1023/${TOTAL}` : null) },
    arrayBuffer: () => new Promise((_resolve, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      signal?.addEventListener?.('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
  };
}

console.log('\n[1] ★ 用户取消必须能中断"正在读取 body"的请求');
{
  let seenSignal = null;
  setFetchImpl(async (url, init) => {
    seenSignal = init?.signal;
    return hangingBodyResponse(init?.signal);
  });

  const ctrl = new AbortController();
  const sink = new MemorySink();
  const t0 = Date.now();
  let err = null;
  const p = downloadRanged({
    urls: ['https://cdn/a.m4s'], size: TOTAL, sink,
    concurrency: 1, probe: false, retries: 0, signal: ctrl.signal,
  }).catch((e) => { err = e; });

  setTimeout(() => ctrl.abort(), 60);
  await p;
  const dt = Date.now() - t0;

  ok('取消后请求被中断（未永久挂起）', err !== null, '未抛错，说明 body 读取阶段没被取消');
  ok(`中断及时（实测 ${dt}ms，应 < 2000ms）`, dt < 2000, `${dt}ms`);
  ok('传给 fetch 的 signal 与"用户取消"联动', seenSignal != null, 'signal 为 null');
  ok('外部 signal 被合并进 fetch（不是只用自己的 controller）',
    seenSignal === ctrl.signal || seenSignal?.aborted === true,
    'signal 与外部取消无关 → 读 body 阶段无法被取消');
}

console.log('\n[2] ★ 不该重试的错误不得重试');
{
  // rangeIgnored：只应尝试一次
  let calls = 0;
  setFetchImpl(async () => {
    calls += 1;
    return { status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(TOTAL * 3).buffer };
  });
  const sink = new MemorySink();
  let err = null;
  try {
    await downloadRanged({
      urls: ['https://cdn/a.m4s'], size: TOTAL, sink,
      concurrency: 1, probe: false, retries: 3,
    });
  } catch (e) { err = e; }
  ok('服务器忽略 Range 时抛错', !!err, '未抛错');
  ok('带 rangeIgnored 标记', err?.rangeIgnored === true, JSON.stringify(err?.message));
  // 若会重试，retries=3 时每个地址尝试 4 次 → 至少 4 次全量下载
  ok(`只下载了一次全量（实测 fetch 调用 ${calls} 次，不应 > 2）`, calls <= 2,
    `调用了 ${calls} 次 —— rangeIgnored 仍在重试，会把整个文件重复下载多遍`);

  // DownloadAborted：不应重试
  let abortCalls = 0;
  setFetchImpl(async () => { abortCalls += 1; throw new DownloadAborted(); });
  const sink2 = new MemorySink();
  let err2 = null;
  const t1 = Date.now();
  try {
    await downloadRanged({
      urls: ['https://cdn/a.m4s'], size: TOTAL, sink: sink2,
      concurrency: 1, probe: false, retries: 5,
    });
  } catch (e) { err2 = e; }
  const dt2 = Date.now() - t1;
  ok('取消错误不被重试（只调用 1 次）', abortCalls === 1, `调用了 ${abortCalls} 次`);
  ok(`取消响应及时（实测 ${dt2}ms，retries=5 时重试会拖到数秒）`, dt2 < 1500, `${dt2}ms`);
  ok('抛出的是 DownloadAborted', err2 instanceof DownloadAborted, String(err2));
}

console.log('\n[3] retry 的健壮性');
{
  let n = 0;
  await retry(() => { n += 1; throw new Error('x'); }, { times: 3, baseDelay: 1 }).catch(() => {});
  ok('正常重试次数（times=3 → 调用 3 次）', n === 3, `调用 ${n} 次`);

  // NaN 必须至少执行一次，且不能 throw undefined
  let m = 0;
  let e = null;
  try {
    await retry(() => { m += 1; throw new Error('boom'); }, { times: NaN });
  } catch (err) { e = err; }
  ok('times=NaN 时仍执行一次（不静默 no-op）', m === 1, `执行 ${m} 次`);
  ok('times=NaN 时抛出真实错误而非 undefined', e instanceof Error && e.message === 'boom', String(e));

  // shouldRetry=false → 不重试
  let k = 0;
  try {
    await retry(() => { k += 1; throw new Error('no-retry'); }, {
      times: 5, baseDelay: 1, shouldRetry: () => false,
    });
  } catch { /* expected */ }
  ok('shouldRetry 返回 false 时只尝试 1 次', k === 1, `尝试 ${k} 次`);
}

console.log('\n[4] 正常下载仍然工作（回归）');
{
  setFetchImpl(async (url, init) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range || '');
    const s = Number(m[1]), e = Number(m[2]);
    return {
      status: 206,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-range' ? `bytes ${s}-${e}/${TOTAL}` : null) },
      arrayBuffer: async () => new Uint8Array(e - s + 1).buffer,
    };
  });
  const sink = new MemorySink();
  const reports = [];
  await downloadRanged({
    urls: ['https://cdn/a.m4s'], size: TOTAL, sink,
    concurrency: 2, probe: false, retries: 0,
    onProgress: (p) => reports.push(p),
  });
  ok('下载完成且大小正确', sink.size === TOTAL, `sink.size=${sink.size}`);
  ok('进度上报到 100%', reports[reports.length - 1]?.ratio === 1, JSON.stringify(reports[reports.length - 1]?.ratio));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 下载器不变量自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
