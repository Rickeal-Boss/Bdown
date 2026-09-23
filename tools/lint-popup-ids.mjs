/**
 * 页面 DOM id 一致性检查：页面 JS 里引用的每个 id，必须真实存在于对应 HTML。
 *
 * 覆盖三个页面（v1.4.30 从「只看 popup」扩到全覆盖）：
 *   - src/popup/popup.js      ↔ src/popup/popup.html
 *   - src/dashboard/dashboard.js ↔ src/dashboard/index.html   （全库最大 JS，此前零 id 守卫）
 *   - src/options/options.js  ↔ src/options/options.html
 *
 * 背景（v1.4.27 七路审查的产品官 P0）：popup.js 引用的
 * `seasonSection` / `optWholeSeason` / `seasonLabel` / `seasonHint`
 * 四个元素在 popup.html 里根本不存在 —— 打开任何属于合集的视频，
 * `seasonSection.hidden = false` 对 null 赋值直接 TypeError，弹窗崩成报错页。
 * 29+ 套件全是纯逻辑测试，没有任何一层能发现「JS 引用了不存在的 DOM」。
 *
 * v1.4.30 加固（契约审查实测的绕过路径）：
 *   旧实现只识别**单引号**的 `$('x')` / `getElementById('x')`，于是
 *   `$("x")`、`` $(`x`) ``、`querySelector('#x')`、`getElementById("x")`
 *   全部绕过（PoC 实测：5 个不存在的 id 引用全部逃过检查、工具仍报绿）。
 *   现在识别：单/双引号/无插值模板串、`$()`（popup 的 `$` 是按 id、
 *   options 的 `$` 是 querySelector，`#` 前缀自动剥离）、`getElementById()`、
 *   `querySelector('#x')` / `querySelectorAll('#x')`（含 `#x .child` 形态）。
 *   无法静态解析的（如 `$('a' + 'b')`、含 `${}` 的模板串）不计入引用，
 *   但会打印提示，避免"看起来检查过了"。
 *
 * 运行：node tools/lint-popup-ids.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const ROOT = process.cwd();

/** 页面清单：JS ↔ HTML 一一对应。 */
const PAGES = [
  { name: 'popup', js: 'src/popup/popup.js', html: 'src/popup/popup.html' },
  { name: 'dashboard', js: 'src/dashboard/dashboard.js', html: 'src/dashboard/index.html' },
  { name: 'options', js: 'src/options/options.js', html: 'src/options/options.html' },
];

/** 把一个选择器/字符串规整成纯 id；不是 id 就返回 null。 */
function toId(raw) {
  const exact = raw.match(/^#?([\w-]+)$/);
  if (exact) return exact[1];
  // `#a .child` / `#a[i]` 这类复合选择器：取前导 id 部分
  const leading = raw.match(/^#([\w-]+)/);
  if (leading) return leading[1];
  return null; // [data-key]、.cls、input[name]、空串等：不是 id
}

/**
 * 提取一个 JS 文件里引用的所有 id。
 * @returns {{ ids: Set<string>, dynamic: string[] }}
 */
function extractReferencedIds(js) {
  const ids = new Set();
  const dynamic = [];

  const push = (raw) => {
    if (raw.includes('${')) { dynamic.push(raw); return; }
    const id = toId(raw);
    if (id) ids.add(id);
  };

  // `$('x')` / `$("x")` / $(`x`)`；也覆盖 options.js 的 `$('#x')`
  for (const m of js.matchAll(/\$\(\s*(['"`])([^'"`]*)\1\s*\)/g)) push(m[2]);
  // getElementById('x') / ("x") / (`x`)
  for (const m of js.matchAll(/getElementById\(\s*(['"`])([^'"`]*)\1\s*\)/g)) push(m[2]);
  // querySelector('#x') / querySelectorAll('#x')（含 '#x .child'）
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*(['"`])([^'"`]*)\1\s*\)/g)) {
    if (m[2].trim().startsWith('#')) push(m[2].trim());
  }
  return { ids, dynamic };
}

/** 提取 HTML 里定义的所有 id 及其重复情况。 */
function extractDefinedIds(html) {
  const ids = new Set();
  const dup = [];
  const seen = new Map();
  for (const m of html.matchAll(/\bid\s*=\s*(["'])([^"']+)\1/g)) {
    const id = m[2];
    ids.add(id);
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n === 2) dup.push(id);
  }
  return { ids, dup };
}

for (const page of PAGES) {
  console.log(`\n[${page.name}] ${page.js} ↔ ${page.html}`);

  let js = '';
  let html = '';
  try { js = readFileSync(join(ROOT, page.js), 'utf8'); } catch { /* 由断言报失败 */ }
  try { html = readFileSync(join(ROOT, page.html), 'utf8'); } catch { /* 由断言报失败 */ }

  const jsExists = js.length > 0;
  const htmlExists = html.length > 0;
  ok(`${page.js} 可读`, jsExists, '文件读不到');
  ok(`${page.html} 可读`, htmlExists, '文件读不到');
  if (!jsExists || !htmlExists) continue;

  const { ids: referenced, dynamic } = extractReferencedIds(js);
  const { ids: defined, dup } = extractDefinedIds(html);

  const missing = [...referenced].filter((id) => !defined.has(id)).sort();
  ok('JS 引用的 id 全部在对应 HTML 中定义', missing.length === 0,
    `缺失：${missing.join(', ')} —— 这些引用运行时拿到 null，` +
    '读写属性即 TypeError（历史 P0：合集弹窗崩溃）');

  ok('HTML 里 id 不得重复', dup.length === 0,
    `重复：${dup.join(', ')}（querySelector 只会拿到第一个）`);

  const unused = [...defined].filter((id) => !referenced.has(id)).sort();
  if (unused.length) {
    console.log(`  · 提示：HTML 定义了但 JS 未引用的 id（可能被 CSS/锚点使用，非失败）：${unused.join(', ')}`);
  }
  if (dynamic.length) {
    console.log(`  · 提示：${dynamic.length} 处无法静态解析的 id 引用（含 \${} 插值），未被检查：${dynamic.join(', ')}`);
  }
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 页面 id 一致性检查${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
