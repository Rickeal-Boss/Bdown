/**
 * playurl 路由自检：验证 ugc / 番剧(pgc) / 课程(pugv) 三分支的接口与必填参数。
 *
 * 对齐了 DownKyi(yaobiao131/downkyi, HanLuo/downkyicore) 与 sakidown 的做法：
 *   - 番剧：优先 `/pgc/player/web/v2/playurl`（ep_id），失败降级
 *           `/pgc/player/web/playurl`（只传 cid，DownKyi/sakidown 用法）
 *   - 课程：`/pugv/player/web/playurl`，**必须带 ep_id**
 *           （DownKyi 源码注释：必须有 episodeId，否则返回请求错误）
 *
 * 运行：node tools/test-playurl-routing.mjs
 */
import { BiliApi } from '../src/core/api.js';

let pass = 0;
let fail = 0;

function ok(name, cond, msg = '') {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name} — ${msg}`);
  }
}

/** 造一个假 BiliApi：记录请求 URL，返回可控响应 */
function makeApi(handler) {
  const urls = [];
  const api = new BiliApi({
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (/web-interface\/nav/.test(url)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            isLogin: true,
            vipStatus: 0,
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(64) + '.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(64) + '.png',
            },
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return handler(String(url));
    },
  });
  api.account = { isLogin: true, vip: false, uname: 'x', mid: 1, checkedAt: Date.now() };
  return { api, urls };
}

const jsonResp = (obj) =>
  new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });

const emptyPlay = () => jsonResp({ code: 0, data: { dash: { video: [], audio: [] }, durl: [] } });

console.log('\n[1] 接口路由');
{
  // ugc
  const { api, urls } = makeApi(() => emptyPlay());
  await api.playurl({ bvid: 'BV1xx411c7mD', cid: 62131 });
  ok('ugc → /x/player/wbi/playurl', urls.some((u) => u.includes('/x/player/wbi/playurl')), urls.join(' | '));
}
{
  // 番剧
  const { api, urls } = makeApi(() => emptyPlay());
  await api.playurl({ bvid: 'BV1xx411c7mD', cid: 62131, epId: 777 });
  ok('番剧 → /pgc/player/web/v2/playurl',
    urls.some((u) => u.includes('/pgc/player/web/v2/playurl')), urls.join(' | '));
  ok('番剧带 ep_id', urls.some((u) => /ep_id=777/.test(u)), urls.join(' | '));
}
{
  // 课程
  const { api, urls } = makeApi(() => emptyPlay());
  await api.playurl({ bvid: 'BV1xx411c7mD', cid: 62131, cheeseId: 555 });
  ok('课程 → /pugv/player/web/playurl',
    urls.some((u) => u.includes('/pugv/player/web/playurl')), urls.join(' | '));
  ok('**课程必须带 ep_id**（DownKyi：否则 -400）',
    urls.some((u) => /ep_id=555/.test(u)), urls.join(' | '));
}

console.log('\n[2] 番剧 v2 失败 → 降级 v1（DownKyi / sakidown 用法）');
{
  const { api, urls } = makeApi((url) => {
    if (url.includes('/pgc/player/web/v2/playurl')) {
      return jsonResp({ code: -400, message: '请求错误' });
    }
    if (url.includes('/pgc/player/web/playurl')) {
      return jsonResp({
        code: 0,
        data: {
          dash: {
            video: [{ id: 80, quality: 80, codecid: 7, baseUrl: 'https://v/1', backup_url: [], bandwidth: 1 }],
            audio: [{ id: 30280, quality: 30280, baseUrl: 'https://a/1', backup_url: [], bandwidth: 1 }],
          },
          durl: [],
          accept_quality: [80],
        },
      });
    }
    return emptyPlay();
  });
  const info = await api.playurl({ bvid: 'BV1xx411c7mD', cid: 62131, epId: 777 });
  ok('降级到 v1 被触发', urls.some((u) => u.includes('/pgc/player/web/playurl') && !u.includes('/v2/')), urls.join(' | '));
  ok('降级后拿到了视频轨', info && info.videos && info.videos.length === 1, JSON.stringify(info && info.videos));
}

console.log('\n[3] 必填参数缺失时本地拦截（不打到 B 站）');
{
  const { api, urls } = makeApi(() => emptyPlay());
  let err = null;
  try { await api.playurl({ bvid: 'BV1xx411c7mD' }); } catch (e) { err = e; }
  ok('缺 cid → 本地抛错', err && err.code === -400 && /cid/.test(err.message), err && err.message);
  ok('缺 cid → 没打到 playurl', !urls.some((u) => /playurl/.test(u)), urls.join(' | '));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} playurl 路由自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
