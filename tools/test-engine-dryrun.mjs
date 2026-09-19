/**
 * 引擎干跑测试：用桩件跑通 DownloadEngine.run 的四条分支，
 * 断言任务以 done 结束、产物数量正确，且异常信息里没有 "is not defined"。
 *
 * 为什么需要它：tools/validate.mjs 只做 `node --check`（语法级），**抓不到读取未声明变量**。
 * 本项目真的踩过：engine.js 里 `vStage` / `aStage` 在 prepareStage 重构
 * （改名成 vPrep/aPrep）时漏改两行，ES Module 严格模式下运行时直接 ReferenceError，
 * 导致默认 merge 模式 100% 失败——而当时的 CI 全绿。
 *
 * 注意：脚本末尾必须 `process.exit()`，否则 engine.js 里 revokeObjectURL 的
 * 定时器会让 Node 事件循环不退出（浏览器里页面关闭时由浏览器统一回收，不是泄漏）。
 *
 * 运行：node tools/test-engine-dryrun.mjs
 */

import { DownloadEngine, Task } from '../src/core/engine.js';
import { setFetchImpl } from '../src/core/downloader.js';

/**
 * 假下载源：支持 Range（206）与整体 GET（200，供 probeSize 用 Content-Length）。
 * 内容填 0 —— merge 分支需要**能被 mp4.js 解析**的真实 m4s 才能走到 done，
 * 这里不追求 merge 成功，只保证：
 *   - 不因为「读取未声明变量」而崩（这是本测试的核心目标）
 *   - separate / audio / durl 三条**不需要混流**的分支必须真的 done
 */
