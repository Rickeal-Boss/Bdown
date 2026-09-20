/**
 * 验证 rules/referer.json 的副作用防御配置。
 *
 * 背景（v1.4.20）：用户反馈「扩展开启时直接导致 B 站主页面在以下子域名无法登录」
 *   - https://message.bilibili.com/
 *   - https://t.bilibili.com/
 *   - https://space.bilibili.com/<uid>/favlist
 *   - https://member.bilibili.com/platform/upload/video/frame
 *
 * 真因：旧规则 4（id=4）的 regexFilter 命中所有 `*.bilibili.com` 子域，
 *      用 `Origin: remove` 无差别抹掉所有这些请求的 Origin 头，
 *      B 站鉴权 XHR 用 Origin 做 CSRF 校验，被抹后服务端判来源不可信 → 登录失败。
 *
 * 修复：给所有改 Origin 的规则（id=3 / id=4）加 `excludedInitiatorDomains: ["bilibili.com"]`。
 *      含义：来自 bilibili.com 任意子域（message/t/space/member/www...）的请求
 *            不再被本规则匹配；只对扩展自身（service worker / dashboard 页面，
 *            initiator 是 `chrome-extension://<id>`）生效，从而绕过 WAF 412。
 *
 * Chrome DNR 语义：
 *   - excludedInitiatorDomains: Chrome 101+，匹配的发起方子域**同样**被排除
 *   - 匹配对象是「请求发起方」而非「请求 URL」
 *   - 我们 manifest.minimum_chrome_version = 116 ✅
 *
 * 运行：node tools/test-dnr-side-effects.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const path = 'rules/referer.json';
let rules;
try {
  rules = JSON.parse(readFileSync(path, 'utf8'));
  ok('rules/referer.json 是合法 JSON', Array.isArray(rules) && rules.length > 0);
} catch (err) {
  fail += 1;
  console.log(`  \u2717 rules/referer.json 不是合法 JSON: ${err.message}`);
  rules = [];
}

const findRule = (id) => rules.find((r) => r && r.id === id);

console.log('\n[1] 规则 4（id=4）绝对不能命中 bilibili.com 系域名（passport 是登录接口）');
{
  const r = findRule(4);
  ok('规则 4 存在', !!r);
  if (r) {
    const ex = r.condition?.excludedInitiatorDomains;
    ok('excludedInitiatorDomains 是数组', Array.isArray(ex), `实际 ${typeof ex}`);
    ok('包含 bilibili.com', Array.isArray(ex) && ex.includes('bilibili.com'), `实际 ${JSON.stringify(ex)}`);
    const rf = String(r.condition?.regexFilter || '');
    // v1.4.20 修复：规则 4 不应再覆盖 bilibili.com 系域名（passport.bilibili.com 是登录接口）
    ok('regexFilter 不再覆盖 bilibili.com 系域名（修复 passport 登录）',
      !/bilibili\.com/.test(rf) && !/bilibili\.tv/.test(rf) && !/b23\.tv/.test(rf),
      rf);
    ok('regexFilter 仍覆盖 CDN 域名（保留删除 Origin 的功能）',
      rf.includes('bilivideo') || rf.includes('hdslb') || rf.includes('akamaized'),
      rf);
    ok('action 仍为 modifyHeaders', r.action?.type === 'modifyHeaders');
    ok('操作仍是移除 Origin',
      Array.isArray(r.action?.requestHeaders)
        && r.action.requestHeaders.some((h) => h.header === 'Origin' && h.operation === 'remove'));
  }
}

console.log('\n[2] 规则 3（id=3）也必须排除 bilibili.com 子域（避免成员中心上传接口被改 Origin）');
{
  const r = findRule(3);
  ok('规则 3 存在', !!r);
  if (r) {
    const ex = r.condition?.excludedInitiatorDomains;
    ok('excludedInitiatorDomains 包含 bilibili.com',
      Array.isArray(ex) && ex.includes('bilibili.com'), `实际 ${JSON.stringify(ex)}`);
    ok('仍只针对 api.bilibili.com',
      typeof r.condition?.regexFilter === 'string'
        && r.condition.regexFilter.includes('api\\.bilibili\\.com'),
      r.condition?.regexFilter);
    ok('action 仍是 set Origin=https://www.bilibili.com',
      Array.isArray(r.action?.requestHeaders)
        && r.action.requestHeaders.some((h) =>
          h.header === 'Origin' && h.operation === 'set' && h.value === 'https://www.bilibili.com'));
  }
}

console.log('\n[3] 规则 1/2（CDN Referer / UA）不应该误伤主页面');
{
  // 这些规则改的是 Referer/UA，不动 Origin；不应引入 excludedInitiatorDomains 把扩展自己的请求也排除
  // 否则扩展自己下载视频时拿不到正确的 Referer
  for (const id of [1, 2]) {
    const r = findRule(id);
    ok(`规则 ${id} 存在`, !!r);
    if (r) {
      ok(`规则 ${id} 没有 excludedInitiatorDomains（避免误伤扩展自己）`,
        !r.condition?.excludedInitiatorDomains);
      const act = Array.isArray(r.action?.requestHeaders) ? r.action.requestHeaders : [];
      const headers = act.map((h) => h.header);
      ok(`规则 ${id} 操作的是 Referer/UA（不碰 Origin）`,
        headers.every((h) => h === 'Referer' || h === 'User-Agent'),
        `actual headers: ${headers.join(',')}`);
    }
  }
}

console.log('\n[4] 规则 ID 唯一且稳定');
{
  const ids = rules.map((r) => r?.id).filter((x) => Number.isFinite(x));
  const uniq = new Set(ids);
  ok('所有规则 id 唯一', ids.length === uniq.size, `ids=${ids.join(',')}`);
  ok('预期 id 都存在（1, 2, 3, 4）',
    [1, 2, 3, 4].every((i) => uniq.has(i)));
}

console.log('\n[5] 每个规则的 resourceTypes 仍是数组且非空（防止被空数组误匹配）');
{
  for (const r of rules) {
    const rt = r.condition?.resourceTypes;
    ok(`规则 ${r.id} resourceTypes 是非空数组`,
      Array.isArray(rt) && rt.length > 0,
      `实际 ${JSON.stringify(rt)}`);
  }
}

console.log('\n[6] 防止回归：动 Origin 的规则（id=3/4）不含 "other" 资源类型');
{
  // 改 Origin 的规则覆盖面必须严格只限 XHR，否则会把主页面非 XHR 请求也改了 → 误伤
  // 规则 1/2 改的是 Referer/UA，对非 XHR 也安全（CDN 视频分片加载必须覆盖），保留 "other"
  for (const id of [3, 4]) {
    const r = findRule(id);
    if (!r) continue;
    const rt = r.condition?.resourceTypes || [];
    ok(`规则 ${id}（改 Origin）不含 "other"（覆盖面不可控）`,
      !rt.includes('other'), JSON.stringify(rt));
  }
}

console.log('\n[7] 规则 4 不得覆盖通用 CDN（akamaized.net 不是 B 站专属）');
{
  const r = findRule(4);
  const rf = String(r?.condition?.regexFilter || '');
  // 删 Origin 会破坏第三方页面依赖 Origin 的 CORS 校验（服务端需 Origin 才回显 ACAO）。
  // akamaized.net 是通用 CDN，被大量无关站点使用 —— 绝不能对它做删头操作。
  // （规则 1 保留它是因为规则 1 只改 Referer/UA，不碰 Origin，且 B 站下载确实需要。）
  ok('规则 4 不含 akamaized.net（通用 CDN，删 Origin 会误伤第三方站点）',
    !/akamaized/.test(rf), rf);
  ok('规则 4 仍含 B 站专属 CDN（bilivideo / hdslb / biliapi）',
    /bilivideo/.test(rf) && /hdslb/.test(rf), rf);
}

console.log('\n[8] 必须有"只对自己扩展生效"的严格 Origin 规则（收窄 CSRF 面）');
{
  // 静态规则 3 用 excludedInitiatorDomains 只是"排除主站页面"，并不能阻止
  // 第三方页面（evil.com）的请求被改 Origin。真正的收窄靠运行时动态规则：
  // 在 service-worker.js 里用 chrome.runtime.id 注册 initiatorDomains 规则。
  const sw = readFileSync('src/background/service-worker.js', 'utf8');
  ok('service-worker.js 注册了动态规则（updateDynamicRules）',
    /updateDynamicRules/.test(sw));
  ok('动态规则用 chrome.runtime.id 限定 initiator（只对自己生效）',
    /initiatorDomains/.test(sw) && /chrome\.runtime\.id/.test(sw));
  ok('动态规则优先级高于静态规则 3（priority >= 10）',
    /priority:\s*(1[0-9]|[2-9][0-9])/.test(sw), '未找到 priority >= 10');
  ok('动态规则注册失败被捕获（不影响主流程）',
    /catch\s*\(/.test(sw) && /不影响/.test(sw));
  ok('动态规则 id 稳定（便于幂等更新）',
    /STRICT_ORIGIN_RULE_ID\s*=\s*\d+/.test(sw));
}

console.log('\n[9] ★ api.bilibili.com 必须由 DNR 补 Referer（fetch 层设不了）');
{
  // Referer / Origin 都是 Fetch 规范的 forbidden header name —— 在 fetch() 里设置
  // 会被浏览器**静默丢弃**。api.js 的 COMMON_HEADERS 里写了 Referer，但从未送达。
  // 结果是请求画像变成"有 Origin 却无 Referer"，与 B 站自己页面的请求不一致。
  const r = findRule(3);
  ok('规则 3 存在', !!r);
  if (r) {
    const headers = Array.isArray(r.action?.requestHeaders) ? r.action.requestHeaders : [];
    const setReferer = headers.find((h) => h.header === 'Referer');
    ok('规则 3 设置了 Referer（v1.4.21 补上，之前一直缺失）',
      !!setReferer && setReferer.operation === 'set', JSON.stringify(headers.map((h) => h.header)));
    ok('Referer 值为 https://www.bilibili.com/',
      setReferer?.value === 'https://www.bilibili.com/', setReferer?.value);
    ok('规则 3 同时设置 Origin（两个头都要）',
      headers.some((h) => h.header === 'Origin' && h.operation === 'set'));
  }

  // 动态规则也要带上 Referer，否则扩展自身请求（priority 10 胜出）反而缺 Referer
  const sw = readFileSync('src/background/service-worker.js', 'utf8');
  const strictBlock = sw.slice(sw.indexOf('STRICT_ORIGIN_RULE_ID'));
  ok('动态严格规则也设置 Referer（否则 priority 10 胜出时 Referer 又丢了）',
    /header:\s*'Referer'/.test(strictBlock), '动态规则里未见 Referer');
}

console.log('\n[10] api.js 不得再宣称"在 fetch 里设 Referer/Origin 有效"');
{
  const api = readFileSync('src/core/api.js', 'utf8');
  ok('api.js 明确说明这些是 forbidden header（由 DNR 补）',
    /forbidden header/i.test(api) && /DNR/.test(api));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} DNR 副作用防御测试${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);