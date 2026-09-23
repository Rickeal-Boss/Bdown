/**
 * 弹窗 DOM id 一致性检查：popup.js 里 `$('xxx')` 引用的每个 id，
 * 必须真实存在于 popup.html。
 *
 * 背景（v1.4.27 七路审查的产品官 P0）：popup.js:352-357 引用的
 * `seasonSection` / `optWholeSeason` / `seasonLabel` / `seasonHint`
 * 四个元素在 popup.html 里根本不存在 —— 打开任何属于合集的视频，
 * `seasonSection.hidden = false` 对 null 赋值直接 TypeError，弹窗崩成报错页，
 * 这个视频完全没法下载。而「下载整个合集」的后端（season.js / collectSpecs
 * 的合集展开）全部就绪，只是 HTML 从来没写 —— 29+ 套件全是纯逻辑测试，
 * 没有任何一层能发现「JS 引用了不存在的 DOM」。
 *
 * 这条 lint 就是补上的那一层：**静态**比对 JS 引用与 HTML 定义，
 * 不需要 DOM 环境，node 直接跑。同类 bug（引用错 id、删了 HTML 漏改 JS）
 * 以后都会在这里被拦住。
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
const js = readFileSync(join(ROOT, 'src/popup/popup.js'), 'utf8');
const html = readFileSync(join(ROOT, 'src/popup/popup.html'), 'utf8');

console.log('\n[1] popup.js 引用的每个 id 都必须存在于 popup.html');
{
  // $('xxx') 与 getElementById('xxx') 两种取法都要查
  const referenced = new Set();
  for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) referenced.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([\w-]+)'\)/g)) referenced.add(m[1]);
  const defined = new Set();
  for (const m of html.matchAll(/id="([\w-]+)"/g)) defined.add(m[1]);

  const missing = [...referenced].filter((id) => !defined.has(id));
  ok('JS 引用的 id 全部在 HTML 中定义', missing.length === 0,
    `缺失：${missing.join(', ')} —— 这些引用运行时拿到 null，` +
    '读写属性即 TypeError（历史 P0：合集弹窗崩溃）');
}

console.log('\n[2] popup.html 里 id 不得重复');
{
  const dup = [];
  const seen = new Map();
  for (const m of html.matchAll(/id="([\w-]+)"/g)) {
    const n = (seen.get(m[1]) || 0) + 1;
    seen.set(m[1], n);
    if (n === 2) dup.push(m[1]);
  }
  ok('无重复 id', dup.length === 0, `重复：${dup.join(', ')}（querySelector 只会拿到第一个）`);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 弹窗 id 一致性检查${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