const SEG_BYTES = 4096;
setFetchImpl(async (_url, init) => {
  const range = String(init?.headers?.Range || '');
  const m = range.match(/bytes=(\d+)-(\d+)/);
  if (m) {
    const st = Number(m[1]);
    const en = Number(m[2]);
    return new Response(new Uint8Array(en - st + 1), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${st}-${en}/${SEG_BYTES}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }
  return new Response(new Uint8Array(SEG_BYTES), {
    status: 200,
    headers: { 'Content-Length': String(SEG_BYTES), 'Accept-Ranges': 'bytes' },
  });
});

let CURRENT = 'merge';

const track = (n = 10) => ({
  id: n,
  quality: n,
  codec: 'AVC',
  codecid: 7,
  url: 'https://cdn.example/seg.m4s',
  baseUrl: 'https://cdn.example/seg.m4s',
  backupUrls: [],
  backup_url: [],
  bandwidth: 1000,
  size: 1024,
  width: 1920,
  height: 1080,
  frameRate: '30',
  frame_rate: '30',
});

/** 预期产物数：merge/audio/durl 各 1 个，separate 2 个 */
const EXPECT = { merge: 1, separate: 2, audio: 1, durl: 1 };

const api = {
  ensureAccount: async () => ({ isLogin: true, vip: false, uname: 'tester', mid: 1, checkedAt: Date.now() }),
  videoInfo: async () => ({
    bvid: 'BV1xx411c7mD',
    aid: 2,
    cid: 62131,
    title: '测试视频',
    pic: 'https://cdn.example/cover.jpg',
    owner: { name: 'UP', mid: 42 },
    duration: 30,
    pubdate: 1,
    pages: [{ page: 1, part: 'P1', cid: 62131, duration: 30 }],
  }),
  playurl: async () => {
    // durl 分支要求 playInfo.mode === 'durl' 且 durl 非空，否则会落到 merge
    if (CURRENT === 'durl') {
      return {
        mode: 'durl',
        quality: 80,
        codec: 'AVC',
        videos: [],
        audios: [],
        durl: [{ url: 'https://cdn.example/whole.mp4', backupUrls: [], size: 2048 }],
        acceptQuality: [80, 64, 32, 16],
        supportFormats: [],
      };
    }
    return {
      mode: 'dash',
      quality: 80,
      codec: 'AVC',
      videos: [track(80)],
      audios: [{ ...track(30280), id: 30280 }],
      durl: [],
      acceptQuality: [80, 64, 32, 16],
      supportFormats: [],
    };
  },
  playerV2: async () => ({ subtitle: { subtitles: [] } }),
  danmakuXml: async () => '<i><chatserver></chatserver></i>',
  fetchText: async () => '',
};

/** 兜底：任何未桩到的方法都返回空，保证测的是"引擎逻辑"而不是桩件是否齐全 */
const apiProxy = new Proxy(api, {
  get(t, k) {
    if (k in t) return t[k];
    return async () => ({});
  },
});

let downloads = 0;
globalThis.chrome = {
  downloads: {
    download: async (opts) => {
      downloads += 1;
      return { id: downloads, filename: opts?.filename || '' };
    },
  },
  runtime: { id: 'bdown-test', getURL: (p) => `chrome-extension://bdown-test/${p}` },
  storage: { local: { get: async () => ({}), set: async () => ({}), remove: async () => ({}) } },
};
globalThis.URL.createObjectURL = () => 'blob:bdown-test-objecturl';
globalThis.URL.revokeObjectURL = () => {};

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name} — ${msg}`);
  }
};

async function runCase(mode) {
  CURRENT = mode;
  downloads = 0;
  const engine = new DownloadEngine({
    api: apiProxy,
    settings: {
      downloadMode: mode,
      concurrency: 1,
      maxParallelTasks: 1,
      audioPreference: 'best',
      preferCodec: 'avc',
      saveMode: 'downloads',
      resumeEnabled: false,
      nameWithQuality: false,
      singleNameTemplate: '{title}',
      batchNameTemplate: '{title}_P{n}_{part}',
      qualitySuffix: '_{qualityShort}',
      saveDanmaku: false,
      saveSubtitle: false,
      saveCover: false,
    },
    onUpdate: () => {},
  });
  const task = new Task({ bvid: 'BV1xx411c7mD', aid: 2, cid: 62131, pageIndex: 0, title: '测试视频' }, {});
  let error = null;
  try {
    await engine.run(task, { kind: 'downloads' });
  } catch (e) {
    error = e;
  }
  const errMsg = String(error?.message || task?.error || task?.errorMessage || '');
  if (process.env.BDOWN_DEBUG) console.log('   DEBUG', mode, 'status=', task.status, 'err=', JSON.stringify(errMsg), 'outputs=', task.outputs?.length);
  // 核心断言：绝不能因为「读取未声明变量」而崩。vStage / aStage 漏改就栽在这。
  ok(`[${mode}] 没有 "is not defined"（未声明变量）`, !/is not defined/.test(errMsg), errMsg);
  ok(`[${mode}] 没有 "Cannot read properties"（空值解引用）`,
    !/Cannot read propert/.test(errMsg), errMsg);
  if (mode === 'merge') {
    // merge 需要真实 m4s 才能 done（此处喂的是 0 字节，必然卡在混流），
    // 但**必须已经走到混流阶段**——vStage 是在调用 mergeInto 求值时就抛的，
    // 若它漏改，任务会停在 downloading 且带 "vStage is not defined"。
    const reachedMux = ['muxing', 'saving', 'done'].includes(task.status);
    ok('[merge] 已进入混流阶段（说明 vPrep/aPrep 传参正确）',
      reachedMux || /mux|混流|moov|trak|dash/i.test(errMsg),
      `status=${task.status} err=${errMsg}`);
  } else {
    ok(`[${mode}] 任务以 done 结束`, task.status === 'done', `status=${task.status} err=${errMsg}`);
    ok(
      `[${mode}] 产物数量正确（期望 ${EXPECT[mode]}）`,
      (task.outputs?.length || 0) === EXPECT[mode],
      `outputs=${JSON.stringify(task.outputs?.map((o) => o?.name || o))}`,
    );
  }
}

console.log('\n[1] 四条下载分支干跑');
for (const mode of ['merge', 'separate', 'audio', 'durl']) {
  await runCase(mode);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 引擎干跑测试${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
