/**
 * 文档一致性检查：防止 README / 设置页文案与**代码实际行为**脱节。
 *
 * 背景：v1.4.25 修了三个与「仅音频」相关的缺陷，但文档与设置页文案没跟着改，
 * 于是它们开始对用户**说谎**：
 *   1. 仅音频产物扩展名不再是固定的 `.m4a` —— 由音轨真实类型决定
 *      （engine.js 的 audioOutputMeta()）：Hi-Res 无损（FLAC）→ `.flac`，
 *      普通 AAC / 杜比全景声（E-AC-3 装在 MP4 里）→ `.m4a`
 *   2. 弹窗里选的「下载方式」自 v1.4.25 起**本次生效**、不再写回全局设置，
 *      但设置页从未说明，用户会困惑「我在弹窗选了仅音频，怎么这里还是合并」
 *
 * 文案类改动同样需要可执行的失败断言，否则下次重构照样能悄悄改回去。
 * 本文件就是这组断言。**它不检查代码逻辑，只锁「文档 / 元信息」不变量 ——
 * 包括文案（[1]~[5]）与版本号两处一致性（[6]）。**
 *
 * ⚠️ 措辞纪律：本项目对「未真机验证」有严格纪律。`.flac` 产物至今**未在真机验证**
 * （只在代码与测试层验证过），所以文档**不得**出现「已真机验证」「实测可用」这类
 * 声称真机验证过的措辞。断言 [3] 是守护型断言，防止后来者乱写。
 *
 * 运行：node tools/lint-docs-consistency.mjs
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

/** 读文件；读不到返回 null（由断言报失败）。 */
function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; }
}

/**
 * 从 HTML 中抽出「包含指定标记的那一个 `<section class="card">` 卡片」文本。
 * 用于把断言限定在「下载」卡片内，避免别处的「本次」误判为通过。
 */
function cardSection(html, marker) {
  if (!html) return '';
  const parts = html.split(/(?=<section class="card">)/);
  const hit = parts.find((p) => p.includes(marker));
  return hit || '';
}

const README = read('README.md');
const OPTIONS = read('src/options/options.html');

console.log('\n[1] README.md 必须如实列出四种下载方式（含「仅音频」）');
{
  ok('README.md 存在', README !== null, '文件读不到');
  const text = README || '';
  // 实际模式：merge | separate | audio | durl（见 src/core/engine.js）
  ok('README.md 包含「仅音频」', text.includes('仅音频'),
    '文档漏了第 4 种下载方式 audio（仅音频）—— 代码里确有该模式');
}

console.log('\n[2] README.md 提到音频产物时必须同时说明 .m4a 与 .flac');
{
  const text = README || '';
  // 只要文档开始讨论音频产物扩展名（出现 .m4a），就必须把无损的 .flac 一并说清，
  // 否则用户会以为「仅音频」永远产出 .m4a，遇到无损轨时打不开文件。
  const mentionsM4a = text.includes('.m4a');
  const mentionsFlac = text.includes('.flac');
  ok('README.md 同时出现 .m4a 与 .flac', mentionsM4a && mentionsFlac,
    `音频产物说明不完整（.m4a=${mentionsM4a} / .flac=${mentionsFlac}）—— ` +
    '普通音轨存 .m4a、Hi-Res 无损存 .flac，两者都要写到');
}

console.log('\n[3] README.md 不得声称「已真机验证」（守护断言）');
{
  const text = README || '';
  // 未真机验证的能力不得写成已验证。措辞纪律：只可写「支持 …」，不可写「已验证 …」。
  const BANNED = ['已真机验证', '实测可用', '真机实测通过', '真机验证通过'];
  const hit = BANNED.filter((w) => text.includes(w));
  ok('README.md 不含「已真机验证」类措辞', hit.length === 0,
    `出现未经验证却声称验证过的措辞：${hit.join(' / ')}（.flac 至今未真机验证）`);
}

console.log('\n[4] 设置页「仅音频」选项文案必须准确（不得再写死 .m4a）');
{
  ok('src/options/options.html 存在', OPTIONS !== null, '文件读不到');
  const text = OPTIONS || '';
  ok('设置页不含过时文案「仅音频（保存为 .m4a）」', !text.includes('仅音频（保存为 .m4a）'),
    '无损轨现在存 .flac，写死 .m4a 会误导用户');
}

console.log('\n[5] 设置页下载方式区必须说明「弹窗选择本次生效」');
{
  const text = OPTIONS || '';
  const card = cardSection(text, 'data-key="downloadMode"');
  ok('下载方式卡片内出现「本次」字样', card.includes('本次'),
    'v1.4.25 起弹窗的下载方式只影响当次下载、不改全局，设置页必须说明，否则用户会困惑');
}

console.log('\n[6] 版本号必须两处一致（manifest.json 与 package.json）');
{
  // package.json 不进产物（打包脚本已排除），所以漂移不会影响用户，
  // 但会让**开发者**误判当前产物版本 —— 每次发版只改 manifest 是常态，
  // 这条断言把「另一处也要跟着改」变成硬性要求。
  const manifestRaw = read('manifest.json');
  const pkgRaw = read('package.json');
  const mv = manifestRaw ? JSON.parse(manifestRaw).version : null;
  const pv = pkgRaw ? JSON.parse(pkgRaw).version : null;
  ok('manifest.json 与 package.json 的 version 一致', mv !== null && mv === pv,
    `版本漂移：manifest=${mv} / package.json=${pv} —— 发版时两处必须一起改`);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 文档一致性检查${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
