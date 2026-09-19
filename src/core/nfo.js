/**
 * NFO 元数据生成（Jellyfin / Kodi / Emby 媒体库归档用）。
 *
 * 为什么做：章节（chapters）已经能导出，加上 NFO 后，下载目录可以直接被
 * Jellyfin 刮削成媒体库条目（标题、简介、封面、UP 主、发布日期、时长）。
 *
 * 设计原则：
 *   - **纯函数**，不碰网络、不碰存储，可 100% CI 覆盖
 *   - **缺字段就省略该元素**，不写空标签（Jellyfin 对空值容忍度差）
 *   - 文本先**剥离控制字符**再做 XML 实体转义
 *   - 不写 `<fileinfo><streamdetails>`（会覆盖 Jellyfin 自己的探测结果）
 *
 * 两种形态：
 *   - `movie`   —— 普通视频（**含多P**）
 *   - `episode` —— 番剧 / 课程
 *   形态按**视频类型**判定，不按 P 数判定。
 */

/**
 * 控制字符（XML 1.0 里非法的那些）。
 *
 * 用 String.fromCharCode 构造而**不写反斜杠转义**：本项目踩过坑——
 * 通过 shell heredoc 写文件时，形如 U+0000 的转义会被解释成真正的控制字符
 * 写进源码，直接把文件变成语法错误。
 */
const CONTROL_CHARS = new RegExp(
  '['
  + String.fromCharCode(0) + '-' + String.fromCharCode(8)
  + String.fromCharCode(11) + String.fromCharCode(12)
  + String.fromCharCode(14) + '-' + String.fromCharCode(31)
  + String.fromCharCode(127)
  + ']',
  'g',
);

/**
 * XML 文本转义 —— **先剥离控制字符，再做 5 实体转义**。
 *
 * 为什么必须先剥离控制字符：视频简介（desc）是自由文本，确实含控制字符。
 * 它们**不是合法 XML 1.0 字符**，会让整个 NFO 解析失败，而 Jellyfin 只会
 * 静默丢弃该文件 —— 用户完全不知道为什么没刮削到。这是本功能的 P0。
 */
export function escapeXml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 超长文本截断（B 站简介可达数万字符，没必要全塞进 NFO）。
 *
 * 注意**代理对**：若第 max 个字符正好是一个 emoji 的高代理项，直接 slice
 * 会把它切成半个，写进文件后变成 U+FFFD（`?`）。虽然 U+FFFD 是合法 XML 字符、
 * 不会导致解析失败，但用户会看到末尾一个乱码字符 —— 切掉它更好。
 */
export function truncateText(value, max = 10000) {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  // 高代理项范围 U+D800..U+DBFF：说明这个字符被切成了两半
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Unix 秒 -> `YYYY-MM-DD`，**按 Asia/Shanghai 格式化**。
 *
 * 为什么必须指定时区：B 站的 pubdate 是北京时间语义。若按 UTC 或运行环境的
 * 本地时区格式化，**凌晨发布的视频会差一天**（我们的 CI 跑在 UTC 上，必现）。
 */
export function isoDate(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  try {
    // en-CA 的短日期格式正好是 YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
}

/** 秒 -> 分钟（Jellyfin 的 runtime 单位是分钟）。 */
export function runtimeMinutes(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 60);
}

/**
 * 判断一个值在 NFO 里是否"等同于空"。
 *
 * 注意 **0 也算空**：`runtime` / `season` / `episode` 在拿不到真实值时都是 0，
 * 而 `<runtime>0</runtime>` 会让 Jellyfin 认为"片长 0 分钟"。
 * （这里踩过一次：断言只查了空标签 `<runtime></runtime>`，实际产出的是
 *  `<runtime>0</runtime>` —— 非空，于是断言正好绕开，和 vStage 那次同类。）
 */
function isEmpty(value) {
  if (value === undefined || value === null) return true;
  if (value === '') return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return true;
    if (value === 0) return true;
  }
  return false;
}

