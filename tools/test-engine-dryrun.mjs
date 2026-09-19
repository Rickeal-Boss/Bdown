/**
 * 引擎干跑：不联网、不碰浏览器，把 engine.run 的 4 条分支各跑一遍。
 *
 * 存在的理由：validate.mjs 只做语法 + 顶层 import，抓不到函数体内的 ReferenceError。
 * v1.3.1 的 `vStage` 未定义就是这么混过 v1.3.1 与 v1.4.0 两个版本的。
 *
 * 夹具两条硬约束（改夹具时别踩）：
 *   1. size 必须 <= 256MB（sink.js:187 MEMORY_LIMIT）→ 走 MemorySink；
 *      否则撞 sink.js:138 的 navigator.storage.getDirectory() 报 navigator is not defined
 *   2. 假 fetch 必须返回 206 + `Content-Range: bytes s-e/total` + `Accept-Ranges: bytes`
 *      （downloader.js:64 探测 / :214 分片校验 / :144 缺 size 直接抛错）
 */
import { DownloadEngine } from '../src/core/engine.js';
import { setFetchImpl } from '../src/core/downloader.js';

if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:qa-stub';
  URL.revokeObjectURL = () => {};
}
globalThis.chrome = { downloads: { download: async (o) => ({ id: 1, filename: o.filename }) } };

/* 合成 fMP4 —— 抄自 tools/selftest-synthetic.mjs 的 buildFmp4，而不是 import 它：
 * 那个文件模块末尾会自动 main() 且内部 process.exit，直接 import 会把调用方进程劫持掉。 */
function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
function buildFmp4({ handler, sampleEntry, timescale, fragments, samplesPerFragment, sampleDuration, sampleSize, fill = 0 }) {
  const ftyp = box('ftyp', Buffer.from('iso5', 'latin1'), u32(0x200), Buffer.from('iso5iso6mp41dash', 'latin1'));
  const mvhd = box('mvhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100),
    Buffer.alloc(2), Buffer.alloc(8),
    Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]),
    Buffer.alloc(8), Buffer.alloc(24), u32(2));
  const tkhd = box('tkhd', Buffer.from([0, 0, 0, 7]), u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(8),
    u16(0), u16(0), u16(0), u16(0),
    Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]), u32(0), u32(0));
  const mdhd = box('mdhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', Buffer.from([0, 0, 0, 0]), u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('\0', 'latin1'));
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0]), u32(1), box(sampleEntry, Buffer.alloc(78)));
  const stts = box('stts', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsc = box('stsc', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsz = box('stsz', Buffer.from([0, 0, 0, 0]), u32(0), u32(0));
  const stco = box('stco', Buffer.from([0, 0, 0, 0]), u32(0));
  const dinf = box('dinf', box('dref', Buffer.from([0, 0, 0, 0]), u32(1), box('url ', Buffer.from([0, 0, 0, 1]))));
  const minf = box('minf',
    handler === 'vide' ? box('vmhd', Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)) : box('smhd', Buffer.from([0, 0, 0, 0]), Buffer.alloc(4)),
    dinf, box('stbl', stsd, stts, stsc, stsz, stco));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const trex = box('trex', Buffer.from([0, 0, 0, 0]), u32(1), u32(1), u32(sampleDuration), u32(0), u32(0x00010000));
  const mehd = box('mehd', Buffer.from([0, 0, 0, 0]), u32(0));
  const mvex = box('mvex', mehd, trex);
  const moov = box('moov', mvhd, mvex, trak);
  const chunks = [ftyp, moov];
  for (let i = 0; i < fragments; i++) {
    const sampleCount = samplesPerFragment;
    const trunParts = [Buffer.from([0, 0, 0x0a, 0x05]), u32(sampleCount), u32(0), u32(0x02000000)];
    for (let s = 0; s < sampleCount; s++) { trunParts.push(u32(sampleSize)); trunParts.push(u32(0)); }
    const mfhd = box('mfhd', Buffer.from([0, 0, 0, 0]), u32(i + 1));
    const tfhd = box('tfhd', Buffer.from([0x00, 0x02, 0x00, 0x00]), u32(1));
    const tfdt = box('tfdt', Buffer.from([0, 0, 0, 0]), u32(i * sampleCount * sampleDuration));
    chunks.push(box('moof', mfhd, box('traf', tfhd, tfdt, box('trun', ...trunParts))));
    chunks.push(box('mdat', Buffer.alloc(sampleCount * sampleSize, fill + i)));
  }
  return Buffer.concat(chunks);
}

