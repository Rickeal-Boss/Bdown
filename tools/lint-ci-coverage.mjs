/**
 * CI 覆盖元检查：防止"新增了测试但忘了加进工作流"—— CI 会绿着却 0 覆盖。
 *
 * 为什么需要它：本项目的 `.github/workflows/validate.yml` 是**逐条列出**每个测试文件的
 * （为了让人能读懂每一步在验什么），而不是 `for f in tools/test-*.mjs` 通配。
 * 代价是：新增测试文件后如果忘了加进工作流，**CI 照样全绿**，但那个测试从未运行过。
 *
 * 这个坑真实发生过 —— v1.4.20/v1.4.21 一口气加了 3 个测试文件
 * （test-dnr-side-effects / test-extract-id / lint-control-chars），
 * 提交后才发现工作流里一个都没列。而且本项目两天内从 8 个套件涨到 19 个，
 * 这类遗漏**必然复发**，所以用元检查把它锁死。
 *
 * 检查两件事：
 *   1. 正向：tools/ 下每个 test-*.mjs / lint-*.mjs 都被工作流引用
 *   2. 反向：工作流引用的每个 tools/*.mjs 都真实存在（防重命名/笔误留下死引用）
 *
 * 运行：node tools/lint-ci-coverage.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const ROOT = process.cwd();
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows');

/** 收集 tools/ 下所有测试与检查脚本。 */
function listToolScripts() {
  let names = [];
  try { names = readdirSync(join(ROOT, 'tools')); } catch { return []; }
  return names
    .filter((n) => /^(test-|lint-).*\.mjs$/.test(n))
    .sort();
}

/** 读取全部工作流文本并拼起来（可能有多个 workflow 文件）。 */
function readWorkflows() {
  if (!existsSync(WORKFLOW_DIR)) return { text: '', files: [] };
  const files = readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n));
  const text = files.map((f) => readFileSync(join(WORKFLOW_DIR, f), 'utf8')).join('\n');
  return { text, files };
}

const scripts = listToolScripts();
const { text: workflowText, files: workflowFiles } = readWorkflows();

console.log(`\n扫描 tools/ 下 ${scripts.length} 个测试/检查脚本`);
console.log(`工作流文件：${workflowFiles.join(', ') || '(无)'}\n`);

ok('存在至少一个工作流文件', workflowFiles.length > 0, '未找到 .github/workflows/*.yml');
ok('tools/ 下有测试脚本', scripts.length > 0, '一个都没找到，路径可能不对');

console.log('\n[1] 正向：每个测试脚本都必须被工作流引用');
{
  const missing = scripts.filter((s) => !workflowText.includes(s));
  for (const s of scripts) {
    ok(`tools/${s} 已被工作流引用`, !missing.includes(s),
      '未在工作流中找到 —— 它不会在 CI 运行！请加一条 `run: node tools/' + s + '`');
  }
  if (missing.length) {
    console.log(`\n  ⚠️ 有 ${missing.length} 个脚本不会被 CI 执行：${missing.join(', ')}`);
  }
}

console.log('\n[2] 反向：工作流引用的 tools 脚本必须真实存在');
{
  // 抓 `node tools/xxx.mjs` 形式
  const referenced = [...workflowText.matchAll(/node\s+tools\/([\w.-]+\.mjs)/g)].map((m) => m[1]);
  const uniq = [...new Set(referenced)].sort();
  ok('工作流里确实引用了脚本', uniq.length > 0, '一条 `node tools/*.mjs` 都没匹配到');
  const dangling = uniq.filter((r) => !existsSync(join(ROOT, 'tools', r)));
  for (const r of uniq) {
    ok(`工作流引用的 tools/${r} 存在`, !dangling.includes(r), '文件不存在（重命名后忘了改工作流？）');
  }
  console.log(`  （共引用 ${uniq.length} 个脚本）`);
}

console.log('\n[3] 自洽：本检查自身也必须被工作流引用');
{
  ok('lint-ci-coverage.mjs 已在工作流中', workflowText.includes('lint-ci-coverage.mjs'),
    '元检查自己不在 CI 里，那它等于没跑');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} CI 覆盖检查${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
