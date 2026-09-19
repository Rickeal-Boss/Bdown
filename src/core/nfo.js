/**
 * NFO 元数据生成（Jellyfin / Kodi / Emby 媒体库归档用）。
 *
 * 为什么做：章节（chapters）已经能导出，加上 NFO 后，下载目录可以直接被
 * Jellyfin 刮削成媒体库条目（标题、简介、封面、UP 主、发布日期、时长）。
 *
 * 设计原则：
 *   - **纯函数**，不碰网络、不碰存储，可 100% CI 覆盖
 *   - **缺字段就省略该元素**，不写空标签（Jellyfin 对空值容忍度差）
 *   - 所有文本走 escapeXml，B 站返回的标题/简介里可能有 & < > 和引号
 *
 * 两种形态：
 *   - `movie`   —— 普通视频、单P（Kodi 电影库）
 *   - `episode` —— 番剧 / 多P（Kodi 剧集库，需要 season + episode 序号）
 */

/** XML 文本转义。B 站的标题/简介里确实出现过 & 与引号。 */
export function escapeXml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Unix 秒 -> `YYYY-MM-DD`。非法输入返回空串。 */
export function isoDate(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 秒 -> 分钟（Jellyfin 的 runtime 单位是分钟）。 */
export function runtimeMinutes(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 60);
}

/**
 * 只在值非空时输出一个元素。
 * @param {string} tag 元素名
 * @param {unknown} value 值
 * @param {Record<string,string>} [attrs] 属性
 */
function el(tag, value, attrs) {
  if (value === undefined || value === null || value === '') return '';
  const attrStr = attrs
    ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ')
    : '';
  return `  <${tag}${attrStr}>${escapeXml(value)}</${tag}>\n`;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n';

/**
 * 生成 NFO 文本。
 *
 * @param {object} meta
 * @param {'movie'|'episode'} [meta.kind] 默认 movie
 * @param {string} [meta.title] 标题
 * @param {string} [meta.plot] 简介
 * @param {number} [meta.pubdate] 发布时间（Unix 秒）
 * @param {number} [meta.duration] 时长（秒）
 * @param {string} [meta.cover] 封面 URL
 * @param {{name?:string, mid?:number|string}} [meta.owner] UP 主
 * @param {string} [meta.genre] 分区名
 * @param {string} [meta.bvid]
 * @param {string|number} [meta.aid]
 * @param {number} [meta.season] 季号（episode 用）
 * @param {number} [meta.episode] 集号（episode 用）
 * @param {string} [meta.showTitle] 剧集总标题（episode 用）
 * @returns {string} NFO XML
 */
export function buildNfo(meta = {}) {
  const kind = meta.kind === 'episode' ? 'episode' : 'movie';
  const date = isoDate(meta.pubdate);
  const year = date ? date.slice(0, 4) : '';
  const runtime = runtimeMinutes(meta.duration);
  const id = meta.bvid || (meta.aid ? `av${meta.aid}` : '');

  let body = '';
  body += el('title', meta.title);
  if (kind === 'episode') {
    // 剧集：用总标题做 showtitle，本集标题做 title
    body += el('showtitle', meta.showTitle || meta.title);
    body += el('season', meta.season);
    body += el('episode', meta.episode);
  }
  body += el('plot', meta.plot);
  body += el('year', year);
  body += el('premiered', date);
  body += el('aired', date);
  body += el('runtime', runtime);
  body += el('studio', 'bilibili');
  body += el('genre', meta.genre);

  if (meta.owner?.name) {
    // UP 主放进 actor，Jellyfin 会显示成"演员"，是最接近的可用字段
    body += '  <actor>\n';
    body += el('name', meta.owner.name);
    body += el('role', 'UP主');
    body += '  </actor>\n';
  }

  if (meta.cover) {
    body += el('thumb', meta.cover, { aspect: 'poster' });
  }
  if (id) {
    body += el('id', id);
    body += el('uniqueid', id, { type: 'bilibili', default: 'true' });
  }

  const root = kind === 'episode' ? 'episodedetails' : 'movie';
  return `${XML_DECL}<${root}>\n${body}</${root}>\n`;
}

/**
 * 生成剧集总信息（tvshow.nfo）。
 * 多P / 番剧批量下载时，一个目录下放一份即可。
 */
export function buildTvShowNfo(meta = {}) {
  let body = '';
  body += el('title', meta.title);
  body += el('plot', meta.plot);
  body += el('year', isoDate(meta.pubdate).slice(0, 4));
  body += el('premiered', isoDate(meta.pubdate));
  body += el('studio', 'bilibili');
  body += el('genre', meta.genre);
  if (meta.cover) body += el('thumb', meta.cover, { aspect: 'poster' });
  const id = meta.bvid || (meta.aid ? `av${meta.aid}` : '');
  if (id) {
    body += el('id', id);
    body += el('uniqueid', id, { type: 'bilibili', default: 'true' });
  }
  return `${XML_DECL}<tvshow>\n${body}</tvshow>\n`;
}

/** NFO 文件名：与媒体文件同基名（Jellyfin 的识别约定）。 */
export function nfoFilename(mediaFilename = '') {
  const base = String(mediaFilename || '').replace(/\.[^.]+$/, '');
  return `${base || 'movie'}.nfo`;
}