const VIDEOB = buildFmp4({ handler: 'vide', sampleEntry: 'avc1', timescale: 16000, fragments: 2, samplesPerFragment: 3, sampleDuration: 640, sampleSize: 512, fill: 0x10 });
const AUDIOB = buildFmp4({ handler: 'soun', sampleEntry: 'mp4a', timescale: 48000, fragments: 2, samplesPerFragment: 3, sampleDuration: 1024, sampleSize: 128, fill: 0x80 });

setFetchImpl(async (url, init) => {
  const r = (init && (init.headers.Range || init.headers.range)) || '';
  const m = String(r).match(/bytes=(\d+)-(\d+)/);
  const src = /\/v\//.test(String(url)) ? VIDEOB : AUDIOB;
  const total = src.length;
  if (!m) return new Response(src.slice(0, 1), {
    status: 206, headers: { 'Content-Range': `bytes 0-0/${total}`, 'Accept-Ranges': 'bytes' },
  });
  const s = Number(m[1]);
  const e = Math.min(Number(m[2]), total - 1);
  return new Response(src.slice(s, e + 1), {
    status: 206, headers: { 'Content-Range': `bytes ${s}-${e}/${total}`, 'Accept-Ranges': 'bytes' },
  });
});

const BASE = {
  defaultQuality: 0, concurrency: 2, audioPreference: 'best', preferCodec: 'avc',
  saveMode: 'downloads', maxParallelTasks: 1, saveDanmaku: false, saveSubtitle: false,
  saveCover: false, resumeEnabled: false, singleNameTemplate: '{title}', batchNameTemplate: '{title}_P{n}',
};

const DASH = {
  mode: 'dash', quality: 80, acceptQuality: [80, 64], duration: 10,
  videos: [{ quality: 80, codec: 'AVC', codecid: 7, bandwidth: 1000, size: VIDEOB.length, url: 'https://cdn/v/1.m4s', backupUrls: [] }],
  audios: [{ id: 30280, type: 'audio', quality: 30280, bandwidth: 100, size: AUDIOB.length, url: 'https://cdn/a/1.m4s', backupUrls: [] }],
  durl: [], raw: {},
};
const DURLI = {
  mode: 'durl', quality: 80, acceptQuality: [80], duration: 10, videos: [], audios: [],
  durl: [{ url: 'https://cdn/v/full.mp4', backupUrls: [], size: VIDEOB.length, length: 10000 }], raw: {},
};

let CURRENT = 'merge';
const api = {
  videoInfo: async () => ({
    bvid: 'BV1xx411c7mD', aid: 2, cid: 62131, title: '干跑', pic: '',
    pages: [{ page: 1, cid: 62131, part: 'P1', duration: 10 }],
    owner: { name: 'up', mid: 1 }, duration: 10, pubdate: 1,
  }),
  playurl: async () => (CURRENT === 'durl' ? DURLI : DASH),
  danmakuXml: async () => '<i></i>',
  playerV2: async () => ({ subtitle: { subtitles: [] } }),
};

const EXPECT = { merge: 1, audio: 1, separate: 2, durl: 1 };
let pass = 0;
let fail = 0;
const lines = [];
for (const mode of Object.keys(EXPECT)) {
  CURRENT = mode;
  try {
    const engine = new DownloadEngine({ api, settings: { ...BASE, downloadMode: mode }, onUpdate: () => {} });
    const task = engine.addTask({ bvid: 'BV1xx411c7mD', cid: 62131, pageIndex: 0 }, { title: `dry-${mode}` });
    await engine.run(task, { kind: 'downloads' });
    const succeeded = task.status === 'done' && task.outputs.length === EXPECT[mode];
    if (succeeded) pass += 1; else fail += 1;
    lines.push(`${succeeded ? 'PASS' : 'FAIL'} ${mode.padEnd(9)} status=${task.status} outputs=${task.outputs.length} expect=${EXPECT[mode]}${task.error ? ' err=' + task.error : ''}`);
  } catch (e) {
    fail += 1;
    lines.push(`THROW ${mode.padEnd(9)} ${(e && (e.stack || e.message)) || e}`);
  }
}

// 元断言：4 条分支必须全部执行到。防止将来有人改循环导致某分支被跳过却仍报「全绿」
// —— 与 test-api-validation.mjs 的 `if (apiSet)` 条件断言是同一个教训。
const executed = pass + fail;
const complete = executed === Object.keys(EXPECT).length;
if (!complete) fail += 1;
lines.push(`---- pass=${pass} fail=${fail} executed=${executed}/${Object.keys(EXPECT).length}` +
  (complete ? '' : ' [!] 分支未全部执行，已按失败处理'));

console.log('\n' + lines.join('\n') + '\n');
// 退出码必须反映 fail：恒 0 会让 CI 永远绿，正是本项目踩过的病
process.exit(fail ? 1 : 0);