/** 只在值非空时输出一个元素。 */
function el(tag, value, attrs) {
  if (isEmpty(value)) return '';
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
 * @param {'movie'|'episode'} [meta.kind] 默认 movie。**按视频类型传**：
 *        普通视频（含多P）传 movie；番剧 / 课程传 episode
 * @param {string} [meta.title]
 * @param {string} [meta.plot] 简介（会自动剥离控制字符 + 截断到 10000 字）
 * @param {number} [meta.pubdate] 发布时间（Unix 秒，按北京时间格式化）
 * @param {number} [meta.duration] 时长（秒）
 * @param {string} [meta.cover] 封面 URL
 * @param {{name?:string, mid?:number|string, face?:string}} [meta.owner] UP 主
 * @param {string} [meta.genre] B 站分区名
 * @param {string} [meta.bvid]
 * @param {string|number} [meta.aid]
 * @param {number} [meta.season] 季号（episode 用）
 * @param {number} [meta.episode] 集号（episode 用）
 * @param {string} [meta.showTitle] 番剧/课程总标题（episode 用）
 * @returns {string} NFO XML
 */
export function buildNfo(meta = {}) {
  const kind = meta.kind === 'episode' ? 'episode' : 'movie';
  const date = isoDate(meta.pubdate);
  const year = date ? date.slice(0, 4) : '';
  const runtime = runtimeMinutes(meta.duration);
  const bvid = meta.bvid || '';
  const aid = meta.aid ? String(meta.aid) : '';
  const pageUrl = bvid ? `https://www.bilibili.com/video/${bvid}` : '';

  let body = '';
  body += el('title', meta.title);
  if (kind === 'episode') {
    body += el('showtitle', meta.showTitle || meta.title);
    body += el('season', meta.season);
    body += el('episode', meta.episode);
  }
  body += el('plot', truncateText(meta.plot));
  body += el('year', year);
  body += el('premiered', date);
  body += el('aired', date);
  body += el('runtime', runtime);
  body += el('genre', meta.genre);

  if (meta.owner?.name) {
    // UP 主放进 actor：Kodi/Jellyfin 没有"创作者"对应元素，这是最接近的可用字段
    body += '  <actor>\n';
    body += el('name', meta.owner.name);
    body += el('role', 'UP主');
    if (meta.owner.face) body += el('thumb', meta.owner.face);
    body += '  </actor>\n';
  }

  if (meta.cover) body += el('thumb', meta.cover, { aspect: 'poster' });
  body += el('source', 'Bilibili');
  body += el('website', pageUrl);
  if (bvid) {
    body += el('id', bvid);
    body += el('uniqueid', bvid, { type: 'bilibili', default: 'true' });
  }
  if (aid) body += el('uniqueid', aid, { type: 'avid' });

  const root = kind === 'episode' ? 'episodedetails' : 'movie';
  return `${XML_DECL}<${root}>\n${body}</${root}>\n`;
}

/**
 * 生成剧集总信息（tvshow.nfo）。
 *
 * **目前未接线到下载流程**：Jellyfin 要求 tvshow.nfo 位于剧集专属目录，
 * 而我们输出到平铺目录，写一个固定 tvshow.nfo 会污染同目录的其他内容。
 * 保留函数，供将来「按番剧建子目录」时使用。
 */
export function buildTvShowNfo(meta = {}) {
  let body = '';
  body += el('title', meta.title);
  body += el('plot', truncateText(meta.plot));
  body += el('year', isoDate(meta.pubdate).slice(0, 4));
  body += el('premiered', isoDate(meta.pubdate));
  body += el('genre', meta.genre);
  body += el('source', 'Bilibili');
  if (meta.cover) body += el('thumb', meta.cover, { aspect: 'poster' });
  const bvid = meta.bvid || '';
  if (bvid) {
    body += el('id', bvid);
    body += el('uniqueid', bvid, { type: 'bilibili', default: 'true' });
  }
  return `${XML_DECL}<tvshow>\n${body}</tvshow>\n`;
}

/** NFO 文件名：与媒体文件同基名（Jellyfin 识别约定，多P 天然不覆盖）。 */
export function nfoFilename(mediaFilename = '') {
  const base = String(mediaFilename || '').replace(/\.[^.]+$/, '');
  return `${base || 'movie'}.nfo`;
}
