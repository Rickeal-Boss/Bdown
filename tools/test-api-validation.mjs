/**
 * api.get 本地预校验自检（不联网）。
 *
 * 防止「请求缺少 bvid/avid/ep_id」悄悄打到 B 站 → B 站返回 code=-400
 * 「请求错误」，本脚本用假 fetchImpl 验证：
 *   - 无 id 时必须本地抛 BiliError(-400) 且 fetchImpl 未被调用
 *   - 有 bvid 时必须放行到 fetchImpl
 *   - 有 ep_id 时（番剧路径）也必须放行
 *
 * 运行：node tools/test-api-validation.mjs
 */
import { BiliApi } from '../src/core/api.js';

let pass = 0;
let fail = 0;

function ok(name, cond, msg = '') {
  if (cond) {
    pass += 1;
    console.log('  \u2713 ' + name);
  } else {
    fail += 1;
    console.log('  \u2717 ' + name + ' — ' + msg);
  }
}

function makeFetchMock(opts = {}) {
  const { code = 0, withNav = true } = opts;
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    // nav 接口需要返回 wbi_img，否则 getMixinKey 抛错
    if (withNav && /web-interface\/nav/.test(url)) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
          },
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code, data: {}, message: 'OK' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fn, calls };
}

async function main() {
  // 场景 1：缺所有 id → 本地拦截
  {
    const { fn, calls } = makeFetchMock();
    const api = new BiliApi({ fetchImpl: fn });
    let err = null;
    try {
      await api.get('/x/player/wbi/playurl', { params: { cid: 1, qn: 80, fnval: 4048 }, signed: true });
    } catch (e) { err = e; }
    ok('无任何视频标识 → 本地抛 -400，不发请求',
      err && err.code === -400 && /bvid|avid|ep_id/.test(err.message) && calls.length === 0,
      'err=' + (err && err.message) + ' calls=' + calls.length);
  }

  // 场景 2：有 bvid → 放行
  {
    const { fn, calls } = makeFetchMock(0);
    const api = new BiliApi({ fetchImpl: fn });
    await api.get('/x/player/wbi/playurl', {
      params: { bvid: 'BV1xx411c7mD', cid: 62131, qn: 80, fnval: 4048 },
      signed: true,
    });
    ok('有 bvid → 正常发请求', calls.length >= 1, 'calls=' + calls.length);
  }

  // 场景 3：只 ep_id（番剧路径）→ 放行
  {
    const { fn, calls } = makeFetchMock(0);
    const api = new BiliApi({ fetchImpl: fn });
    await api.get('/pgc/player/web/v2/playurl', {
      params: { ep_id: 12345, cid: 99999, qn: 80, fnval: 12240 },
      signed: true,
    });
    ok('只 ep_id（番剧路径）也合法', calls.length >= 1, 'calls=' + calls.length);
  }

  // 场景 4：view 接口（无 signed）也拦 id 缺失
  {
    const { fn, calls } = makeFetchMock();
    const api = new BiliApi({ fetchImpl: fn });
    let err = null;
    try {
      await api.get('/x/web-interface/view', { params: { some: 'thing' }, signed: false });
    } catch (e) { err = e; }
    ok('view 接口（不带签名）也本地拦 id 缺失',
      err && err.code === -400 && calls.length === 0,
      'err=' + (err && err.message) + ' calls=' + calls.length);
  }

  
  // 场景 5：B 站返 -400 但请求里带 bvid → 给出「BVID 在 B 站不存在」具体诊断
  {
    const { fn } = makeFetchMock({ code: -400, message: '请求错误' });
    const api = new BiliApi({ fetchImpl: fn });
    let err = null;
    try {
      await api.get('/x/player/wbi/playurl', {
        params: { bvid: 'BV1TeU6aEct', cid: 1, qn: 80, fnval: 4048 },
        signed: true,
      });
    } catch (e) { err = e; }
    ok(
      'B 站 -400 + bvid → 消息里点名该 BV 不存在',
      err && err.code === -400 && /BV1TeU6aEct/.test(err.message) && /不存在/.test(err.message),
      'msg=' + (err && err.message),
    );
  }

console.log('\n' + (fail === 0 ? '\u2705' : '\u274c') + ' api 预校验自检' +
    (fail === 0 ? '完成，失败 0 项' : '完成，失败 ' + fail + ' 项') +
    '（通过 ' + pass + '）\n');
  process.exit(fail === 0 ? 0 : 1);
}

main();
  // 场景 6：DNR 规则的 Origin 覆写必须正确（防止规则互相抵消）
  {
    const fs = await import('node:fs');
    const rules = JSON.parse(fs.readFileSync(new URL('../rules/referer.json', import.meta.url), 'utf8'));
    const originRules = rules.filter((r) =>
      (r.action?.requestHeaders || []).some((h) => h.header.toLowerCase() === 'origin'));
    ok('存在处理 Origin 的 DNR 规则', originRules.length >= 1, 'count=' + originRules.length);

    // api.bilibili.com 的 set 规则必须优先级最高，否则会被宽泛的 remove 抵消
    const apiSet = originRules.find((r) =>
      (r.action?.requestHeaders || []).some((h) => h.header.toLowerCase() === 'origin' && h.operation === 'set')
      && /api\\.bilibili\\.com/.test(r.condition?.regexFilter || ''));
    ok('api.bilibili.com 有 Origin:set 规则', !!apiSet, 'not found');
    if (apiSet) {
      const broadRemove = originRules.find((r) =>
        (r.action?.requestHeaders || []).some((h) => h.header.toLowerCase() === 'origin' && h.operation === 'remove')
        && /bilibili\\.com/.test(r.condition?.regexFilter || ''));
      ok('Origin:set 优先级严格高于宽泛的 Origin:remove',
        !broadRemove || (apiSet.priority || 1) > (broadRemove.priority || 1),
        'set=' + (apiSet.priority || 1) + ' remove=' + (broadRemove && (broadRemove.priority || 1)));
      const v = (apiSet.action.requestHeaders.find((h) => h.header.toLowerCase() === 'origin') || {}).value;
      ok('Origin 被设为 https://www.bilibili.com（B 站 WAF 只放行这个值）',
        v === 'https://www.bilibili.com', 'value=' + v);
    }
  }


