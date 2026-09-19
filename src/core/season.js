/**
 * 合集（ugc_season）解析 —— 批量下载入口。
 *
 * ## 为什么是合集而不是「UP 主空间」
 *
 * UP 主空间接口 `/x/space/wbi/arc/search` 实测返回 **-352 风控校验失败**
 * （需要 `buvid3` 之类的浏览器指纹 cookie，而扩展无法注入）。
 * 而合集数据来自 `/x/web-interface/wbi/view/detail`，**不受 -352 影响**，
 * 且随"当前打开的视频"一起返回，不需要额外权限。
 *
 * ## 真实字段结构（实测 BV1Wi4y1k7ed，7 集）
 *
 * ```
 * ugc_season: { id, title, cover, mid, intro, sign_state, attribute, stat,
 *               ep_count, season_type, is_pay_season, enable_vt, sections[] }
 * sections[]: { season_id, id, title, type, episodes[] }
 * episodes[]: { season_id, section_id, id, aid, cid, title, attribute,
 *               arc{ pic, title, author, ... }, page, bvid, pages }
 * ```
 *
 * 注意：`duration` 不在 episode 顶层，在 `arc.duration`；`page` 是对象不是数字。
 *
 * 设计原则：**纯函数** + 脏数据不崩 + 定位不了就跳过（不给下游制造 -400）。
 */

/**
 * 从 `view/detail` 的响应里解析出合集信息。
 *
 * @param {unknown} detail `api.videoDetail()` 的返回值
 * @returns {{id:number,title:string,cover:string,intro:string,epCount:number,
 *            episodes:Array<{index:number,sectionId:number,sectionTitle:string,
 *            episodeId:number,bvid:string,aid:number,cid:number,title:string,
 *            cover:string,duration:number}>}|null}
 */
export function parseUgcSeason(detail) {
  const root = extractRoot(detail);
  if (!root) return null;

  const sections = Array.isArray(root.sections) ? root.sections : [];
  const episodes = [];

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const list = Array.isArray(section.episodes) ? section.episodes : [];
    const sectionTitle = typeof section.title === 'string' ? section.title : '';
    const sectionId = Number(section.id) || 0;

    for (const ep of list) {
      if (!ep || typeof ep !== 'object') continue;
      const bvid = typeof ep.bvid === 'string' ? ep.bvid : '';
      const aid = Number(ep.aid) || 0;
      const cid = Number(ep.cid) || 0;

      // 定位不到（既无 bvid 也无 aid）或没有 cid 的条目直接跳过：
      // cid 缺失会让 playurl 返回 -400，把它放进批量列表只会制造失败任务
      if (!bvid && !aid) continue;
      if (!cid) continue;

      const arc = ep.arc && typeof ep.arc === 'object' ? ep.arc : {};
      episodes.push({
        index: episodes.length,
        sectionId,
        sectionTitle,
        episodeId: Number(ep.id) || 0,
        bvid,
        aid,
        cid,
        title: str(ep.title) || str(arc.title) || '',
        cover: str(arc.pic),
        duration: Number(arc.duration) || 0,
      });
    }
  }

  return {
    id: Number(root.id) || 0,
    title: str(root.title),
    cover: str(root.cover),
    intro: str(root.intro),
    epCount: Number(root.ep_count) || episodes.length,
    episodes,
  };
}

/**
 * 是否值得作为「合集批量」提供给用户。
 * 只有 1 集的"合集"没有批量意义（那就是普通单视频）。
 */
export function isBatchableSeason(season, min = 2) {
  if (!season || !Array.isArray(season.episodes)) return false;
  return season.episodes.length >= min;
}

/** 把合集展开成一串可下任务规格（供 engine.addTask 使用）。 */
export function seasonToSpecs(season, { pageIndex = 0 } = {}) {
  if (!season || !Array.isArray(season.episodes)) return [];
  return season.episodes.map((ep) => ({
    bvid: ep.bvid || undefined,
    aid: ep.aid || undefined,
    cid: ep.cid,
    pageIndex,
    title: ep.title || '',
    cover: ep.cover || '',
    duration: ep.duration || 0,
    // 标记来源，便于下游（如 NFO）判断这是合集里的一集
    fromSeason: true,
    seasonId: season.id || 0,
    seasonTitle: season.title || '',
    seasonIndex: ep.index,
  }));
}

/* ------------------------------ 内部 ------------------------------ */

function extractRoot(detail) {
  if (!detail || typeof detail !== 'object') return null;
  // 兼容几种包裹层级：原始响应 / 已解包 data / 直接就是 ugc_season
  const candidates = [
    detail.ugc_season,
    detail.data?.View?.ugc_season,
    detail.data?.ugc_season,
    detail.View?.ugc_season,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c;
  }
  return null;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}
