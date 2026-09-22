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
import { sanitizeBiliUrl, safeMediaUrl, escapeHtml, sanitizeFilename } from '../src/core/util.js';

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

  // 非白名单域名必须被拒
  const evil = sanitizeBiliUrl('https://evil.com/steal');
  ok('非白名单域名 → safe=false（调用方须降级为 omit）', evil.safe === false, JSON.stringify(evil));
  ok('并给出可读原因', /非白名单域名/.test(evil.reason || ''), evil.reason);
  // 原因里必须带上被拒的主机名，否则排障时看不出是哪个域被拦了
  ok('原因里含被拒的主机名', (evil.reason || '').includes('evil.com'), evil.reason);

  // ★ 播放地址白名单必须放行 akamai CDN（manifest 与 DNR 规则都声明了它，
  //   但 BILI_HOST_SUFFIXES 里没有 —— 用错白名单会把合法备用 CDN 全滤掉）
  const akamai = safeMediaUrl('http://upos-sz-mirrorcosov.bilivideo.com/xy.m4s');
  ok('合法 bilivideo CDN 播放地址 → 放行', akamai.startsWith('https://'), String(akamai));
  ok('合法 akamaized CDN 播放地址 → 放行',
    safeMediaUrl('http://x.akamaized.net/a.m4s').startsWith('https://'),
    String(safeMediaUrl('http://x.akamaized.net/a.m4s')));
  for (const bad of [
    'http://evil.example.com/collect',
    'http://169.254.169.254/latest/meta-data/iam/', // 云元数据服务
    'http://192.168.1.1/cgi-bin/reboot.cgi',        // 内网网关
  ]) {
    ok(`播放地址白名单必须挡下 ${bad}`, safeMediaUrl(bad) === '', String(safeMediaUrl(bad)));
  }

  // ★ 两条**不走域名比对分支**的拒绝路径，上面那组坏地址覆盖不到，
  //   只测 https://evil 会让它们一直是盲区：
  //   - file: 在 `protocol !== 'https:'` 就提前返回了，压根走不到域名比对
  //   - 协议相对 URL 是先补 https、再走域名比对，是"另一条输入、同一个出口"
  ok('file: 伪协议 → 空串（在协议分支就被挡下，到不了域名比对）',
    safeMediaUrl('file:///etc/passwd') === '', String(safeMediaUrl('file:///etc/passwd')));
  ok('协议相对 //evil.example.com/x → 空串（补成 https 后域名仍不过）',
    safeMediaUrl('//evil.example.com/x') === '', String(safeMediaUrl('//evil.example.com/x')));

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

console.log('\n[6] ★ audioOutputMeta：落盘扩展名/类型必须恒落在白名单内（mimeType 来自服务端，不可信）');
{
  const { audioOutputMeta } = await import('../src/core/engine.js');
  const { normalizePlayInfo } = await import('../src/core/api.js');

  // 它是**最后一道**决定落盘扩展名的闸门：服务端返回的 mimeType 是外部输入，
  // 而返回值会被直接拼进文件名（`${name}.${ext}`）。安全官已用畸形输入证伪过
  // 注入风险 —— 这里要锁住的是那个**不变量**：返回值只能是白名单内的两个常量，
  // 任何输入字节都不许渗进返回值。
  const EXTS = ['flac', 'm4a'];
  const MIMES = ['audio/flac', 'audio/mp4'];

  const cases = [
    ['路径穿越', { mimeType: '../../../../etc/passwd' }],
    ['命令注入', { mimeType: 'audio/flac"; rm -rf /' }],
    ['XSS 载荷', { mimeType: 'audio/mp4<script>alert(1)</script>' }],
    ['CRLF 注入', { mimeType: 'audio/flac\r\nX-Evil: 1' }],
    ['500 字符超长串', { mimeType: 'A'.repeat(500) }],
    ['带参数的 MP4（含 flac 字样）', { mimeType: 'audio/mp4; codecs="flac"' }],
    ['null', null],
    ['undefined', undefined],
    ['空对象', {}],
    ['空数组', []],
    ['数字', 0],
  ];
  for (const [label, track] of cases) {
    const r = audioOutputMeta(track);
    ok(`白名单不变量：${label} → ext/mime 均合法`,
      EXTS.includes(r?.ext) && MIMES.includes(r?.mime),
      JSON.stringify(r));
  }

  // ★ D-5：api.js 的 `a.mimeType || a.mime_type` 双读兜底 —— 服务端只给 mime_type
  //   时必须仍能判出无损轨。只读一种写法的话，会静默退回 .m4a，用户双击打不开。
  ok('audioOutputMeta 自身兜底：mimeType 为空时读 mime_type',
    audioOutputMeta({ mimeType: '', mime_type: 'audio/flac' }).ext === 'flac',
    JSON.stringify(audioOutputMeta({ mimeType: '', mime_type: 'audio/flac' })));

  const info = normalizePlayInfo({
    dash: {
      duration: 0,
      audio: [{ id: 30250, baseUrl: 'https://x.bilivideo.com/a.m4s', bandwidth: 100_000, mimeType: '', mime_type: 'audio/flac' }],
    },
  }, 'dash');
  const tr = info.audios[0];
  ok('api.js 双读：只给 mime_type 也能取到 audio/flac',
    tr?.mimeType === 'audio/flac', JSON.stringify(tr));
  ok('api.js 双读 → audioOutputMeta 判为 .flac（不退化成打不开的 .m4a）',
    audioOutputMeta(tr).ext === 'flac', JSON.stringify(audioOutputMeta(tr)));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 安全不变量自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
