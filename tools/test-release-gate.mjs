/**
 * 发布门禁：**打包产物**必须满足的硬性条件（不联网）。
 *
 * 为什么需要这道门：本项目在"包内文件数/内容漂移"上栽过三次，而且三次形态都不同：
 *   1. 临时解压目录 `_zv` 因命令中断残留 → 整份塞进包（44 → 88 文件，体积翻倍）
 *   2. 临时探针脚本 `.sec-ping.mjs` / `.sec-verify.mjs` 残留 → 打进包（44 → 46）
 *      —— 点开头的隐藏文件 `ls` 默认看不见，比 `_zv` 更难发现
 *   3. 0 字节的 `node_diff.txt` 自 f62075d 起误提交 → 一直跟着打包
 *
 * 前两条已经由 `tools/package.mjs` 里的 `TEMP_DIR_RE` / `HIDDEN_RE` 从源头排除，
 * 但**排除规则本身也可能被改坏或绕过** —— 这道门站在产物侧独立复核，不信任上游。
 *
 * 运行：node tools/test-release-gate.mjs
 *       BDOWN_PKG_BASELINE=44 node tools/test-release-gate.mjs   # 显式更新基线
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(ROOT, 'dist');

/**
 * 包内文件数基线。
 *
 * ⚠️ 这个数字会变 —— 往 src/ 加文件、新增 _locales 条目都会让它 +1。
 * 变红**不是失败而是提醒**：请确认是不是你预期的变化，是就更新这里的基线。
 * 历史上三次污染都是靠"文件数不对"才被发现的，所以这条宁可吵也不要静默。
 */
const BASELINE = Number(process.env.BDOWN_PKG_BASELINE ?? 43);

console.log('\n[1] 找到最新的打包产物');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const zipPath = join(DIST, `Bdown-v${manifest.version}.zip`);
ok(`dist/Bdown-v${manifest.version}.zip 存在`, existsSync(zipPath),
  '请先运行 `node tools/package.mjs` 再跑这道门');
if (!existsSync(zipPath)) {
  console.log(`\n\u274c 发布门禁失败：找不到产物 ${zipPath}（失败 ${fail} 项）\n`);
  process.exit(1);
}

console.log('\n[2] 用最小 ZIP 解析器读出包内条目（不引第三方依赖）');
/** 只读 central directory，够用且无依赖。 */
function listZip(buf) {
  const names = [];
  // End of central directory 签名 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

const names = listZip(readFileSync(zipPath));
const tops = [...new Set(names.map((n) => n.split('/')[0]))].sort();

console.log('\n[3] ★ 文件数必须与基线一致（漂移是污染的第一信号）');
ok(`包内文件数 = ${BASELINE}`, names.length === BASELINE,
  `实际 ${names.length} 个${names.length > BASELINE ? '（多了东西！）' : '（少了东西）'}。\n` +
  `      若确属预期变化，更新基线：BDOWN_PKG_BASELINE=${names.length} node tools/test-release-gate.mjs`);

console.log('\n[4] ★ 不得有隐藏文件 / 临时目录（历史上两种形态的污染）');
const hidden = names.filter((n) => n.split('/').some((s) => s.startsWith('.')));
ok('无点开头的隐藏文件', hidden.length === 0, hidden.slice(0, 5).join(', '));
const tempDirs = tops.filter((t) => t.startsWith('_') && t !== '_locales');
ok('无下划线开头的临时目录', tempDirs.length === 0, tempDirs.join(', '));

console.log('\n[5] 包内必备结构');
ok('manifest.json 在包内', names.includes('manifest.json'));
ok('_locales/ 在包内（国际化）', names.some((n) => n.startsWith('_locales/')),
  '_locales 被误排除了？');
ok('src/ 在包内', names.some((n) => n.startsWith('src/')));
ok('rules/ 在包内（DNR 规则）', names.some((n) => n.startsWith('rules/')));

console.log('\n[6] 顶层不得出现源码目录之外的杂物');
const ALLOWED_TOPS = new Set([
  'manifest.json', 'src', '_locales', 'rules', 'assets',
  'README.md', 'CHANGELOG.md', 'LICENSE', 'PRIVACY.md',
]);
const stray = tops.filter((t) => !ALLOWED_TOPS.has(t));
ok('顶层无多余条目', stray.length === 0, `多余：${stray.join(', ')}`);

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 发布门禁${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）· 包内 ${names.length} 文件\n`);
process.exit(fail === 0 ? 0 : 1);
