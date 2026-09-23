/**
 * 核心模块自检（纯 Node，不联网、不需要浏览器）。
 *
 * 覆盖 validate.mjs 检查不到的「行为正确性」：
 *   - escapeHtml      XSS 向量
 *   - formUrlEncode   与 Python urllib.parse.urlencode 等价（WBI 签名的前提）
 *   - md5             与 Node crypto 对拍（含分块边界长度）
 *   - avbv            AV/BV 往返一致性
 *   - sanitizeFilename 路径穿越 / Windows 保留名 / BiDi 欺骗字符
 *
 * 运行：node tools/selftest-core.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, sanitizeFilename } from '../src/core/util.js';
import { formUrlEncode, getMixinKey, signParams, resetMixinKey } from '../src/core/wbi.js';
import { md5 } from '../src/core/md5.js';
import { av2bv, bv2av, isBvid } from '../src/core/avbv.js';
import { buildPlan, audioOutputMeta, nextDownloadedBytes, resolveTaskSettings, resolveOutputPath, resolveProgressBase, DownloadEngine } from '../src/core/engine.js';
import { pickAudioTrack } from '../src/core/api.js';
import { savePickerHint, MODE_HINTS, AUDIO_UNAVAILABLE_HINT } from '../src/core/settings.js';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    const msg = fn();
    if (msg) throw new Error(msg);
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  \u2717 ${name} — ${err.message}`);
  }
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) return `${label} 期望 ${e}，实际 ${a}`;
  return '';
}

console.log('\n[1] escapeHtml — 防止 UP 主可控字段注入扩展页');
check('脚本标签被转义', () =>
  eq(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;'));
check('属性分隔符被转义', () =>
  eq(escapeHtml('a"b\'c&d<e>f'), 'a&quot;b&#39;c&amp;d&lt;e&gt;f'));
check('null/undefined 不抛异常', () => eq(escapeHtml(null), '') || eq(escapeHtml(undefined), ''));
check('数字被转字符串', () => eq(escapeHtml(123), '123'));
check('恶意分P标题不会留下可执行片段', () => {
  const evil = '</span><img src=x onerror=alert(1)><span>';
  const out = escapeHtml(evil);
  return out.includes('<img') ? '仍保留了 <img 标签' : '';
});

console.log('\n[2] formUrlEncode — 必须与 Python urllib.parse.urlencode 一致');
// 期望值取自 Python 3：urllib.parse.urlencode({'k': v})
const URLENCODE_CASES = [
  ['a b', 'a+b'],
  ['~', '~'],
  ["a!*'()b", 'a%21%2A%27%28%29b'],
  ['中文', '%E4%B8%AD%E6%96%87'],
  ['a-b_c.d~e', 'a-b_c.d~e'],
  ['A1~/ ', 'A1~%2F+'],
  ['+', '%2B'],
  ['%', '%25'],
];
for (const [input, expected] of URLENCODE_CASES) {
  check(`urlencode(${JSON.stringify(input)}) === ${expected}`, () =>
    eq(formUrlEncode(input), expected));
}
check('~ 不被转义（encodeURIComponent 会错转成 %7E）', () =>
  formUrlEncode('~') === '%7E' ? '不应转义 ~' : '');
check('空格转 + 而非 %20（encodeURIComponent 会错转成 %20）', () =>
  formUrlEncode(' ') === '%20' ? '空格应为 +' : '');

console.log('\n[3] md5 — 与 Node crypto 对拍');
const md5Cases = ['', 'a', 'abc', 'message digest', '中文测试', 'a'.repeat(55), 'a'.repeat(56),
  'a'.repeat(57), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(1000)];
for (const s of md5Cases) {
  const label = s.length <= 12 ? JSON.stringify(s) : `'a'×${s.length}`;
  check(`md5(${label})`, () => eq(md5(s), createHash('md5').update(s, 'utf8').digest('hex')));
}
check('md5(1MB 随机二进制)', () => {
  const buf = new Uint8Array(1024 * 1024);
  let seed = 42;
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = seed & 0xff;
  }
  return eq(md5(buf), createHash('md5').update(buf).digest('hex'));
});

console.log('\n[4] AV/BV 互转 — 往返一致性');
check('1..20000 随机 aid 往返一致', () => {
  for (let i = 0; i < 20000; i++) {
    const aid = 1 + Math.floor(Math.random() * 2 ** 31);
    if (bv2av(av2bv(aid)) !== aid) return `aid=${aid} 往返不一致（${av2bv(aid)} -> ${bv2av(av2bv(aid))}）`;
  }
  return '';
});
check('已知向量 BV1xx411c7mD <-> av2', () => eq(av2bv(2), 'BV1xx411c7mD'));
// 以下期望值由独立的 Python 实现算出（table/S/XOR/ADD 同一套常量）
check('av2bv(0) === BV1xx411c7mX', () => eq(av2bv(0), 'BV1xx411c7mX'));
check('av2bv(170001) === BV17x411w7KC', () => eq(av2bv(170001), 'BV17x411w7KC'));

console.log('\n[4.5] WBI mixin key —— 用 bilibili-API-collect 官方示例核验');
{
  // MIXIN_KEY_ENC_TAB 是一张 64 项的固定乱序表，一旦被改坏（哪怕一个数字），
  // 所有 WBI 签名全错 → 所有 playurl 调用返回 -403，且错误提示完全看不出是签名问题。
  // 这里用官方公开的那对 img/sub URL 反推 mixinKey 并比对，作为这张表的"防篡改锁"。
  const navMock = async () => ({
    data: {
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      },
    },
  });
  resetMixinKey();
  const key = await getMixinKey(navMock);
  check('官方示例推出 mixinKey = ea1db124af3c7062474693fa704f4ff8',
    () => eq(key, 'ea1db124af3c7062474693fa704f4ff8'));
  check('mixinKey 长度为 32', () => (key.length === 32 ? '' : `长度 ${key.length}`));

  // 签名算法自洽性：按官方定义"参数升序 → urlencode → md5(query + mixinKey)"
  const realNow = Date.now;
  Date.now = () => 1702204169000;
  const signed = signParams({ foo: '114', bar: '514', baz: 1919810 }, key);
  Date.now = realNow;
  const manual = md5('bar=514&baz=1919810&foo=114&wts=1702204169' + key);
  check('w_rid = md5(sortedQuery + mixinKey)（与手工核算一致）', () => eq(signed.w_rid, manual));
  // 注意：signParams 会把所有值统一转成字符串（便于 urlencode），所以这里比 Number()
  check('wts 为秒级时间戳', () => eq(Number(signed.wts), 1702204169));
  check('签名参数按 key 升序且剔除非法字符', () => {
    const keys = Object.keys(signed).filter((k) => k !== 'w_rid');
    const sorted = [...keys].sort();
    return keys.join(',') === sorted.join(',') ? '' : `未升序：${keys.join(',')}`;
  });

  // 缺密钥时必须给出明确错误，而不是算出个错签名
  resetMixinKey();
  let threw = false;
  try { await getMixinKey(async () => ({ data: {} })); } catch { threw = true; }
  check('nav 缺 wbi_img 时抛明确错误（不静默产出错签名）', () => (threw ? '' : '未抛错'));
  resetMixinKey();
}

console.log('\n[5] sanitizeFilename — 落盘安全');
check('禁止路径分隔符', () => eq(sanitizeFilename('a/b\\c'), 'a_b_c'));
check('相对路径穿越被清空', () => eq(sanitizeFilename('../'), 'untitled'));
check('../../etc/passwd 不产生穿越', () => {
  const out = sanitizeFilename('../../etc/passwd');
  return out.includes('/') || out.includes('\\') ? `仍含分隔符：${out}` : '';
});
check('当前目录别名被清空', () => eq(sanitizeFilename('..'), 'untitled'));
check('Windows 保留名 CON 被规避', () => eq(sanitizeFilename('CON'), '_CON'));
check('Windows 保留名 nul.mp4 被规避', () => eq(sanitizeFilename('nul.mp4'), '_nul.mp4'));
check('com1 / lpt9 被规避', () =>
  eq(sanitizeFilename('com1'), '_com1') || eq(sanitizeFilename('lpt9'), '_lpt9'));
check('普通名不受影响', () => eq(sanitizeFilename('video1.mp4'), 'video1.mp4'));
check('BiDi 欺骗字符被剥离', () => {
  // U+202E（RIGHT-TO-LEFT OVERRIDE）常被用来把 video<U+202E>cod.exe 显示成别的后缀
  const out = sanitizeFilename('video\u202Ecod.exe');
  return /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(out)
    ? `仍含 BiDi 字符：${JSON.stringify(out)}`
    : '';
});
check('尾随点空格被去掉', () => eq(sanitizeFilename('title . '), 'title'));
check('超长被截断且不留尾点', () => {
  const out = sanitizeFilename('a'.repeat(500));
  return out.length === 120 && !out.endsWith('.') ? '' : `长度=${out.length} 尾=${out.slice(-1)}`;
});

console.log('\n[6] buildPlan — 下载方式分支（含「仅音频」）');
// 最小可用 playInfo 夹具：只填 pickVideoTrack / pickAudioTrack 真正读到的字段
const mkInfo = () => ({
  mode: 'dash',
  quality: 80,
  acceptQuality: [80, 64, 32],
  duration: 100,
  videos: [
    { quality: 80, codec: 'AVC', codecid: 7, bandwidth: 2000000, url: 'https://v/1', backupUrls: [], size: 1000 },
  ],
  audios: [
    { id: 30280, type: 'aac', quality: 30280, codec: 'MPEG4-AAC', bandwidth: 320000, url: 'https://a/1', backupUrls: [], size: 200 },
  ],
  durl: [],
  raw: {},
});

check('merge：音视频都下，体积为两者之和', () => {
  const p = buildPlan(mkInfo(), { downloadMode: 'merge', preferCodec: 'avc', audioPreference: 'best' }, {});
  return eq([!!p.video, !!p.audio, p.totalBytes], [true, true, 1200]);
});
check('audio：不下视频轨，体积只算音轨', () => {
  const p = buildPlan(mkInfo(), { downloadMode: 'audio', preferCodec: 'avc', audioPreference: 'best' }, {});
  return eq([p.video, p.audioOnly, p.totalBytes], [null, true, 200]);
});
// ★ 扩展名必须跟着音轨的真实类型走，不能一律 .m4a。
//
// 默认 audioPreference='best' 会优先选中 FLAC 无损轨，于是**默认路径上**
// 就会把 FLAC 字节流存成 .m4a，用户双击很可能打不开。
check('audioOutputMeta：FLAC 轨 → .flac / audio/flac', () => {
  const m = audioOutputMeta({ type: 'flac', mimeType: 'audio/flac' });
  return eq([m.ext, m.mime], ['flac', 'audio/flac']);
});
check('audioOutputMeta：只认 mimeType 也能判出 FLAC（type 缺失时兜底）', () => {
  return eq(audioOutputMeta({ mimeType: 'audio/flac' }).ext, 'flac');
});
check('audioOutputMeta：普通 AAC 轨 → .m4a / audio/mp4', () => {
  const m = audioOutputMeta({ type: 'audio', mimeType: 'audio/mp4', id: 30280 });
  return eq([m.ext, m.mime], ['m4a', 'audio/mp4']);
});
check('audioOutputMeta：杜比轨 → .m4a（E-AC-3 装在 MP4 容器里）', () => {
  const m = audioOutputMeta({ type: 'dolby', mimeType: 'audio/mp4' });
  return eq([m.ext, m.mime], ['m4a', 'audio/mp4']);
});
check('audioOutputMeta：无信息时兜底 .m4a（不返回空扩展名）', () => {
  return eq(audioOutputMeta(null).ext, 'm4a');
});

// ★ C-1：MIME 必须按 `;` 截断后**精确**比对主类型，不能子串匹配。
//
// B 站可能返回带参数的 MIME，如 `audio/mp4; codecs="flac"`（MP4 容器里装 FLAC 编码）。
// 旧实现用 `mime.includes('flac')`，会把这种 MP4 误判成 .flac —— 扩展名与真实内容
// 不符，播放器按 .flac 解析失败。以下 6 组为回归用例。
check('audioOutputMeta：audio/flac + flac → .flac', () => {
  const m = audioOutputMeta({ mimeType: 'audio/flac', type: 'flac' });
  return eq(m.ext, 'flac');
});
check('audioOutputMeta：audio/mp4 + audio → .m4a', () => {
  const m = audioOutputMeta({ mimeType: 'audio/mp4', type: 'audio' });
  return eq(m.ext, 'm4a');
});
check('audioOutputMeta：带参数的 audio/mp4; codecs="flac" 必须判为 .m4a（不能被子串误判）', () => {
  const m = audioOutputMeta({ mimeType: 'audio/mp4; codecs="flac"', type: 'audio' });
  return eq(m.ext, 'm4a');
});
check('audioOutputMeta：audio/x-flac（无 type）→ .flac', () => {
  const m = audioOutputMeta({ mimeType: 'audio/x-flac', type: '' });
  return eq(m.ext, 'flac');
});
check('audioOutputMeta：audio/mp4 + dolby → .m4a', () => {
  const m = audioOutputMeta({ mimeType: 'audio/mp4', type: 'dolby' });
  return eq(m.ext, 'm4a');
});
check('audioOutputMeta：无 mime、type=flac 时兜底 .flac', () => {
  const m = audioOutputMeta({ mimeType: '', type: 'flac' });
  return eq(m.ext, 'flac');
});

// ★ C-2：任务级 settings 覆盖必须抽成**同一个**纯函数，run() 与 fetchExtras 共用。
//
// 旧实现里 run() 就地做了 `spec.downloadMode` 覆盖，而 fetchExtras 内部
// `const { settings } = this` 拿的是全局 settings —— 用户全局 merge + 本次选「仅音频」
// 时，fetchExtras 仍按 merge 判断，会给仅音频产物生成一个基名对不上的 NFO。
check('resolveTaskSettings：spec.downloadMode 覆盖本次，其余字段原样保留', () => {
  const r = resolveTaskSettings({ downloadMode: 'merge', saveNfo: true }, { downloadMode: 'audio' });
  return eq([r.downloadMode, r.saveNfo], ['audio', true]);
});
check('resolveTaskSettings：spec 无 downloadMode 时原样返回全局', () => {
  return eq(resolveTaskSettings({ downloadMode: 'merge' }, {}).downloadMode, 'merge');
});
check('resolveTaskSettings：downloadMode 为空串不覆盖（空串不等于有效值）', () => {
  return eq(resolveTaskSettings({ downloadMode: 'merge' }, { downloadMode: '' }).downloadMode, 'merge');
});
check('resolveTaskSettings：spec 为 null 时原样返回全局', () => {
  return eq(resolveTaskSettings({ downloadMode: 'merge' }, null).downloadMode, 'merge');
});
// ★ C-7：非法但 truthy 的 downloadMode（storage 残留，如 'audioo'）必须被忽略。
//   否则引擎会静默落到 merge 分支产出完整视频 —— falsy 值反而安全，truthy 非法值更危险。
check('resolveTaskSettings：非法 truthy downloadMode 被忽略，回落 base', () => {
  return eq(resolveTaskSettings({ downloadMode: 'merge' }, { downloadMode: 'audioo' }).downloadMode, 'merge');
});
check('resolveTaskSettings：四种合法 downloadMode 都能覆盖', () => {
  const base = { downloadMode: 'merge' };
  const got = ['merge', 'separate', 'audio', 'durl']
    .map((m) => resolveTaskSettings(base, { downloadMode: m }).downloadMode);
  return eq(got, ['merge', 'separate', 'audio', 'durl']);
});

// ★ C-5：singleOutput 直写用户文件句柄时，磁盘上的真实文件名是**用户手输的**
//   handle.name，而不是引擎算出的 `${filename}.${ext}`。面板若显示后者，用户按面板
//   去磁盘找文件会找不到（静默错文件）。
check('resolveOutputPath：singleOutput + 文件句柄 → 用磁盘真实名（handle.name）', () => {
  return eq(resolveOutputPath({ kind: 'file' }, { handle: { name: 'xxx.m4a' } }, 'xxx.flac'), 'xxx.m4a');
});
check('resolveOutputPath：dir 目标 → 保持引擎算出的名字', () => {
  return eq(resolveOutputPath({ kind: 'dir' }, { handle: { name: 'x.flac' } }, 'x.flac'), 'x.flac');
});
check('resolveOutputPath：非直写（导出/内存）→ 保持引擎名字', () => {
  return eq(resolveOutputPath({ kind: 'downloads' }, {}, 'x.flac'), 'x.flac');
});
check('resolveOutputPath：kind=file 但句柄无名 → 兜底引擎名字', () => {
  return eq(resolveOutputPath({ kind: 'file' }, { handle: {} }, 'x.flac'), 'x.flac');
});

// ★ C-6：直写句柄（createOutput 的 direct 分支）打开后必须 truncate(0)。
//
// FileHandleSink.open() 用 keepExistingData:true —— 重试/重下写到同一句柄、而新内容
// 比上一轮短时，尾部会残留旧字节，产出"新头 + 旧尾"的坏文件。merge 路径在 mergeInto
// 里显式截断了，但仅音频等直写路径此前漏了截断。用桩句柄断言 truncate 确实发出。
{
  const makeWritable = (ops) => ({
    async write(op) { ops.push(op); },
    async close() {},
    async abort() {},
  });
  const engine = new DownloadEngine({ api: {}, settings: {} });

  const fileOps = [];
  const fileHandle = { name: 'x.m4a', async createWritable() { return makeWritable(fileOps); } };
  const fileOut = await engine.createOutput({
    task: { id: 't-file' },
    destination: { kind: 'file', handle: fileHandle },
    name: 'x.flac',
    singleOutput: true,
    sizeHint: 1024,
    tempNames: [],
  });
  await fileOut.sink.close();

  const dirOps = [];
  const dirHandle = { name: 'x.flac', async createWritable() { return makeWritable(dirOps); } };
  const dir = { async getFileHandle() { return dirHandle; } };
  const dirOut = await engine.createOutput({
    task: { id: 't-dir' },
    destination: { kind: 'dir', dir },
    name: 'x.flac',
    singleOutput: true,
    sizeHint: 1024,
    tempNames: [],
  });
  await dirOut.sink.close();

  const isTruncate = (o) => o && o.type === 'truncate' && o.size === 0;
  check('createOutput：singleOutput 直写文件句柄时必须先 truncate(0)', () =>
    (fileOps.some(isTruncate) ? '' : '未截断，重试会残留上一轮尾部字节'));
  check('createOutput：目录直写句柄也必须先 truncate(0)', () =>
    (dirOps.some(isTruncate) ? '' : '未截断，重下会残留上一轮尾部字节'));
}

// ★ C-4：清单失效（fresh）时必须把 downloadedBytes 清零。
//
// v1.4.26 的 nextDownloadedBytes 只防"倒退"、没防"该清零时没清零"：
// 清单失效 → openPartial 判 fresh → 本次从 0 重下，而 task.downloadedBytes 仍是上轮的
// 60MB → 单调不减把它永久保留 → progress 恒为 0.98，整轮重下进度条纹丝不动。
// 所以「本次是否续传」必须显式决定基线：resumed 才保留，否则清零。
check('resolveProgressBase：清单失效（fresh）→ 清零，不保留上轮字节', () => {
  return eq(resolveProgressBase(60_000_000, false), 0);
});
check('resolveProgressBase：清单有效（resumed）→ 保留断点字节', () => {
  return eq(resolveProgressBase(60_000_000, true), 60_000_000);
});
check('resolveProgressBase：resumed 但 prev 非法 → 0', () => {
  return eq(resolveProgressBase(undefined, true), 0);
});
check('C-4 场景B（清单失效重下）：进度随真实字节增长，不卡在上轮 60MB', () => {
  const base = resolveProgressBase(60_000_000, false);
  return eq(nextDownloadedBytes(base, 1_000_000, 0), 1_000_000);
});
check('C-4 场景A（清单有效续传）：续传瞬间不得回退（56.9MB→48.47MB 保持 56.9MB）', () => {
  const base = resolveProgressBase(56_900_000, true);
  return eq(nextDownloadedBytes(base, 48_470_000, 0), 56_900_000);
});

// ★ C-3：savePickerHint 的 description 不能假装能自动判断无损。
//
// 它在 run() 之前调用，此时 plan 与音轨 mimeType 都还不存在，无法判定无损与否。
// 正确做法是给出可操作提示（让用户按实际音质手动改 .flac），而不是硬编码承诺。
check('savePickerHint：audio 的 description 必须提示可手动改为 .flac', () => {
  const hint = savePickerHint('audio', 'x');
  if (!hint.types[0].description.includes('.flac')) {
    return `description 未提示 .flac：${hint.types[0].description}`;
  }
  return '';
});
check('savePickerHint：audio 的 accept 同时含 .m4a 与 .flac', () => {
  const hint = savePickerHint('audio', 'x');
  const exts = Object.values(hint.types[0].accept).flat();
  return eq([exts.includes('.m4a'), exts.includes('.flac')], [true, true]);
});
check('savePickerHint：separate → x.video.mp4', () => {
  return eq(savePickerHint('separate', 'x').suggested, 'x.video.mp4');
});
check('savePickerHint：merge → x.mp4', () => {
  return eq(savePickerHint('merge', 'x').suggested, 'x.mp4');
});
check('savePickerHint：未知 mode 兜底 x.mp4', () => {
  return eq(savePickerHint(undefined, 'x').suggested, 'x.mp4');
});

// ★ 「普通音轨」设置项必须真的避开无损/杜比。
//
// 改动前普通 AAC 的 rank 恒为 4，而 flac=3、dolby=2 —— 升序取第一个的话，
// 选「普通音轨（最高码率）」反而优先拿到**杜比**，与文案完全相反。
check('pickAudioTrack：normal 模式必须选普通轨，不能选到无损/杜比', () => {
  const audios = [
    { id: 30216, type: 'audio', bandwidth: 64000 },
    { id: 30280, type: 'audio', bandwidth: 320000 },
    { id: 30250, type: 'dolby', bandwidth: 500000 },
    { id: 30251, type: 'flac', bandwidth: 900000 },
  ];
  const picked = pickAudioTrack(audios, { preferLossless: false });
  return eq([picked.type, picked.id], ['audio', 30280]);
});
check('pickAudioTrack：best 模式仍优先无损', () => {
  const audios = [
    { id: 30280, type: 'audio', bandwidth: 320000 },
    { id: 30250, type: 'dolby', bandwidth: 500000 },
    { id: 30251, type: 'flac', bandwidth: 900000 },
  ];
  return eq(pickAudioTrack(audios, { preferLossless: true }).type, 'flac');
});
check('pickAudioTrack：只有无损轨时 normal 也要能兜底拿到内容', () => {
  const audios = [{ id: 30251, type: 'flac', bandwidth: 900000 }];
  const picked = pickAudioTrack(audios, { preferLossless: false });
  return eq(picked.id, 30251);
});

// ★ 已下字节必须单调不减（「暂停 → 继续」时进度条不能倒退）
//
// 真机实测（2026-09-21）：暂停前 56.90MB，继续后一瞬间算出 48.47MB，
// 进度条从 80% 回缩到 68%。数据没丢（最终 86% > 暂停前 79%），
// 但用户看到倒退就会以为"续传没生效、又从头下了"。
check('nextDownloadedBytes：算出的比上次小时保持原值（不许倒退）', () => {
  return eq(nextDownloadedBytes(56_000_000, 48_000_000, 470_000), 56_000_000);
});
check('nextDownloadedBytes：算出的比上次大时正常前进', () => {
  return eq(nextDownloadedBytes(56_000_000, 60_000_000, 470_000), 60_470_000);
});
check('nextDownloadedBytes：相等时不回退也不跳变', () => {
  return eq(nextDownloadedBytes(1000, 600, 400), 1000);
});
check('nextDownloadedBytes：从 0 开始正常累加（新任务）', () => {
  return eq(nextDownloadedBytes(0, 300, 200), 500);
});
check('nextDownloadedBytes：undefined / NaN 不污染结果', () => {
  return eq(nextDownloadedBytes(0, undefined, NaN), 0);
});
check('nextDownloadedBytes：只有音频轨时按音频算（视频轨缺席不为 NaN）', () => {
  return eq(nextDownloadedBytes(0, undefined, 300), 300);
});
check('nextDownloadedBytes：只有视频轨时按视频算', () => {
  return eq(nextDownloadedBytes(0, 500, undefined), 500);
});

check('audio：无视频轨也不报错（纯音频投稿）', () => {
  const info = mkInfo();
  info.videos = [];
  const p = buildPlan(info, { downloadMode: 'audio', preferCodec: 'avc', audioPreference: 'best' }, {});
  return eq([!!p.audio, p.totalBytes], [true, 200]);
});
check('merge：无视频轨必须报错', () => {
  const info = mkInfo();
  info.videos = [];
  let threw = false;
  try {
    buildPlan(info, { downloadMode: 'merge', preferCodec: 'avc', audioPreference: 'best' }, {});
  } catch {
    threw = true;
  }
  return threw ? '' : '应当抛「该视频没有可用的视频轨」但没有';
});
check('durl：走单文件计划', () => {
  const info = mkInfo();
  info.mode = 'durl';
  info.durl = [{ url: 'https://d/1', backupUrls: [], size: 999 }];
  const p = buildPlan(info, { downloadMode: 'durl' }, {});
  return eq([p.mode, p.totalBytes], ['durl', 999]);
});

console.log('\n[7] BV 号严格校验 —— 防止 0/O/I/l 错位产生 -400');
const ok = (cond, msg) => (cond ? '' : msg);
check('合法 BV 通过', () => ok(isBvid('BV1xx411c7mD'), 'BV1xx411c7mD 应通过'));
check('多P常见 BV 通过', () => ok(isBvid('BV1GJ411x7h7'), '应通过'));
check('BV1TXe36KE9J（chars 全在 base58）通过', () => ok(isBvid('BV1TXe36KE9J'), '应通过'));
check('含 I（不在 base58）被拒', () => ok(!isBvid('BVITXe36KE9J'), '应拒绝'));
check('含 0、O、l 被拒', () => {
  for (const x of ['BV10OllBVID', 'BV1ABCDEFGHI', 'BV1OABCDEFGH', 'BV1lBCDEFGHI']) {
    if (isBvid(x)) return `应当拒绝 ${x}`;
  }
  return '';
});
check('过短 BV 被拒', () => ok(!isBvid('BV1XX'), '应拒绝'));
check('长度错误的 BV 被拒', () => ok(!isBvid('BV11xx411c7oZ'), '应拒绝'));
check('BV2 前缀被拒（当前只支持 BV1）', () => ok(!isBvid('BV2xx411c7mD'), '应拒绝'));
check('bv2av 也会对伪 BV 抛错', () => {
  try {
    bv2av('BVITXe36KE9J');
    return '应当抛错';
  } catch {
    return '';
  }
});

console.log('\n[8] 弹窗文案不变量 —— 不得对用户说谎（B-1 / B-2 / B-3 / B-4）');
{
  // 弹窗是 DOM 模块，无法在 Node 里 import。办法是把文案抽成 settings.js 里的
  // 纯常量（上面已 import），UI 只做引用；再对 popup.html / popup.js / popup.css
  // 做静态不变量断言，把「文案不许再说谎」锁死，防止下次重构悄悄改回去。
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => {
    try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
  };
  const POPUP_JS = read('src/popup/popup.js');
  const POPUP_HTML = read('src/popup/popup.html');
  const POPUP_CSS = read('src/popup/popup.css');
  /** 仅音频模式下加在清晰度区上的弱化 class（JS 与 CSS 必须同名）。 */
  const MUTED_CLASS = 'is-muted';

  // —— B-1：仅音频文案必须同时说清 .m4a 与 .flac，且不得承诺「直接可播」——
  //
  // 扩展名由音轨真实类型决定（engine.js audioOutputMeta）：普通 AAC / 杜比 → .m4a，
  // Hi-Res 无损 → .flac。旧文案写死 .m4a，用户遇到无损轨时按 .m4a 打开会失败。
  check('MODE_HINTS 四种下载方式齐全', () =>
    eq(['merge', 'separate', 'audio', 'durl']
      .every((k) => typeof MODE_HINTS[k] === 'string' && MODE_HINTS[k].length > 0), true));
  check('MODE_HINTS.audio 同时说明 .m4a 与 .flac', () => {
    const t = MODE_HINTS.audio;
    return t.includes('.m4a') && t.includes('.flac')
      ? '' : `扩展名说明不完整（.m4a=${t.includes('.m4a')} / .flac=${t.includes('.flac')}）：${t}`;
  });
  check('MODE_HINTS.audio 不得承诺「直接可播」（无损产物未真机验证）', () => {
    const banned = ['直接可播', '实测可用', '已真机验证'].filter((w) => MODE_HINTS.audio.includes(w));
    return banned.length ? `出现无法保证的承诺：${banned.join(' / ')}` : '';
  });

  // —— B-2：无独立音轨时必须给**可操作**指引，不得承诺「将下载完整视频」——
  //
  // engine.buildPlan 在 audio 模式下 `if (!audio) throw` 是无条件抛错：
  // 实际什么都下不了，任务直接转 error。承诺会退回去下完整视频是假话。
  check('AUDIO_UNAVAILABLE_HINT 不得承诺「将下载完整视频」', () =>
    AUDIO_UNAVAILABLE_HINT.includes('将下载完整视频')
      ? 'engine 在 audio 模式下无条件抛错，实际没有任何产物，此承诺为假' : '');
  check('AUDIO_UNAVAILABLE_HINT 必须给出替代操作指引「合并为 MP4」', () =>
    AUDIO_UNAVAILABLE_HINT.includes('合并为 MP4')
      ? '' : `缺少可操作的替代指引：${AUDIO_UNAVAILABLE_HINT}`);

  // —— 文案必须只有一份来源（popup.js 两处引用同一常量，不得再各抄一份）——
  check('popup.js 引用 MODE_HINTS / AUDIO_UNAVAILABLE_HINT 单一来源', () =>
    POPUP_JS.includes('MODE_HINTS') && POPUP_JS.includes('AUDIO_UNAVAILABLE_HINT')
      ? '' : 'popup.js 未引用抽出的常量');
  check('popup.js 不再残留手抄的旧四模式文案副本', () =>
    POPUP_JS.includes('B 站音轨本身是 fMP4')
      ? '仍存在手抄副本，改一处忘另一处必然漂移' : '');

  // —— B-3：下载方式「本次生效」，弹窗 UI 必须说明 ——
  check('popup.html 下载方式区必须标注「本次」生效', () => {
    if (!POPUP_HTML) return 'popup.html 读不到';
    const idx = POPUP_HTML.indexOf('下载方式');
    if (idx < 0) return '未找到「下载方式」区块';
    const end = POPUP_HTML.indexOf('id="pagesSection"', idx);
    const section = POPUP_HTML.slice(idx, end > idx ? end : idx + 900);
    return section.includes('本次')
      ? '' : '下载方式只影响当次下载、不写回全局，UI 未说明会让用户以为设置丢失';
  });

  // —— B-4：仅音频模式弱化清晰度区（只做视觉弱化，不得禁用）——
  //
  // 不能 disabled：清晰度仍参与文件名模板 {qualityShort}，禁用会让变量丢失。
  check('popup.html 清晰度区有可定位的 id', () =>
    POPUP_HTML.includes('id="qualitySection"') ? '' : '清晰度区缺少 id，无法按模式弱化');
  check('popup.js 在仅音频模式下给清晰度区加弱化 class', () =>
    POPUP_JS.includes('qualitySection') && POPUP_JS.includes(MUTED_CLASS)
      ? '' : 'popup.js 未按模式弱化清晰度区');
  check('popup.css 为该弱化 class 定义了透明度（视觉弱化而非禁用）', () =>
    new RegExp(`\\.${MUTED_CLASS}\\s*\\{[^}]*opacity`).test(POPUP_CSS)
      ? '' : `popup.css 缺少 .${MUTED_CLASS} 的 opacity 样式`);
}

