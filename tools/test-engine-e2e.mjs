/**
 * 引擎端到端测试：用桩件把 DownloadEngine.run 的四条分支**真的跑到 done**。
 *
 * 与 tools/test-engine-dryrun.mjs 的区别（两者互补，不是重复）：
 *   dryrun 用全 0 的假分片，merge 分支在 mp4.js 解析阶段必然失败，所以它只断言
 *   「不是 is not defined」——能防住 vStage 那类回归，但**证明不了 merge 真的能成**。
 *   本文件给 merge 分支喂**结构合法的合成 fMP4**（ftyp + moov + moof/mdat，
 *   tfhd 带 default-base-is-moof，与 B 站真实 m4s 同构），因此四条分支都能真正
 *   走到 done，并且额外校验合并产物的盒子结构（2 条轨道）。
 *
 * 为什么需要它：engine.js 的 merge 分支曾在 prepareStage 重构（vStage→vPrep）
 * 时漏改两行，`node --check` 语法完全合法、CI 全绿，但 ESM 严格模式下运行时
 * ReferenceError，默认 merge 模式 100% 失败，溜过了 v1.3.1 与 v1.4.0。
 *
 * 注意：脚本末尾必须 process.exit()。engine.js 的 exportFile 会为 blob URL 注册
 * 一个 24 小时的 revokeObjectURL 定时器，不显式退出 Node 事件循环不会结束。
 *
 * 运行：node tools/test-engine-e2e.mjs
 * 退出码：0 = 通过；1 = 有失败
 */

import { DownloadEngine } from '../src/core/engine.js';
import { setFetchImpl } from '../src/core/downloader.js';
import { inspectMp4 } from '../src/core/mp4.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';

/* ------------------------------------------------------------------ *
 * 1. 合成 fMP4 夹具
 *
 * 与 tools/selftest-synthetic.mjs 的 buildFmp4 同构：B 站真实 m4s 的
 * tfhd 带 default-base-is-moof(0x020000)，样本时长放在 trex 里。
 * 这里复制一份而不是 import，因为 selftest-synthetic 在模块顶层就跑了 main()。
 * ------------------------------------------------------------------ */

function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
};

function buildFmp4({
  handler, sampleEntry, timescale, fragments, samplesPerFragment,
  sampleDuration, sampleSize, fill = 0,
}) {
  const ftyp = box('ftyp', Buffer.from('iso5', 'latin1'), u32(0x200), Buffer.from('iso5iso6mp41dash', 'latin1'));

  const mvhd = box(
    'mvhd',
    Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(1000), u32(0),
    u32(0x00010000), u16(0x0100), Buffer.alloc(2), Buffer.alloc(8),
    Buffer.from([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00,
    ]),
    Buffer.alloc(8), Buffer.alloc(24), u32(2),
  );

  const tkhd = box(
    'tkhd',
    Buffer.from([0, 0, 0, 7]), u32(0), u32(0), u32(1), u32(0), u32(0),
    Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0),
    Buffer.from([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00,
    ]),
    u32(0), u32(0),
  );

  const mdhd = box('mdhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', Buffer.from([0, 0, 0, 0]), u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('\0', 'latin1'));
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0]), u32(1), box(sampleEntry, Buffer.alloc(78)));
  const stts = box('stts', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsc = box('stsc', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsz = box('stsz', Buffer.from([0, 0, 0, 0]), u32(0), u32(0));
  const stco = box('stco', Buffer.from([0, 0, 0, 0]), u32(0));
  const dinf = box('dinf', box('dref', Buffer.from([0, 0, 0, 0]), u32(1), box('url ', Buffer.from([0, 0, 0, 1]))));
  const minf = box(
    'minf',
    handler === 'vide' ? box('vmhd', Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)) : box('smhd', Buffer.from([0, 0, 0, 0]), Buffer.alloc(4)),
    dinf,
    box('stbl', stsd, stts, stsc, stsz, stco),
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));

  const trex = box('trex', Buffer.from([0, 0, 0, 0]), u32(1), u32(1), u32(sampleDuration), u32(0), u32(0x00010000));
  const mehd = box('mehd', Buffer.from([0, 0, 0, 0]), u32(0));
  const mvex = box('mvex', mehd, trex);
  const moov = box('moov', mvhd, mvex, trak);

  const chunks = [ftyp, moov];
  for (let i = 0; i < fragments; i += 1) {
    const sampleCount = samplesPerFragment;
    const trunSize = 20 + 8 * sampleCount;
    const moofSize = 16 + 16 + 16 + trunSize;
    const dataOffset = moofSize + 8;

    const mfhd = box('mfhd', Buffer.from([0, 0, 0, 0]), u32(i + 1));
    const tfhd = box('tfhd', Buffer.from([0x00, 0x02, 0x00, 0x00]), u32(1));
    const tfdt = box('tfdt', Buffer.from([0, 0, 0, 0]), u32(i * sampleCount * sampleDuration));

    const trunParts = [
      Buffer.from([0, 0, 0x0a, 0x05]),
      u32(sampleCount),
      u32(dataOffset),
      u32(0x02000000),
    ];
    for (let s = 0; s < sampleCount; s += 1) {
      trunParts.push(u32(sampleSize));
      trunParts.push(u32(0));
    }
    const trun = box('trun', ...trunParts);
    const traf = box('traf', tfhd, tfdt, trun);
    const moof = box('moof', mfhd, traf);
    const mdat = box('mdat', Buffer.alloc(sampleCount * sampleSize, fill + i));
    chunks.push(moof, mdat);
  }
  return Buffer.concat(chunks);
}

