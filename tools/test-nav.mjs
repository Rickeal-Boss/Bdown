/**
 * nav / ensureAccount 的健壮性自检（不联网）。
 *
 * 背景：用户反馈「扩展开启时获取 bilibili 登录信息失败，导致使用上出现问题」。
 * 根因是 `api.nav()` 无超时、无重试、不查 `res.ok`——B 站 WAF 返回 412 HTML 时
 * `res.json()` 裸抛 SyntaxError，`ensureAccount().catch(() => false)` 把**已登录**
 * 用户误判成未登录 → playurl 传 `try_look=1` 且清晰度按未登录降档（1080P → 720P）。
 *
 * 本测试锁三件事：
 *   1) nav 失败会重试，且非 JSON / HTTP 错误被显式识别（不是 SyntaxError）
 *   2) nav 抖动时 ensureAccount **不**把已确认的登录态降级为未登录
 *   3) nav 有超时（不会永久挂起）
 *
 * 运行：node tools/test-nav.mjs
 */
import { BiliApi } from '../src/core/api.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const htmlResp = (status = 412) =>
  new Response('<!DOCTYPE html><html>出错啦!</html>', { status, headers: { 'Content-Type': 'text/html' } });

console.log('\n[1] nav 遇到 WAF HTML（412）必须显式报错，不能裸抛 SyntaxError');
{
  const api = new BiliApi({ fetchImpl: async () => htmlResp(412) });
  let err = null;
  try { await api.nav(); } catch (e) { err = e; }
  ok('确实抛错', err !== null);
  ok('不是 SyntaxError（已被 res.ok 检查挡下）',
    err && !(err instanceof SyntaxError) && err.name !== 'SyntaxError', err && err.name);
  ok('是 BiliError 且带状态码', err && err.code === 412, err && `code=${err?.code}`);
}

console.log('\n[2] nav 会重试（瞬时故障可自愈）');
{
  let calls = 0;
  const api = new BiliApi({
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error('network blip');
      return jsonResp({ code: 0, data: { isLogin: true, uname: 'u', mid: 1, vipStatus: 1 } });
    },
  });
  await api.nav();
  ok('失败后重试直到成功', calls === 3, `实际调用 ${calls} 次`);
  ok('登录态被正确记录', api.account?.isLogin === true && api.account?.vip === true);
}

console.log('\n[3] ★ 核心：nav 抖动时不能把已登录用户降级为未登录');
{
  const api = new BiliApi({ fetchImpl: async () => jsonResp({ code: 0, data: { isLogin: true, uname: 'u', mid: 1, vipStatus: 0 } }) });
  // 先成功拿到登录态
  await api.ensureAccount({ force: true });
  ok('前置：已确认登录', api.account?.isLogin === true);

  // 然后让 nav 开始失败（模拟 WAF / 断网）
  api.fetchImpl = async () => htmlResp(412);
  // 把缓存标记为"已过期"（超过 60 秒新鲜期）但仍在 30 分钟容忍期内，强制重新拉取
  api.account.checkedAt = Date.now() - 120_000;

  let acc = null;
  let threw = false;
  try { acc = await api.ensureAccount(); } catch { threw = true; }
  ok('没有抛错（任务不会因此中断）', !threw);
  ok('仍返回 isLogin=true（未被误判成未登录）', acc?.isLogin === true, JSON.stringify(acc));
}

console.log('\n[4] 首次就失败且无缓存时才抛出（不掩盖真实问题）');
{
  const api = new BiliApi({ fetchImpl: async () => htmlResp(412) });
  let threw = false;
  try { await api.ensureAccount(); } catch { threw = true; }
  ok('无任何缓存时 nav 失败会抛出', threw);
}

console.log('\n[5] nav 有超时（不会永久挂起）');
{
  const api = new BiliApi({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')));
      // 永不 resolve，模拟半开连接
    }),
  });
  const t0 = Date.now();
  let threw = false;
  try { await api.nav({ timeout: 300, retries: 0 }); } catch { threw = true; }
  const dt = Date.now() - t0;
  ok('超时后抛错', threw);
  ok(`在合理时间内返回（实测 ${dt}ms，应 < 2000ms）`, dt < 2000, `${dt}ms`);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} nav 健壮性自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
