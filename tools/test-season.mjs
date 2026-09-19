/**
 * 合集（ugc_season）解析自检（不联网，纯函数）。
 *
 * 夹具的字段结构来自**真实接口实测**（BV1Wi4y1k7ed，7 集）：
 *   ugc_season: { id, title, cover, mid, intro, sign_state, attribute, stat,
 *                 ep_count, season_type, is_pay_season, enable_vt, sections[] }
 *   sections[]: { season_id, id, title, type, episodes[] }
 *   episodes[]: { season_id, section_id, id, aid, cid, title, attribute,
 *                 arc{ pic, title, author, duration, ... }, page, bvid, pages }
 *
 * 运行：node tools/test-season.mjs
 */
import { parseUgcSeason, isBatchableSeason, seasonToSpecs } from '../src/core/season.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/** 造一个真实形状的一集。缺失字段会走默认值。 */
function ep(i, over = {}) {
  return {
    season_id: 2563105,
    section_id: 1483388,
    id: 100000 + i,
    aid: 552508991 + i,
    cid: 558362816 + i,
    title: `第 ${i + 1} 讲`,
    attribute: -1,
    arc: {
      aid: 552508991 + i,
      videos: 1,
      type_id: 21,
      type_name: '日常',
      copyright: 1,
      pic: `https://i0.hdslb.com/cover${i}.jpg`,
      title: `第 ${i + 1} 讲`,
      duration: 600 + i,
      author: { mid: 123, name: '某UP' },
    },
    page: { cid: 558362816 + i, page: 1, from: 'vupload', part: '', vid: '' },
    bvid: `BV1Wi4y1k7e${String.fromCharCode(100 + i)}`,
    pages: [{ cid: 558362816 + i, page: 1, from: 'vupload', part: '', vid: '' }],
    ...over,
  };
}

/** 造一个真实形状的 view/detail 响应。 */
function detail(episodes, over = {}) {
  return {
    code: 0,
    data: {
      View: {
        bvid: 'BV1Wi4y1k7ed',
        aid: 552508991,
        // 真实响应里 episodes 挂在 sections[] 下
        ugc_season: {
          id: 2563105,
          title: '成人拼音打字速学教程系列视频',
          cover: 'https://archive.biliimg.com/bfs/archive/x.jpg',
          mid: 123,
          intro: '教程合集',
          sign_state: 0,
          attribute: -1,
          stat: { view: 100, fav: 2 },
          ep_count: episodes.length,
          season_type: 1,
          is_pay_season: 0,
          enable_vt: 0,
          sections: [{ season_id: 2563105, id: 1483388, title: '默认分组', type: 0, episodes }],
          ...over,
        },
      },
    },
  };
}

console.log('\n[1] 正常解析（真实形状，7 集）');
{
  const s = parseUgcSeason(detail([0, 1, 2, 3, 4, 5, 6].map(ep)));
  ok('解析成功', s !== null);
  ok('合集 id = 2563105', s.id === 2563105, String(s.id));
  ok('标题正确', s.title === '成人拼音打字速学教程系列视频', s.title);
  ok('集数 = 7', s.episodes.length === 7, String(s.episodes.length));
  ok('epCount = 7', s.epCount === 7, String(s.epCount));
  const first = s.episodes[0];
  ok('每集有 bvid', !!first.bvid, first.bvid);
  ok('每集有 cid', Number(first.cid) > 0, String(first.cid));
  ok('每集有 aid', Number(first.aid) > 0, String(first.aid));
  ok('标题取自 episode.title', first.title === '第 1 讲', first.title);
  ok('封面取自 arc.pic（不在 episode 顶层）', first.cover.includes('cover0.jpg'), first.cover);
  ok('时长取自 arc.duration（不在 episode 顶层）', first.duration === 600, String(first.duration));
  ok('index 从 0 递增', s.episodes.map((x) => x.index).join(',') === '0,1,2,3,4,5,6');
  ok('保留了 sectionTitle', s.episodes[0].sectionTitle === '默认分组');
}