const VIDEO = buildFmp4({
  handler: 'vide', sampleEntry: 'avc1', timescale: 16000,
  fragments: 3, samplesPerFragment: 4, sampleDuration: 640, sampleSize: 1024, fill: 0x10,
});
const AUDIO = buildFmp4({
  handler: 'soun', sampleEntry: 'mp4a', timescale: 48000,
  fragments: 2, samplesPerFragment: 5, sampleDuration: 1024, sampleSize: 256, fill: 0x80,
});

const VIDEO_URL = 'https://cdn.example/v.m4s';
const AUDIO_URL = 'https://cdn.example/a.m4s';
const DURL_URL = 'https://cdn.example/whole.mp4';

const bytesFor = (url) => {
  const u = String(url);
  if (u.includes('/v.m4s')) return VIDEO;
  if (u.includes('/a.m4s')) return AUDIO;
  return VIDEO;
};

/* ------------------------------------------------------------------ *
 * 2. 桩件：假 CDN
 * ------------------------------------------------------------------ */

setFetchImpl(async (url, init) => {
  const buf = bytesFor(url);
  const range = String(init?.headers?.Range || '');

  // 探测：Range: bytes=0-0
  if (range === 'bytes=0-0') {
    return new Response(buf.subarray(0, 1), {
      status: 206,
      headers: {
        'Content-Range': `bytes 0-0/${buf.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
      },
    });
  }

  // 分片：Range: bytes=start-end
  const m = range.match(/bytes=(\d+)-(\d+)/);
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    return new Response(buf.subarray(start, Math.min(end + 1, buf.length)), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${buf.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
      },
    });
  }

  // 整体 GET（顺序下载回退路径）
  return new Response(buf, {
    status: 200,
    headers: { 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' },
  });
});

/* ------------------------------------------------------------------ *
 * 3. 桩件：B 站 API
 * ------------------------------------------------------------------ */

let currentMode = 'merge';

const track = (id, url, size, extra = {}) => ({
  id,
  quality: id,
  codecid: 7,
  codec: 'AVC',
  codecs: 'avc1.64001f',
  width: 1920,
  height: 1080,
  frameRate: '30',
  bandwidth: 1_000_000,
  size,
  url,
  backupUrls: [],
  mimeType: 'video/mp4',
  ...extra,
});

const api = {
  videoInfo: async () => ({
    bvid: 'BV1xx411c7mD',
    aid: 2,
    cid: 62131,
    title: '端到端测试视频',
    pic: 'https://cdn.example/cover.jpg',
    owner: { name: 'UP', mid: 42 },
    duration: 30,
    pubdate: 1_700_000_000,
    pages: [{ page: 1, part: 'P1', cid: 62131, duration: 30 }],
  }),
  playurl: async () => {
    if (currentMode === 'durl') {
      return {
        mode: 'durl',
        quality: 80,
        acceptQuality: [80, 64, 32],
        acceptDescription: [],
        supportFormats: [],
        duration: 30,
        videos: [],
        audios: [],
        durl: [{ url: DURL_URL, size: VIDEO.length, length: 30, backupUrls: [] }],
        language: [],
      };
    }
    return {
      mode: 'dash',
      quality: 80,
      acceptQuality: [80, 64, 32],
      acceptDescription: [],
      supportFormats: [],
      duration: 30,
      videos: [track(80, VIDEO_URL, VIDEO.length)],
      audios: [{ ...track(30280, AUDIO_URL, AUDIO.length), id: 30280, type: 'audio', label: '192K' }],
      durl: [],
      language: [],
    };
  },
};

/* ------------------------------------------------------------------ *
 * 4. 桩件：chrome / URL
 * ------------------------------------------------------------------ */

/** 捕获真正写出去的 Blob，用于校验合并产物结构。 */
const produced = [];
globalThis.chrome = {
  downloads: {
    download: async (opts) => ({ id: produced.length + 1, filename: opts?.filename || '' }),
  },
  runtime: { id: 'bdown-e2e', getURL: (p) => `chrome-extension://bdown-e2e/${p}` },
  storage: { local: { get: async () => ({}), set: async () => ({}), remove: async () => ({}) } },
};
globalThis.URL.createObjectURL = (blob) => {
  produced.push(blob);
  return `blob:bdown-e2e-${produced.length}`;
};
globalThis.URL.revokeObjectURL = () => {};

/* ------------------------------------------------------------------ *
 * 5. 用例
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${msg ? ` — ${msg}` : ''}`);
  }
};

const EXPECT_OUTPUTS = { merge: 1, separate: 2, audio: 1, durl: 1 };

function makeEngine(mode) {
  return new DownloadEngine({
    api,
    settings: {
      ...DEFAULT_SETTINGS,
      downloadMode: mode,
      concurrency: 2,
      resumeEnabled: false,
      saveDanmaku: false,
      saveSubtitle: false,
      saveCover: false,
    },
    onUpdate: () => {},
  });
}

async function runCase(mode) {
  currentMode = mode;
  produced.length = 0;

  const engine = makeEngine(mode);
  const task = engine.addTask(
    { bvid: 'BV1xx411c7mD', cid: 62131, pageIndex: 0, quality: 0, title: '端到端测试视频' },
    { title: '端到端测试视频' },
  );
  await engine.run(task, { kind: 'downloads' });

  // 核心断言：必须真的成功结束
  ok(`${mode}：任务状态 = done`, task.status === 'done', `实际 status=${task.status} error=${task.error}`);
  // 核心断言：失败原因里不能出现「读取未声明变量」（vStage 那类回归的特征串）
  ok(`${mode}：错误里没有 "is not defined"`, !/is not defined/.test(String(task.error || '')), String(task.error));
  ok(`${mode}：没有残留错误文本`, !task.error, String(task.error));
  // 产物数量
  ok(
    `${mode}：产物数 = ${EXPECT_OUTPUTS[mode]}`,
    task.outputs.length === EXPECT_OUTPUTS[mode],
    `实际 ${task.outputs.length}：${JSON.stringify(task.outputs.map((o) => o.path))}`,
  );
  ok(`${mode}：确实调用了 chrome.downloads.download`, produced.length === EXPECT_OUTPUTS[mode], `实际 ${produced.length}`);
  return { task, blobs: [...produced] };
}

async function main() {
  console.log('\n[1] 四条下载分支端到端');
  const results = {};
  for (const mode of ['merge', 'separate', 'audio', 'durl']) {
    results[mode] = await runCase(mode);
  }

  console.log('\n[2] merge 产物必须是可解析的双轨 MP4');
  const merged = results.merge.blobs[0];
  if (merged) {
    const bytes = new Uint8Array(await merged.arrayBuffer());
    const info = inspectMp4(bytes);
    ok('merge：有 ftyp', info.hasFtyp);
    ok('merge：有 moov', info.hasMoov);
    ok('merge：2 条轨道', info.tracks.length === 2, JSON.stringify(info.tracks.map((t) => t.handler)));
    ok(
      'merge：轨道 handler = vide + soun',
      info.tracks.map((t) => t.handler).sort().join(',') === 'soun,vide',
      JSON.stringify(info.tracks.map((t) => t.handler)),
    );
    ok('merge：片段数 = 3(视频) + 2(音频) = 5', info.fragments === 5, `实际 ${info.fragments}`);
    ok('merge：产物字节数 > 0', info.bytes > 0, `实际 ${info.bytes}`);
  } else {
    ok('merge：拿到产物 Blob', false, '没有捕获到 Blob');
  }

  console.log('\n[3] separate 产物：视频轨与音轨各自独立');
  const sep = results.separate.blobs;
  if (sep.length === 2) {
    const vBytes = new Uint8Array(await sep[0].arrayBuffer());
    const aBytes = new Uint8Array(await sep[1].arrayBuffer());
    ok('separate：两路产物都非空', vBytes.length > 0 && aBytes.length > 0, `${vBytes.length} / ${aBytes.length}`);
    ok('separate：视频产物 = 视频轨字节数', vBytes.length === VIDEO.length, `${vBytes.length} vs ${VIDEO.length}`);
    ok('separate：音频产物 = 音轨字节数', aBytes.length === AUDIO.length, `${aBytes.length} vs ${AUDIO.length}`);
  } else {
    ok('separate：拿到 2 个产物 Blob', false, `实际 ${sep.length}`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} 引擎端到端测试完成，失败 ${fail} 项（通过 ${pass}）\n`);
  // 必须显式退出：exportFile 注册了 24h 的 revokeObjectURL 定时器
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
