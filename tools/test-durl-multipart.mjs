/**
 * durl 多段下载的回归测试（不联网，桩件）。
 *
 * 背景：durl（单文件直下）可能是**多段**的（长视频 / 番剧分段）。
 * 修复前 `engine.js` 只下载 `plan.durl[0]`：
 *   - `refinePlanSizes` 明明探测了所有分段
 *   - `buildPlan` 也返回了完整的 durl 列表
 *   - 但下载只取第一段
 * 结果就是**只有第一段的截断文件**，而且进度永远到不了 100%
 * （`totalBytes` 也只按第一段算）。
 *
 * 修复：下载全部分段 + 给分片写入加 `writeOffset`（否则第二段会从 0 覆盖第一段）。
 *
 * 运行：node tools/test-durl-multipart.mjs
 */
import { DownloadEngine } from '../src/core/engine.js';
import { setFetchImpl } from '../src/core/downloader.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

// 两段内容不同，才能验证「拼接」而不是「互相覆盖」
const SEG1 = new Uint8Array([1, 1, 1, 1]);
const SEG2 = new Uint8Array([2, 2, 2, 2, 2, 2]);

let captured = null;
globalThis.URL.createObjectURL = (blob) => { captured = blob; return 'blob:test'; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.chrome = {
  downloads: { download: async (opts) => ({ id: 1, filename: opts?.filename || '' }) },
  storage: { local: { get: async () => ({}), set: async () => ({}), remove: async () => ({}) } },
  runtime: { id: 'bdown-test', getURL: (p) => `chrome-extension://bdown-test/${p}` },
};

setFetchImpl(async (url, init) => {
  const body = String(url).includes('seg1') ? SEG1 : SEG2;
  const range = String(init?.headers?.Range || init?.headers?.range || '');
  const m = range.match(/bytes=(\d+)-(\d+)/);
  if (m) {
    const s = Number(m[1]);
    const e = Math.min(Number(m[2]), body.length - 1);
    return new Response(body.slice(s, e + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${s}-${e}/${body.length}`, 'Accept-Ranges': 'bytes' },
    });
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' },
  });
});

const api = {
  ensureAccount: async () => ({ isLogin: true, vip: false, uname: 't', mid: 1, checkedAt: Date.now() }),
  videoInfo: async () => ({
    bvid: 'BV1xx411c7mD', aid: 1, cid: 1, title: '多段测试',
    pages: [{ page: 1, part: '', cid: 1, duration: 10 }],
    owner: { name: 'u', mid: 1 }, pubdate: 0, duration: 10,
  }),
  playurl: async () => ({
    mode: 'durl',
    quality: 80,
    videos: [],
    audios: [],
    durl: [
      { url: 'https://cdn/seg1.mp4', backupUrls: [], size: SEG1.length, length: 1000 },
      { url: 'https://cdn/seg2.mp4', backupUrls: [], size: SEG2.length, length: 1000 },
    ],
  }),
};

console.log('\n[1] durl 多段必须全部下载并按顺序拼接');
{
  captured = null;
  const engine = new DownloadEngine({
    api,
    settings: { ...DEFAULT_SETTINGS, downloadMode: 'durl', concurrency: 1, saveNfo: false },
    onUpdate: () => {},
  });
  const task = engine.addTask(
    { bvid: 'BV1xx411c7mD', cid: 1, pageIndex: 0, quality: 0, title: '多段测试' },
    { title: '多段测试' },
  );

  let err = null;
  try {
    await engine.run(task, { kind: 'downloads' });
  } catch (e) { err = e; }

  ok('任务成功结束', err === null && task.status === 'done',
    `status=${task.status} err=${err && err.message}`);
  ok('totalBytes = 两段之和（不是只算第一段）',
    task.totalBytes === SEG1.length + SEG2.length, `实际 ${task.totalBytes}`);
  ok('产物被写出', captured !== null);

  if (captured) {
    const out = new Uint8Array(await captured.arrayBuffer());
    const expected = new Uint8Array(SEG1.length + SEG2.length);
    expected.set(SEG1, 0);
    expected.set(SEG2, SEG1.length);
    ok('产物长度 = 两段之和', out.length === expected.length, `实际 ${out.length}`);
    const same = out.length === expected.length && out.every((b, i) => b === expected[i]);
    ok('★ 产物内容 = 第一段 ++ 第二段（第二段没有覆盖第一段）',
      same, `实际 ${Array.from(out).join(',')}`);
  }
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} durl 多段回归${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
