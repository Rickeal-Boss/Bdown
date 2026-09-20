/**
 * 安全不变量自检（不联网）。
 *
 * 目的：把几条"一旦被改坏就会引入安全问题"的规则**锁死在测试里**，
 * 而不是靠 review 时记得住：
 *   1. 接口返回的 URL 必须过 B 站域名白名单才能带凭证（否则等于对任意可控 URL 发带 Cookie 请求）
 *   2. HTML 转义必须覆盖 `& < > " '`
 *   3. 文件名必须挡住路径穿越与 Windows 保留设备名
 *   4. 源码里不得出现 eval / new Function / document.write / 字符串定时器
 *
 * 运行：node tools/test-security.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeBiliUrl, escapeHtml, sanitizeFilename } from '../src/core/util.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

console.log('\n[1] ★ sanitizeBiliUrl：接口返回的 URL 不能随意带凭证');
{
  const okCases = [
    ['https://comment.bilibili.com/1.json', 'comment.bilibili.com'],
    ['https://i0.hdslb.com/bfs/subtitle/a.json', 'hdslb.com'],
    ['https://api.bilibili.com/x/player/v2', 'api.bilibili.com'],
    ['https://subtitle.bilibili.com/x', 'bilibili.com 子域'],
  ];
  for (const [url, label] of okCases) {
    const r = sanitizeBiliUrl(url);
    ok(`白名单内（${label}）→ safe=true 且保持 https`, r.safe && r.url.startsWith('https://'),
      JSON.stringify(r));
  }

  // 协议相对 URL
  const rel = sanitizeBiliUrl('//comment.bilibili.com/1.json');
  ok('协议相对 //host → 补成 https 且 safe', rel.safe && rel.url.startsWith('https://'), JSON.stringify(rel));

  // 明文 http 必须升级，不能带凭证明文传输
  const http = sanitizeBiliUrl('http://comment.bilibili.com/1.json');
  ok('http:// 被升级为 https://（禁止明文带凭证）',
    http.url.startsWith('https://') && http.safe, JSON.stringify(http));

  // 非 B 站域名必须被拒
  const evil = sanitizeBiliUrl('https://evil.com/steal');
  ok('非 B 站域名 → safe=false（调用方须降级为 omit）', evil.safe === false, JSON.stringify(evil));
  ok('并给出可读原因', /非 B 站域名/.test(evil.reason || ''), evil.reason);

  // 仿冒域名不能绕过（endsWith('.bilibili.com') 而非 includes）
  for (const spoof of [
    'https://bilibili.com.evil.com/x',
    'https://evilbilibili.com/x',
    'https://notbilibili.com/x',
  ]) {
    const r = sanitizeBiliUrl(spoof);
    ok(`仿冒域名被拒：${spoof}`, r.safe === false, JSON.stringify(r));
  }

  // 畸形输入
  ok('空串 → safe=false', sanitizeBiliUrl('').safe === false);
  ok('null → safe=false', sanitizeBiliUrl(null).safe === false);
  ok('乱码 → safe=false', sanitizeBiliUrl('::::').safe === false);
  ok('javascript: 伪协议 → safe=false', sanitizeBiliUrl('javascript:alert(1)').safe === false,
    JSON.stringify(sanitizeBiliUrl('javascript:alert(1)')));
}

console.log('\n[2] escapeHtml：必须覆盖 & < > " \'');
{
  ok('& 被转义', escapeHtml('a&b') === 'a&amp;b', escapeHtml('a&b'));
  ok('< 被转义', escapeHtml('<script>') === '&lt;script&gt;', escapeHtml('<script>'));
  ok('> 被转义', escapeHtml('a>b') === 'a&gt;b');
  ok('" 被转义', escapeHtml('a"b') === 'a&quot;b');
  ok("' 被转义", escapeHtml("a'b") === 'a&#39;b' || escapeHtml("a'b") === 'a&apos;b', escapeHtml("a'b"));
  ok('典型 XSS 载荷被中和', !/<script>/i.test(escapeHtml('<script>alert(1)</script>')),
    escapeHtml('<script>alert(1)</script>'));
  ok('null/undefined → 空串', escapeHtml(null) === '' && escapeHtml(undefined) === '');
}

console.log('\n[3] sanitizeFilename：路径穿越与保留名');
{
  ok('../ 被挡住', !sanitizeFilename('../../etc/passwd').includes('../'), sanitizeFilename('../../etc/passwd'));
  ok('反斜杠路径被挡住', !sanitizeFilename('..\\..\\evil.exe').includes('..\\'), sanitizeFilename('..\\..\\evil.exe'));
  ok('空串 → untitled', sanitizeFilename('') === 'untitled');
  for (const reserved of ['con', 'nul', 'com1', 'lpt9', 'CON.TXT', 'CON .txt']) {
    const out = sanitizeFilename(reserved);
    ok(`保留名被改写：${reserved} → ${out}`, out !== reserved, out);
  }
}

console.log('\n[4] 源码静态扫描：不得出现危险执行模式');
{
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })('src');

  const patterns = [
    ['eval(', /\beval\s*\(/],
    ['new Function', /new\s+Function\s*\(/],
    ['document.write', /document\.write\s*\(/],
    ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/],
    ['字符串 setTimeout', /setTimeout\s*\(\s*['"`]/],
    ['字符串 setInterval', /setInterval\s*\(\s*['"`]/],
  ];
  for (const [label, re] of patterns) {
    const hits = files.filter((f) => re.test(readFileSync(f, 'utf8')));
    ok(`无 ${label}`, hits.length === 0, hits.join(', '));
  }
}

console.log('\n[5] 敏感权限：manifest 不应多余索取');
{
  const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const perms = m.permissions || [];
  ok('无 <all_urls>', !perms.includes('<all_urls>'), JSON.stringify(perms));
  ok('无 cookies 权限（不读取登录凭证）', !perms.includes('cookies'), JSON.stringify(perms));
  ok('无 webRequestBlocking', !perms.includes('webRequestBlocking'));
  ok('未声明 externally_connectable（网页无法直接调扩展）', !m.externally_connectable,
    JSON.stringify(m.externally_connectable));

  // host_permissions 应只覆盖 B 站相关域
  const hosts = m.host_permissions || [];
  const nonBili = hosts.filter((h) => !/bilibili|hdslb|biliapi|bilivideo|akamaized/i.test(h));
  ok('host_permissions 只覆盖 B 站相关域', nonBili.length === 0, nonBili.join(', '));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 安全不变量自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
