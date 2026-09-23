/**
 * 源码控制字符检查（防止"用 heredoc 写源码时转义被解释成真实字符"这类事故复发）。
 *
 * 背景：本项目历史上**多次**踩同一个坑 —— 用 shell heredoc 写 JS 源码时，
 * 文本里的 `\u0000` / `\r` / `\n` 这类转义被工具链解释成**真正的控制字符**，
 * 直接写进文件。典型后果：
 *   - `util.js` 里一条**警告这个坑**的注释，自己含了一个真实 NUL 字节，
 *     于是文件被 grep 判定为 "Binary file"，破坏 diff / 代码审查 / 部分工具链
 *   - 正则字面量被写坏，运行时报 Invalid regular expression
 *
 * 本检查扫描所有源码/配置，发现 tab(9) LF(10) CR(13) 之外的 C0 控制字符
 * （以及 DEL 0x7F）即报错。**CR 允许**是为了兼容 CRLF 行尾。
 *
 * 运行：node tools/lint-control-chars.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const ROOT = process.cwd();
// _locales 是扩展的正式源码目录（messages.json 里的文案一旦含真实控制字符，
// 会原样进入 i18n 替换结果，比源码里的更隐蔽）；docs 与顶层 md 是审查材料，
// 同样需要保证可被 grep/diff 正常处理。
const SCAN_DIRS = ['src', 'rules', 'tools', '_locales', 'docs'];
const SCAN_EXT = /\.(js|mjs|json|css|html|md)$/;

/** 允许的"空白类"控制字符：tab / LF / CR */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/** 递归收集待检查文件。 */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(name)) out.push(full);
  }
  return out;
}

const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
// manifest 与顶层 json / 文档也一起查
for (const f of ['manifest.json', 'package.json', 'README.md', 'CHANGELOG.md', 'PRIVACY.md']) {
  try { statSync(join(ROOT, f)); files.push(join(ROOT, f)); } catch { /* 不存在就跳过 */ }
}

console.log(`\n扫描 ${files.length} 个文件（${SCAN_DIRS.join(' / ')} + 顶层 json/md）\n`);

const offenders = [];

for (const file of files) {
  const buf = readFileSync(file);
  const bad = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x20 && !ALLOWED.has(b)) bad.push({ offset: i, byte: b });
    else if (b === 0x7f) bad.push({ offset: i, byte: b });
  }
  if (!bad.length) continue;

  // 计算行号（按字节偏移之前的 LF 计数）
  const text = buf.toString('utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const details = bad.slice(0, 5).map(({ offset, byte }) => {
    const line = buf.slice(0, offset).filter((x) => x === 0x0a).length + 1;
    return `第 ${line} 行 offset ${offset} = 0x${byte.toString(16).padStart(2, '0')}`;
  });
  offenders.push({ rel, count: bad.length, details, text });
}

if (!offenders.length) {
  ok('所有源码文件均不含非法控制字符', true);
} else {
  for (const o of offenders) {
    ok(`${o.rel} 不含非法控制字符（发现 ${o.count} 个）`, false, o.details.join('; '));
    // 打印一行上下文，便于定位
    const first = o.details[0].match(/offset (\d+)/);
    if (first) {
      const off = Number(first[1]);
      const s = Math.max(0, off - 50);
      const e = Math.min(o.text.length, off + 50);
      console.log(`      … ${JSON.stringify(o.text.slice(s, e))}`);
    }
  }
}

// 额外：确认关键文件不是"二进制"（grep 会据此跳过，破坏审查）
console.log('\n[2] 关键源码必须可被 grep 当作文本处理');
{
  const key = ['src/core/util.js', 'src/core/api.js', 'src/core/engine.js'];
  for (const rel of key) {
    let buf = null;
    try { buf = readFileSync(join(ROOT, rel)); } catch { /* ignore */ }
    if (!buf) { ok(`${rel} 存在`, false); continue; }
    const hasIllegal = buf.some((b) => (b < 0x20 && !ALLOWED.has(b)) || b === 0x7f);
    ok(`${rel} 无非法控制字符（可被 grep/diff 正常处理）`, !hasIllegal);
  }
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 控制字符检查${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
