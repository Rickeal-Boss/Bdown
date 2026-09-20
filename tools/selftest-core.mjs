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
import { escapeHtml, sanitizeFilename } from '../src/core/util.js';
import { formUrlEncode, getMixinKey, signParams, resetMixinKey } from '../src/core/wbi.js';
import { md5 } from '../src/core/md5.js';
import { av2bv, bv2av, isBvid } from '../src/core/avbv.js';
import { buildPlan } from '../src/core/engine.js';

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

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 核心自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