console.log('\n[2] 脏数据不崩');
{
  for (const v of [null, undefined, '', 0, {}, [], 'x']) {
    ok(`输入 ${JSON.stringify(v)} -> null`, parseUgcSeason(v) === null);
  }
  ok('有 ugc_season 但 sections 缺失 -> 空集列表', parseUgcSeason(detail([], { sections: undefined })).episodes.length === 0);
  ok('sections 不是数组 -> 空集列表', parseUgcSeason(detail([], { sections: 'x' })).episodes.length === 0);
  ok('episodes 不是数组 -> 空集列表',
    parseUgcSeason(detail([], { sections: [{ episodes: 'x' }] })).episodes.length === 0);
  ok('episode 是 null -> 跳过', parseUgcSeason(detail([], { sections: [{ episodes: [null, {}] }] })).episodes.length === 0);
}

console.log('\n[3] 定位不了的条目必须跳过（否则下游 playurl 会 -400）');
{
  const s = parseUgcSeason(detail([], { sections: [{ episodes: [
    ep(0),
    { ...ep(1), cid: 0 },                       // 没有 cid
    { ...ep(2), bvid: '', aid: 0 },             // 既无 bvid 也无 aid
    { ...ep(3), arc: null },                    // arc 缺失，应仍能解析（标题/封面/时长为空）
  ] }] }));
  ok('只保留 2 条（有 cid 且有 bvid/aid）', s.episodes.length === 2, String(s.episodes.length));
  ok('第 2 条是 arc 缺失那集', s.episodes[1].title === '第 4 讲', s.episodes[1].title);
  ok('arc 缺失时时长为 0 而不是崩溃', s.episodes[1].duration === 0);
  ok('arc 缺失时封面为空串', s.episodes[1].cover === '');
}

console.log('\n[4] isBatchableSeason');
{
  ok('7 集 -> 可批量', isBatchableSeason(parseUgcSeason(detail([0, 1, 2, 3, 4, 5, 6].map(ep)))) === true);
  ok('2 集 -> 可批量', isBatchableSeason(parseUgcSeason(detail([0, 1].map(ep)))) === true);
  ok('1 集 -> 不可批量（那就是普通单视频）', isBatchableSeason(parseUgcSeason(detail([ep(0)]))) === false);
  ok('0 集 -> 不可批量', isBatchableSeason(parseUgcSeason(detail([]))) === false);
  ok('null -> false', isBatchableSeason(null) === false);
}

console.log('\n[5] seasonToSpecs');
{
  const s = parseUgcSeason(detail([0, 1, 2].map(ep)));
  const specs = seasonToSpecs(s);
  ok('产出 3 条', specs.length === 3, String(specs.length));
  ok('每条都有 cid', specs.every((x) => Number(x.cid) > 0));
  ok('每条都有 bvid', specs.every((x) => !!x.bvid));
  ok('标记了 fromSeason', specs.every((x) => x.fromSeason === true));
  ok('带上了 seasonId', specs[0].seasonId === 2563105);
  ok('带上了 seasonTitle', specs[0].seasonTitle === '成人拼音打字速学教程系列视频');
  ok('带上了 seasonIndex', specs[0].seasonIndex === 0 && specs[2].seasonIndex === 2);
  ok('null 输入 -> 空数组', seasonToSpecs(null).length === 0);
}

console.log('\n[6] 兼容多种包裹层级');
{
  const inner = { id: 1, title: 'x', sections: [{ episodes: [ep(0)] }] };
  ok('data.View.ugc_season', parseUgcSeason({ data: { View: { ugc_season: inner } } }) !== null);
  ok('data.ugc_season', parseUgcSeason({ data: { ugc_season: inner } }) !== null);
  ok('顶层 ugc_season', parseUgcSeason({ ugc_season: inner }) !== null);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 合集解析自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