console.log('\n[9] 切换下载方式后清晰度列表体积必须重算（B-5）');
{
  // 缺陷：buildQualityOptions() 的 size 已按 currentMode() 算（仅音频只算音轨），
  // 但 mode radio 的 change 只调 updateSummary()、**不重渲染清晰度列表** ——
  // 切换后列表里的「预计 X MB」仍是 merge 口径（含视频），比实际产物大一个数量级。
  //
  // 所以断言分两层：
  //   ① 体积口径本身抽成可导出纯函数，断言它**随 mode 变化**（这是"体积该变"的依据）
  //   ② 接线：mode change 必须真的重渲染列表，且不重置已选清晰度
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => {
    try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
  };
  const POPUP_JS = read('src/popup/popup.js');

  // 动态取命名空间：若 estimateSizeBytes 尚未导出，下面每条断言各自失败并给出原因，
  // 而不是让整个套件在 import 阶段崩掉（那样看不到任何信息）。
  const settingsPure = await import('../src/core/settings.js');
  const estimateSizeBytes = settingsPure.estimateSizeBytes;
  const hasFn = typeof estimateSizeBytes === 'function';
  const NEED = 'settings.js 未导出 estimateSizeBytes（体积口径无法被单测锁定）';

  check('estimateSizeBytes 已导出为纯函数', () => (hasFn ? '' : NEED));
  check('estimateSizeBytes：仅音频只算音轨，不含视频体积', () =>
    (!hasFn ? NEED : eq(estimateSizeBytes('audio', 1000, 200), 200)));
  check('estimateSizeBytes：merge 算视频+音轨', () =>
    (!hasFn ? NEED : eq(estimateSizeBytes('merge', 1000, 200), 1200)));
  // ★ 核心：同一组入参下，两种 mode 的体积必须不同 —— 这就是「切换后必须重算」的依据。
  check('estimateSizeBytes：同一入参下 audio 与 merge 必须给出不同体积', () => {
    if (!hasFn) return NEED;
    const a = estimateSizeBytes('audio', 1000, 200);
    const m = estimateSizeBytes('merge', 1000, 200);
    return a !== m ? '' : `两种口径算出相同体积 ${a}，切换模式后 UI 无需刷新（与事实不符）`;
  });
  check('estimateSizeBytes：无视频轨时按 0 处理，不产生 NaN', () =>
    (!hasFn ? NEED : eq(estimateSizeBytes('merge', undefined, 200), 0)));
  check('estimateSizeBytes：仅音频且无音轨 → 0（不返回 NaN/undefined）', () =>
    (!hasFn ? NEED : eq(estimateSizeBytes('audio', undefined, undefined), 0)));
  check('estimateSizeBytes：separate / durl 与 merge 同口径（都要下视频轨）', () =>
    (!hasFn ? NEED : eq([
      estimateSizeBytes('separate', 1000, 200),
      estimateSizeBytes('durl', 1000, 200),
    ], [1200, 1200])));

  // —— 接线：mode change 必须真的重渲染清晰度列表 ——
  // 取最后一处 mode radio 绑定（bindEvents 里的那个）到其后 1200 字符作为处理块。
  const modeBlock = (() => {
    const i = POPUP_JS.lastIndexOf('input[name="mode"]');
    return i < 0 ? '' : POPUP_JS.slice(i, i + 1200);
  })();

  check('popup.js 的 mode change 处理会重渲染清晰度列表', () => {
    if (!modeBlock) return '未找到 mode radio 的事件绑定块';
    return modeBlock.includes('renderQualityList(')
      ? '' : '切换模式后未重渲染清晰度列表，「预计 X MB」会停留在旧口径';
  });
  check('清晰度列表渲染被抽成单一函数，由 render() 与 mode change 共用', () => {
    const n = (POPUP_JS.match(/renderQualityList/g) || []).length;
    return n >= 3 ? '' : `renderQualityList 仅出现 ${n} 次（需 ≥3：定义 1 + render() 1 + change 1）`;
  });
  check('体积计算走 estimateSizeBytes 单一来源（不再内联按 mode 的三元）', () =>
    POPUP_JS.includes('estimateSizeBytes(') ? '' : 'popup.js 未复用 estimateSizeBytes');
  check('切换模式不得重置已选清晰度（仅音频下它仍参与文件名 {qualityShort}）', () => {
    if (!modeBlock) return '未找到 mode radio 的事件绑定块';
    // 注意：这里**不能用正则字面量**。lint-noundef.mjs 判断「/ 是正则还是除号」
    // 只看前一个非空白字符，`return /x/` 这种写法它认不出来，会把正则内容当代码扫，
    // 报 selectedQuality / resetSelection「可能未定义」的假阳性。
    const dense = modeBlock.replace(/\s+/g, '');
    const bad = ['selectedQuality=0', 'resetSelection('].filter((s) => dense.includes(s));
    return bad.length ? `切换模式时重置了已选清晰度：${bad.join(' / ')}` : '';
  });
}

