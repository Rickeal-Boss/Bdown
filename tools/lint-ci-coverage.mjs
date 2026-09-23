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
    // ★ v1.4.30：必须包含 selftest-*.mjs。
    //   旧过滤器只认 test-/lint-，而 selftest-core.mjs（128 项断言！）与
    //   selftest-synthetic.mjs 是**最重的**两个套件 —— 新增 selftest 若忘了
    //   加进工作流，本元检查根本看不见（HANDOFF §3.3 记录过 selftest 被漏计两次）。
    .filter((n) => /^(test-|lint-|selftest-).*\.mjs$/.test(n))
    .sort();
}

/** 读取全部工作流文本并拼起来（可能有多个 workflow 文件）。 */
function readWorkflows() {
  if (!existsSync(WORKFLOW_DIR)) return { text: '', files: [] };
  const files = readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n));
  const text = files.map((f) => readFileSync(join(WORKFLOW_DIR, f), 'utf8')).join('\n');
  return { text, files };
}

/**
 * 从工作流文本里抽出「**真正会被执行**的脚本路径」。
 *
 * 为什么要这么严：旧实现用 `workflowText.includes(filename)` 判断"是否被引用"——
 * 于是把文件名写进**注释**或 `echo "..."` 里就能骗过元检查（实测 PoC：
 * `test-ghost.mjs` 只出现在注释与 echo 字符串中就报了"已被引用"，而它永远不会跑）。
 * 那正是本检查要防的"绿着没跑"，却对最省事的绕过方式毫无抵抗。
 *
 * 现在的口径：逐行扫描，
 *   - 跳过以 `#` 开头的**注释行**；
 *   - 去掉行尾内联注释（` # ...`）；
 *   - 取 `run:` 之后的命令（或 `run: |` 块内的裸命令行）；
 *   - 只认「命令行**以 node / python3 开头**」，且参数是 `tools/**.mjs|py`
 *     （允许 `./tools/...` 前缀与子目录，如 `tools/fixtures/make-samples.mjs`）。
 * 这样注释、echo、name 字段里的路径都不再算数。
 */
function extractExecutedScripts(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // 去掉行尾内联注释（YAML 的 ` #`）；路径里不会出现空格+# 的组合
    const line = trimmed.split(/\s+#/)[0].trim();
    // `run: node ...` / `- run: node ...` → 取 run: 之后的命令
    let cmd = line;
    const runIdx = cmd.indexOf('run:');
    if (runIdx >= 0) cmd = cmd.slice(runIdx + 4).trim();
    cmd = cmd.replace(/^-\s*/, '').trim();
    const m = cmd.match(/^(?:node|python3?)\s+(?:\.\/)?(tools\/[\w./-]+\.(?:mjs|py))/);
    if (m) out.add(m[1]);
  }
  return out;
}

const scripts = listToolScripts();
const { text: workflowText, files: workflowFiles } = readWorkflows();
/** 真正会被执行的脚本路径集合（注释 / echo 里的不算）。 */
const executedScripts = extractExecutedScripts(workflowText);

console.log(`\n扫描 tools/ 下 ${scripts.length} 个测试/检查脚本`);
console.log(`工作流文件：${workflowFiles.join(', ') || '(无)'}`);
console.log(`工作流中真正执行的脚本：${executedScripts.size} 个\n`);

ok('存在至少一个工作流文件', workflowFiles.length > 0, '未找到 .github/workflows/*.yml');
ok('tools/ 下有测试脚本', scripts.length > 0, '一个都没找到，路径可能不对');

console.log('\n[1] 正向：每个测试脚本都必须被工作流**真正执行**（注释/echo 不算）');
{
  const missing = scripts.filter((s) => !executedScripts.has(`tools/${s}`));
  for (const s of scripts) {
    ok(`tools/${s} 已被工作流执行`, !missing.includes(s),
      '工作流里没有 `node tools/' + s + '` 这条**可执行**命令 —— 它不会在 CI 运行！' +
      '（只在注释/echo 里出现不算）');
  }
  if (missing.length) {
    console.log(`\n  ⚠️ 有 ${missing.length} 个脚本不会被 CI 执行：${missing.join(', ')}`);
  }
}

console.log('\n[2] 反向：工作流执行的 tools 脚本必须真实存在（含子目录）');
{
  const uniq = [...executedScripts].sort();
  ok('工作流里确实执行了脚本', uniq.length > 0, '一条 `node tools/*.mjs` 都没匹配到');
  const dangling = uniq.filter((r) => !existsSync(join(ROOT, r)));
  for (const r of uniq) {
    ok(`工作流执行的 ${r} 存在`, !dangling.includes(r), '文件不存在（重命名后忘了改工作流？）');
  }
  console.log(`  （共执行 ${uniq.length} 个脚本）`);
}

console.log('\n[3] 自洽：本检查自身也必须被工作流**真正执行**');
{
  ok('lint-ci-coverage.mjs 已在工作流中执行', executedScripts.has('tools/lint-ci-coverage.mjs'),
    '元检查自己不在 CI 里（或只在注释里），那它等于没跑');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} CI 覆盖检查${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
