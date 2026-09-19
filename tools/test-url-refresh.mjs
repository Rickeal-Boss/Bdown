/**
 * 播放地址过期（HTTP 403/404）自动刷新的自检（不联网）。
 *
 * 背景：B 站 CDN 的播放地址约 **120 分钟**失效，失效后返回 403（也可能 404）。
 * 原实现拿到 403 后只是用**同一个过期地址**重试 2 次再回退顺序下载——必然全败。
 * 现已支持：检测到 403/404 时调用 refreshUrls 重新 playurl 换一批地址再试。
 *
 * 运行：node tools/test-url-refresh.mjs
 */
import { DownloadEngine, isUrlExpiredError } from '../src/core/engine.js';
import { setFetchImpl, downloadRanged } from '../src/core/downloader.js';
import { MemorySink } from '../src/core/sink.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

console.log('\n[1] isUrlExpiredError 判定');
{
  ok('403 视为过期', isUrlExpiredError({ status: 403 }) === true);
  ok('404 视为过期', isUrlExpiredError({ status: 404 }) === true);
  ok('410 视为过期', isUrlExpiredError({ status: 410 }) === true);
  ok('500 不算过期（是服务端错误，刷新地址没用）', isUrlExpiredError({ status: 500 }) === false);
  ok('网络错误（无 status）不算过期', isUrlExpiredError(new Error('boom')) === false);
  ok('undefined 不崩', isUrlExpiredError(undefined) === false);
}

console.log('\n[2] ★ 核心：403 时刷新地址并重试成功');
{
  const EXPIRED = 'https://cdn/expired.m4s';
  const FRESH = 'https://cdn/fresh.m4s';
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(String(url));
    if (String(url).includes('expired')) {
      return new Response('', { status: 403 });   // 模拟过期
    }
    const body = new Uint8Array(2048);
    const range = /bytes=(\d+)-(\d+)/.exec(String(url).split(',')[0] || '');
    return new Response(body, {
      status: 206,
      headers: { 'Content-Range': `bytes 0-2047/2048`, 'Accept-Ranges': 'bytes' },
    });
  });

  let refreshCalls = 0;
  const engine = new DownloadEngine({ api: {}, settings: {}, onUpdate: () => {} });
  const sink = new MemorySink();
  const res = await engine.fetchTo({
    urls: [EXPIRED],
    size: 2048,
    sink,
    refreshUrls: async () => {
      refreshCalls += 1;
      return [FRESH];
    },
  });
  ok('refreshUrls 被调用了 1 次', refreshCalls === 1, `实际 ${refreshCalls} 次`);
  ok('最终下载成功（返回了 bytes）', res && typeof res.bytes === 'number' && res.bytes > 0, JSON.stringify(res));
  ok('确实用过新地址重试', seen.some((u) => u.includes('fresh')), seen.join(' | '));
}

console.log('\n[3] 不提供 refreshUrls 时保持旧行为（不刷新）');
{
  setFetchImpl(async () => new Response('', { status: 403 }));
  const engine = new DownloadEngine({ api: {}, settings: {}, onUpdate: () => {} });
  let threw = false;
  try {
    await engine.fetchTo({ urls: ['https://cdn/expired.m4s'], size: 1024, sink: new MemorySink() });
  } catch { threw = true; }
  ok('仍然抛错（不会假装成功）', threw);
}

console.log('\n[4] 刷新后仍失败 → 不无限重试');
{
  setFetchImpl(async () => new Response('', { status: 403 }));
  let refreshCalls = 0;
  const engine = new DownloadEngine({ api: {}, settings: {}, onUpdate: () => {} });
  let threw = false;
  try {
    await engine.fetchTo({
      urls: ['https://cdn/expired.m4s'],
      size: 1024,
      sink: new MemorySink(),
      refreshUrls: async () => { refreshCalls += 1; return ['https://cdn/still-expired.m4s']; },
    });
  } catch { threw = true; }
  ok('最终抛错', threw);
  ok('refreshUrls 最多调用 1 次（不无限循环）', refreshCalls <= 1, `实际 ${refreshCalls} 次`);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} URL 过期刷新自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
