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
import { formUrlEncode } from '../src/core/wbi.js';
import { md5 } from '../src/core/md5.js';
import { av2bv, bv2av } from '../src/core/avbv.js';

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

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 核心自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
