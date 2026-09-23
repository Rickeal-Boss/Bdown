/**
 * 静态校验：JS 语法、JSON 合法性、manifest 引用完整性、DNR 规则结构。
 * 不依赖浏览器，可在 CI 中直接运行。
 *
 *   node tools/validate.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;

function ok(msg) {
  checks += 1;
  console.log(`  \u2713 ${msg}`);
}

function fail(msg) {
  checks += 1;
  failures += 1;
  console.log(`  \u2717 ${msg}`);
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
      walk(full, filter, out);
    } else if (filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------------- 1. JS 语法 ---------------- */
console.log('\n[1/5] JavaScript 语法检查');
const jsFiles = walk(ROOT, (n) => n.endsWith('.js') || n.endsWith('.mjs'));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`${rel(file)} — ${String(err.stderr || err.message).split('\n').slice(0, 4).join(' | ')}`);
  }
}
ok(`${jsFiles.length} 个 JS 文件语法检查完毕`);

/* ---------------- 2. JSON 合法性 ---------------- */
console.log('\n[2/5] JSON 校验');
const jsonFiles = walk(ROOT, (n) => n.endsWith('.json'));
const parsed = new Map();
for (const file of jsonFiles) {
  try {
    parsed.set(rel(file), JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    fail(`${rel(file)} — ${err.message}`);
  }
}
ok(`${jsonFiles.length} 个 JSON 文件解析完毕`);

/* ---------------- 3. manifest 引用完整性 ---------------- */
console.log('\n[3/5] manifest 引用完整性');
const manifest = parsed.get('manifest.json');
if (!manifest) {
  fail('manifest.json 缺失或非法');
} else {
  const referenced = new Set();
  const add = (p) => p && referenced.add(p);

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.options_ui?.page);
  for (const p of Object.values(manifest.icons || {})) add(p);
  for (const p of Object.values(manifest.action?.default_icon || {})) add(p);
  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  }
  for (const r of manifest.declarative_net_request?.rule_resources || []) add(r.path);
  for (const war of manifest.web_accessible_resources || []) (war.resources || []).forEach(add);

  for (const p of referenced) {
    if (p.includes('*')) continue;
    if (!fs.existsSync(path.join(ROOT, p))) fail(`manifest 引用了不存在的文件：${p}`);
  }
  ok(`${referenced.size} 个 manifest 引用均存在`);

  if (manifest.manifest_version !== 3) fail('manifest_version 必须为 3');
  else ok('manifest_version = 3');

  for (const locale of fs.readdirSync(path.join(ROOT, '_locales'))) {
    const msgFile = path.join(ROOT, '_locales', locale, 'messages.json');
    if (!fs.existsSync(msgFile)) {
      fail(`_locales/${locale} 缺少 messages.json`);
      continue;
    }
    const messages = JSON.parse(fs.readFileSync(msgFile, 'utf8'));
    for (const key of ['extName', 'extDesc']) {
      if (!messages[key]?.message) fail(`_locales/${locale} 缺少 ${key}`);
    }
  }
  ok(`default_locale=${manifest.default_locale} 的文案齐全`);

  const perms = new Set(manifest.permissions || []);
  for (const need of ['storage', 'downloads', 'declarativeNetRequestWithHostAccess']) {
    if (!perms.has(need)) fail(`缺少必需权限：${need}`);
  }
  const hosts = manifest.host_permissions || [];
  for (const need of ['*://*.bilibili.com/*', '*://*.bilivideo.com/*']) {
    if (!hosts.includes(need)) fail(`缺少 host_permissions：${need}`);
  }
  ok('权限与 host_permissions 完整');
}

/* ---------------- 4. DNR 规则 ---------------- */
console.log('\n[4/5] declarativeNetRequest 规则');
const rules = parsed.get('rules/referer.json');
if (!Array.isArray(rules)) {
  fail('rules/referer.json 必须是数组');
} else {
  const ids = new Set();
  for (const rule of rules) {
    if (typeof rule.id !== 'number') fail(`规则缺少数字 id：${JSON.stringify(rule).slice(0, 60)}`);
    else if (ids.has(rule.id)) fail(`规则 id 重复：${rule.id}`);
    else ids.add(rule.id);
    if (!rule.action?.type) fail(`规则 ${rule.id} 缺少 action.type`);
    if (!rule.condition) fail(`规则 ${rule.id} 缺少 condition`);
    if (rule.condition?.regexFilter) {
      try {
        new RegExp(rule.condition.regexFilter);
      } catch (err) {
        fail(`规则 ${rule.id} 的正则非法：${err.message}`);
      }
    }
    for (const h of rule.action?.requestHeaders || []) {
      if (!h.header || !h.operation) fail(`规则 ${rule.id} 的 requestHeaders 项不完整`);
    }
  }
  ok(`${rules.length} 条 DNR 规则结构合法`);
}

/* ---------------- 5. 模块导入图 ---------------- */
console.log('\n[5/5] 模块导入图与具名导出');

/**
 * 逐个 import 核心模块。这一步能抓到「import 了不存在的导出」这类低级但致命的错误，
 * 也是 CI 里最有价值的一项检查。
 *
 * 这里只加载不依赖 DOM / chrome 顶层调用的模块；界面层模块由语法检查覆盖。
 */
const coreModules = [
  'src/core/util.js',
  'src/core/md5.js',
  'src/core/wbi.js',
  'src/core/avbv.js',
  'src/core/quality.js',
  'src/core/mp4.js',
  'src/core/sink.js',
  'src/core/downloader.js',
  'src/core/danmaku.js',
  'src/core/subtitle.js',
  'src/core/settings.js',
  'src/core/api.js',
  'src/core/lifecycle.js',
  'src/core/engine.js',
];

// 界面层模块在 Node 里没有 chrome / document，仅检查其 import 语句指向的模块是否存在
function checkImportTargets(file) {
  const source = fs.readFileSync(file, 'utf8');
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) {
      fail(`${rel(file)} 引用了不存在的模块：${m[1]}`);
    }
  }
}

for (const mod of coreModules) {
  try {
    await import(new URL(`../${mod}`, import.meta.url).href);
    ok(`import ${mod}`);
  } catch (err) {
    fail(`import ${mod} — ${err.message}`);
  }
}

for (const file of jsFiles) checkImportTargets(file);
ok(`${jsFiles.length} 个文件的相对 import 路径均可解析`);

console.log(`\n${failures ? '\u274c' : '\u2705'} 共 ${checks} 项检查，失败 ${failures} 项\n`);
process.exit(failures ? 1 : 0);
