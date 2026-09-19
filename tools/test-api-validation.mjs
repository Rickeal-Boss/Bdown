/**
 * api.get / api.playurl 本地预校验自检（不联网）。
 *
 * 覆盖几类「B 站只给一个笼统 -400，本地却分不清原因」的场景：
 *   - 请求里没有任何视频标识（bvid/avid/ep_id/season_id）
 *   - playurl 缺 cid（分P 标识）—— 实测这是最常见的 -400 真因
 *   - DNR 的 Origin 覆写规则被互相抵消
 *   - 被 B 站 WAF 拦（返回 412/403 的 HTML 错误页）
 *
 * 运行：node tools/test-api-validation.mjs
 */
import { BiliApi } from '../src/core/api.js';
import { ensureSpecComplete } from '../src/core/engine.js';

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

/** 假 fetch：nav 返回可用 wbi 密钥，其余按 code 返回 */
function makeFetchMock(opts = {}) {
  const { code = 0, status = 200, body = null } = opts;
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (/web-interface\/nav/.test(url)) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(64) + '.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(64) + '.png',
          },
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (body !== null) {
      return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(JSON.stringify({ code, data: {}, message: 'OK' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fn, calls };
}

const hitPlayurl = (calls) => calls.some((u) => /playurl/.test(String(u)));

async function main() {
  /* ---------- 1. 缺 id ---------- */
  {
    const { fn, calls } = makeFetchMock();
    const api = new BiliApi({ fetchImpl: fn });
    let err = null;
    try {
      await api.get('/x/player/wbi/playurl', { params: { cid: 1, qn: 80, fnval: 4048 }, signed: true });
    } catch (e) { err = e; }
    ok('无任何视频标识 → 本地抛 -400，且不发请求',
      err && err.code === -400 && /bvid|avid|ep_id/.test(err.message) && calls.length === 0,
      'err=' + (err && err.message) + ' calls=' + calls.length);
  }

  /* ---------- 2. 有 id 放行 ---------- */
  {
    const { fn, calls } = makeFetchMock(0);
    const api = new BiliApi({ fetchImpl: fn });
    await api.get('/x/player/wbi/playurl', {
      params: { bvid: 'BV1xx411c7mD', cid: 62131, qn: 80, fnval: 4048 }, signed: true,
    });
    ok('有 bvid → 正常发请求', hitPlayurl(calls), 'calls=' + calls.length);
  }
  {
    const { fn, calls } = makeFetchMock(0);
    const api = new BiliApi({ fetchImpl: fn });
    await api.get('/pgc/player/web/v2/playurl', {
      params: { ep_id: 12345, cid: 99999, qn: 80, fnval: 12240 }, signed: true,
    });
    ok('只 ep_id（番剧路径）也合法', hitPlayurl(calls), 'calls=' + calls.length);
  }

  /* ---------- 3. view 接口（无签名）也拦 id 缺失 ---------- */
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

  /* ---------- 4. B 站 -400 + bvid：消息点名该 BV ---------- */
  {
    const { fn } = makeFetchMock({ code: -400 });
    const api = new BiliApi({ fetchImpl: fn });
    let err = null;
    try {
      await api.get('/x/player/wbi/playurl', {
        params: { bvid: 'BV1TeU6aEct', cid: 1, qn: 80, fnval: 4048 }, signed: true,
      });
    } catch (e) { err = e; }
    ok('B 站 -400 + bvid → 消息里点名该 BV 不存在',
      err && err.code === -400 && /BV1TeU6aEct/.test(err.message) && /不存在/.test(err.message),
      'msg=' + (err && err.message));
  }

  /* ---------- 5. playurl 缺 cid ★ 真根因 ---------- */
  {
    const { fn, calls } = makeFetchMock({ code: 0 });
    const api = new BiliApi({ fetchImpl: fn });
    let err = null;
    try {
      await api.playurl({ bvid: 'BV16s7b68EEz', qn: 127 });
    } catch (e) { err = e; }
    ok('playurl 缺 cid → 本地抛「任务缺少 cid」，且不打到 playurl',
      err && err.code === -400 && /cid/.test(err.message) && !hitPlayurl(calls),
      'err=' + (err && err.message) + ' playurlHits=' + hitPlayurl(calls));
  }

  /* ---------- 6. ensureSpecComplete 补全裸 spec ---------- */
  {
    let called = 0;
    const fakeApi = {
      videoInfo: async () => {
        called += 1;
        return {
          bvid: 'BV16s7b68EEz', aid: 116808682048293, cid: 39386548303,
          title: '兔子！有空拍个视频吗？', pic: 'https://pic',
          pages: [{ page: 1, cid: 39386548303, part: '兔子！有空拍个视频吗？', duration: 106 }],
          owner: { name: 'x', mid: 1 }, duration: 106, pubdate: 1,
        };
      },
    };
    const bare = { bvid: 'BV16s7b68EEz', pageIndex: 0 };
    const out = await ensureSpecComplete(bare, fakeApi);
    ok('裸 spec 被补全 cid', out.cid === 39386548303, 'cid=' + out.cid);
    ok('裸 spec 被补全 title', out.title === '兔子！有空拍个视频吗？', 'title=' + out.title);
    ok('裸 spec 被补全 info.pages', Array.isArray(out.info && out.info.pages), 'info=' + JSON.stringify(out.info));
    ok('补全只请求了一次 view', called === 1, 'called=' + called);
    await ensureSpecComplete({ bvid: 'BV16s7b68EEz', cid: 111 }, fakeApi);
    ok('已有 cid 时跳过请求', called === 1, 'called=' + called);
  }

  /* ---------- 7. WAF 拦截（HTML 412/403） ---------- */
  {
    const { fn } = makeFetchMock({ status: 412, body: '<!DOCTYPE html><html>出错啦!</html>' });
    const api = new BiliApi({ fetchImpl: fn });
    let err = null;
    try {
      await api.get('/x/player/wbi/playurl', {
        params: { bvid: 'BV16s7b68EEz', cid: 1, qn: 80, fnval: 4048 }, signed: true,
      });
    } catch (e) { err = e; }
    ok('HTTP 412 + HTML → 报「被 B 站风控拦截」且提示 Origin 原因',
      err && err.code === 412 && /风控/.test(err.message) && /Origin/.test(err.message),
      'err=' + (err && err.message));
  }

  /* ---------- 8. DNR 的 Origin 规则 ---------- */
  {
    const fs = await import('node:fs');
    const rules = JSON.parse(fs.readFileSync(new URL('../rules/referer.json', import.meta.url), 'utf8'));
    const originRules = rules.filter((r) =>
      (r.action && r.action.requestHeaders || []).some((h) => h.header.toLowerCase() === 'origin'));
    ok('存在处理 Origin 的 DNR 规则', originRules.length >= 1, 'count=' + originRules.length);

    const apiSet = originRules.find((r) =>
      (r.action && r.action.requestHeaders || []).some((h) => h.header.toLowerCase() === 'origin' && h.operation === 'set')
      && /api\\.bilibili\\.com/.test((r.condition && r.condition.regexFilter) || ''));
    ok('api.bilibili.com 有 Origin:set 规则', !!apiSet, 'not found');
    if (apiSet) {
      const broadRemove = originRules.find((r) =>
        (r.action && r.action.requestHeaders || []).some((h) => h.header.toLowerCase() === 'origin' && h.operation === 'remove')
        && /bilibili\\.com/.test((r.condition && r.condition.regexFilter) || ''));
      ok('Origin:set 优先级严格高于宽泛的 Origin:remove',
        !broadRemove || (apiSet.priority || 1) > (broadRemove.priority || 1),
        'set=' + (apiSet.priority || 1) + ' remove=' + (broadRemove && (broadRemove.priority || 1)));
      const v = (apiSet.action.requestHeaders.find((h) => h.header.toLowerCase() === 'origin') || {}).value;
      ok('Origin 被设为 https://www.bilibili.com', v === 'https://www.bilibili.com', 'value=' + v);
    }
  }

  // 场景 9：engine.run 在 spec.quality=0 时发 qn=0（不再强制 127）
  {
    let qnSent = null;
    const fakeApi = {
      videoInfo: async () => ({ bvid: 'BV16s7b68EEz', aid: 1, cid: 39386548303, pages: [{ page: 1, cid: 39386548303 }] }),
      playurl: async (p) => { qnSent = p.qn; return { mode: 'dash', quality: p.qn || 16, videos: [], audios: [], acceptQuality: [p.qn || 16], durl: [] }; },
    };
    const { DownloadEngine } = await import('../src/core/engine.js');
    const { Task } = await import('../src/core/engine.js');
    const engine = new DownloadEngine({ api: fakeApi, settings: { downloadMode: 'merge', defaultQuality: 0, concurrency: 1, audioPreference: 'best', preferCodec: 'avc', saveMode: 'ask', maxParallelTasks: 1 }, onUpdate: () => {} });
    const task = new Task({ bvid: 'BV16s7b68EEz' }, {});
    try { await engine.run(task, {}); } catch (e) {}
    ok('spec.quality=0（自动）→ engine 发出 qn=0 而不是 127',
      qnSent === 0, 'qn sent=' + qnSent);
  }

  // 场景 10：spec.quality=80 时 engine 透传 80
  {
    let qnSent = null;
    const fakeApi = {
      videoInfo: async () => ({ bvid: 'BV16s7b68EEz', cid: 1, pages: [{ cid: 1 }] }),
      playurl: async (p) => { qnSent = p.qn; return { mode: 'dash', quality: p.qn, videos: [], audios: [], acceptQuality: [p.qn], durl: [] }; },
    };
    const { DownloadEngine, Task } = await import('../src/core/engine.js');
    const engine = new DownloadEngine({ api: fakeApi, settings: { downloadMode: 'merge', defaultQuality: 0, concurrency: 1, audioPreference: 'best', preferCodec: 'avc', saveMode: 'ask', maxParallelTasks: 1 }, onUpdate: () => {} });
    const task = new Task({ bvid: 'BV16s7b68EEz', quality: 80 }, {});
    try { await engine.run(task, {}); } catch (e) {}
    ok('spec.quality=80 → engine 透传 80',
      qnSent === 80, 'qn sent=' + qnSent);
  }


  // 场景 11：playurl 自动 qn 按账号状态挑选（不强制 127）
  {
    for (const [label, account, expectedQn] of [
      ['已登录非会员', { isLogin: true, vip: false }, 80],
      ['大会员',      { isLogin: true, vip: true  }, 127],
      ['未登录',      null,                              64],
    ]) {
      const captured = [];
      const api = new BiliApi({
        fetchImpl: async (url) => {
          captured.push(String(url));
          if (/web-interface\/nav/.test(url)) {
            return new Response(JSON.stringify({
              code: 0,
              data: {
                isLogin: !!account && account.isLogin,
                vipStatus: account && account.vip ? 1 : 0,
                wbi_img: {
                  img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(64) + '.png',
                  sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(64) + '.png',
                },
              },
            }), { headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ code: 0, data: {} }), { headers: { 'Content-Type': 'application/json' } });
        },
      });
      try { await api.playurl({ bvid: 'BV1xx411c7mD', cid: 62131, qn: 0 }); } catch {}
      const playurlUrl = captured.find((u) => /playurl/.test(u)) || '';
      const m = playurlUrl.match(/qn=(\d+)/);
      const got = m ? Number(m[1]) : -1;
      ok('账号=' + label + ' → qn=' + expectedQn + '（不让非会员被降级到 360P 预览）',
        got === expectedQn, 'got qn=' + got + ' in ' + (m && m[0]));
    }
  }

  console.log('\n' + (fail === 0 ? '\u2705' : '\u274c') + ' api 预校验自检' +
    (fail === 0 ? '完成，失败 0 项' : '完成，失败 ' + fail + ' 项') +
    '（通过 ' + pass + '）\n');
  process.exit(fail === 0 ? 0 : 1);
}

main();