console.log('\n[10] v1.4.29 六路审查修复回归守卫（DOM 模块用源码断言）');
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => {
    try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
  };
  const POPUP_JS = read('src/popup/popup.js');
  const DASH_JS = read('src/dashboard/dashboard.js');
  const ENGINE_JS = read('src/core/engine.js');
  const COMMON_CSS = read('src/ui/common.css');
  const CONTENT_JS = read('src/content/content.js');

  // F-1（产品官）：合集 spec 必须带 downloadMode —— 弹窗「本次生效」对合集不能再静默失效
  check('合集 spec 带 downloadMode（与普通分支同源 currentMode()）', () => {
    const n = (POPUP_JS.match(/downloadMode: currentMode\(\)/g) || []).length;
    return n >= 2 ? '' : `downloadMode: currentMode() 仅出现 ${n} 次（需 ≥2：普通分支 + 合集分支）`;
  });
  // F-3（产品官）：课程入口必须走 cheeseSeason 反查，不能落进 videoInfo(bvid/aid)
  check('弹窗 loadVideo 有 cheese 分支（api.cheeseSeason）', () =>
    POPUP_JS.includes('api.cheeseSeason(') ? '' : '课程链接进弹窗仍会走 videoInfo(bvid/aid) 必报错');
  // F-2（产品官）：startAll/pump/runTracked 收尾必须统一走 finishTracked（prune+release 不再漏）
  check('任务收尾统一走 finishTracked（≥3 处调用）', () => {
    const n = (DASH_JS.match(/finishTracked\(/g) || []).length;
    return n >= 3 ? '' : `finishTracked 仅出现 ${n} 次（需 ≥3：定义 + startAll + pump + runTracked）`;
  });
  // 运行时 F2 / 数据一致性 F1：移除任务后的 emit 不得重建节点（幽灵卡）
  check('renderTask 对已移除任务短路（removedIds 守卫）', () =>
    DASH_JS.includes('removedIds.has(task.id)') ? '' : '幽灵卡片守卫缺失');
  // v1.4.30 数据一致性 F3：恢复的 paused 任务必须注册防重指纹（否则可双写同一 .part）。
  // 指纹实现已从「裸 Set + 事后按 spec 重算键」换成 engine 的 SpecKeyRegistry
  // （键在 claim 时记到 task 上），所以断言改为「注册与释放都必须走注册表」。
  check('防重指纹走 SpecKeyRegistry（claim/release 成对，键记在 task 上）', () =>
    DASH_JS.includes('specRegistry.claim(task)') && DASH_JS.includes('specRegistry.release(task)')
      ? '' : '跨会话 paused / 终态释放的指纹缺口仍在（可双写同一 .part）');

  // v1.4.30 P1（运行时 F0 / 数据一致性 F2 缺口 A）：
  // specKey 含 cid 会导致「注册键（未补全 spec）≠ 释放键（已补全 spec）」→ 指纹永久泄漏。
  check('specKey 不含 cid 且定义在 engine.js（与 ensureSpecComplete 同模块）', () => {
    const m = ENGINE_JS.match(/export function specKey\(spec\)\s*\{[\s\S]*?\n\}/);
    if (!m) return 'specKey 未在 engine.js 导出（定义身份的代码必须与改写身份的代码同模块）';
    const code = m[0].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // 唯一允许的 cid 用法：没有任何上游标识时兜底（`anchor ? '' : spec?.cid`）
    if (!/anchor\s*\?\s*''\s*:/.test(code)) {
      return 'specKey 里 cid 的用法变了 —— 请重新验证「注册键 == 释放键」仍成立';
    }
    if (/\bspec\?\.cid\s*\|\|\s*''\s*,/.test(code)) {
      return 'specKey 疑似把 cid 无条件算进了键（会重现指纹永久泄漏）';
    }
    return '';
  });

  // v1.4.30 产品 F-1：弹窗派发课程任务必须透传 cheeseId（否则 playurl 走 ugc 分支必失败）
  check('弹窗 spec 透传 cheeseId（课程任务）', () =>
    POPUP_JS.includes('cheeseId: currentSpec.cheeseId') ? '' : '课程任务派发时丢了 cheeseId（v1.4.29 F-3 只修了一半）');

  // v1.4.30 安全官 F-001：safeMediaUrl 返回的是**字符串**，取 .url 会恒得到 ''
  check('弹窗封面不误用 safeMediaUrl(...).url', () =>
    POPUP_JS.includes('safeMediaUrl(info.pic || \'\').url') ? '封面 src 恒为空串（白名单保护实际从未生效）' : '');

  // v1.4.30：content.js 不得再产出全库无人认领的 cheeseSeasonId。
  // ⚠️ 只看**代码行** —— 修复说明的注释里会提到旧字段名，不能因此误报。
  check('content.js 的课程 ss 分支归一成 cheeseId', () => {
    const code = CONTENT_JS.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (code.includes('cheeseSeasonId')) return 'content.js 仍在产出 cheeseSeasonId（下游只认 cheeseId）';
    return CONTENT_JS.includes('cheeseId: Number(css[1])') ? '' : '课程 ss 分支未归一成 cheeseId';
  });

  // v1.4.30 运行时 F1：番剧（pgc）必须能在 engine 侧补全 cid
  check('ensureSpecComplete 含番剧（epId/seasonId）分支', () =>
    ENGINE_JS.includes('番剧：未能从 season 接口解析出 cid') ? '' : '番剧 spec 无法补全 cid → 页面按钮/右键菜单 100% 失败');

  // v1.4.30：普通失败路径必须关闭已打开的输出 sink（否则句柄泄漏 + 重试打不开）
  check('run() 失败分支关闭已打开的 sink', () =>
    ENGINE_JS.includes('失败收尾') ? '' : '失败路径不关 sink（句柄泄漏 / 重试永久失败）');

  // v1.4.30 数据一致性 F3：「清理临时文件」不得在活跃任务存在时执行，且 error 必须计入活跃
  check('btnClean 先判定活跃再清理，且 error 计入活跃', () => {
    if (!DASH_JS.includes("'saving', 'error'")) return 'error 未计入 hasLive（会误清待重试的续传清单）';
    return /const hasLive[\s\S]{0,400}?\.some\(/.test(DASH_JS) && /hasLive\)\s*\{[\s\S]{0,200}?return;/.test(DASH_JS)
      ? '' : 'hasLive 判定未前移到 cleanupAll 之前（会删掉在途大文件的临时产物）';
  });

  // v1.4.30 运行时 F1：抢占式占位，防 startAll 与 pump 同时启动同一任务
  check('startAll / pump 在 await 之前把状态移出 pending', () =>
    /task\.status = 'resolving'/.test(DASH_JS) && /next\.status = 'resolving'/.test(DASH_JS)
      ? '' : '未占位 → 同一任务可能被 run 两次（实测 t3/t4/t5 各跑两次）');

  // v1.4.30 产品 F-4：UGC 合集把 ugcSeason.id 写进 spec.seasonId，不能据此判番剧
  check('NFO 的 isBangumi 不含 seasonId（防合集被写成 episode）', () =>
    /isBangumi = !!\(spec\.epId \|\| spec\.cheeseId\)/.test(ENGINE_JS)
      ? '' : 'isBangumi 仍把 seasonId 当番剧标志 → 合集每一集 NFO 都是 season=1/episode=1');

  // v1.4.30 数据一致性 F1：pendingTasks 的读改写必须收敛到 SW 的串行链
  check('pendingTasks 消费/删除走 SW 串行链（CONSUME_PENDING / PRUNE_PENDING）', () =>
    DASH_JS.includes("type: 'CONSUME_PENDING'") && DASH_JS.includes("type: 'PRUNE_PENDING'")
      ? '' : 'dashboard 仍在自行读改写 pendingTasks（跨上下文会丢任务 / 复活条目）');
  // 运行时 F1：暂停/取消落在 fetchTo 重试子路径时也必须关 sink + 落清单
  check('fetchTo 重试子路径的 abort 统一走 abortExit 收尾（≥3 处调用）', () => {
    const n = (ENGINE_JS.match(/await abortExit\(\)/g) || []).length;
    return n >= 3 ? '' : `abortExit 调用仅 ${n} 处（需 ≥3：主分支 + 两条重试子路径 + 顺序回退前）`;
  });
  // 安全 F-001：字幕非白名单直接跳过（与封面对齐，不再降级 fetch）
  check('字幕非白名单直接跳过（不再降级 fetch）', () =>
    ENGINE_JS.includes('已跳过该字幕') && !ENGINE_JS.includes("credentials: safe ? 'include' : 'omit'")
      ? '' : '字幕降级 fetch 路径仍在');
  // C1（设计）：焦点样式必须真实存在 —— 上一轮声称已补但从未落地的教训
  check('common.css 存在 :focus-visible 全局焦点样式', () =>
    COMMON_CSS.includes(':focus-visible') ? '' : '焦点样式缺失（v1.4.28 声称补过但从未落地的教训）');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 核心自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
