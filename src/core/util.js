/**
 * 通用工具函数。
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带指数退避的重试。
 *
 * ⚠️ `times` 必须**先归一化再进循环**。若直接 `for (let i = 0; i < times; i++)`
 * 而 `times` 是 NaN / 0 / 负数，循环**一次都不会执行**，于是：
 *   - `fn` 从未被调用（表现为"这个操作静默没发生"）
 *   - `lastErr` 还是 undefined，最后 `throw undefined` —— 错误信息全部丢失
 * 这两点叠加起来极难排查。v1.4.22 真实踩过一次（retries 设置透出 NaN）。
 *
 * 这里统一兜底：非有限数 / <1 一律按 1 次处理（至少执行一次，让真实错误能抛出来）。
 */
export async function retry(fn, { times = 3, baseDelay = 400, onRetry, shouldRetry } = {}) {
  const n = Number(times);
  const total = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  let lastErr;
  for (let i = 0; i < total; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      // ★ 允许调用方声明"这类错误不值得重试"。
      //
      // 没有它时会出两类真实问题：
      //   1. 服务器不支持 Range（rangeIgnored）：重试只会把**整个文件**再下一遍 ——
      //      默认 8 并发分片 × (retries+1) = 24 次全量下载，纯浪费且拖慢失败反馈。
      //   2. 用户取消（DownloadAborted）：已取消还要跑满重试次数并 sleep，
      //      retries=5 时可多拖 ~15s 才响应取消。
      if (shouldRetry && !shouldRetry(err)) break;
      if (i === total - 1) break;
      if (onRetry) onRetry(err, i + 1);
      await sleep(baseDelay * 2 ** i);
    }
  }
  // total >= 1，所以 lastErr 必然被赋值过；这里再兜一层防止未来改动又把循环跳过
  throw lastErr ?? new Error('retry: 未执行任何尝试且无错误对象（times 参数异常）');
}

export function formatBytes(bytes, digits = 2) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '--';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '00:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond) return '--';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.ceil(seconds % 60)} 秒`;
  return `${Math.floor(seconds / 3600)} 时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

/** 把秒数格式化为 ASS/SRT 时间码。 */
export function toSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
}

export function toAssTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

/**
 * ASS 字幕文本转义。
 *
 * ASS 里 `{` `}` `\` 是**控制字符**：`{\...}` 是 override tag，`\N` 是强制换行。
 * 用户文本（弹幕、AI 生成字幕）里出现这些很常见，不转义就会产出结构损坏的 ASS
 * —— 表现为整段不显示、或把 `{\an8}` 这类标记当原文显示出来。
 *
 * 顺序**必须**是：先转 `\`（否则后面补的反斜杠会被二次转义），再转 `{` `}`，
 * 最后把真换行换成 `\N`（ASS 的换行标记）—— **不能**留物理换行，
 * 否则会把 Dialogue 事件行切断（一条事件变成两行，ASS 直接损坏）。
 *
 * 弹幕（danmaku.js）与字幕（subtitle.js）共用这一份实现。
 */
export function escapeAssText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

/**
 * Windows 保留设备名（带不带扩展名都不允许作为文件名）。
 *
 * 分隔符除了 `.` 还要认**空格**：Windows 会把 "CON .txt" 也当成设备名，
 * 而旧正则 `(\.|$)` 匹配不到空格形式（v1.4.22 修复）。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|\s|$)/i;

/** 去掉文件名中的非法字符，并限制长度。 */
export function sanitizeFilename(name, { replacement = '_', maxLength = 120 } = {}) {
  let out = String(name ?? '')
    // 目录分隔符与 Windows 非法字符；控制字符一并清掉
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, replacement)
    // Unicode 双向覆盖字符：可被用来做文件名欺骗（看起来是 .mp4 实际后缀在前）
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 去掉开头的点：既避免产生隐藏文件，也让 "../" 这类输入
    // 在分隔符被替换成 "_" 之后（".._"）不再残留成可疑文件名
    .replace(/^[.\s]+/, '')
    .replace(/[. ]+$/, '');
  // 保留设备名（con / nul / com1 …）在 Windows 上写盘会失败，加下划线前缀规避
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  if (out.length > maxLength) out = truncateKeepExtension(out, maxLength);
  // 只剩下 . _ - 空白的名字没有有效信息，统一兜底
  if (!out || !/[^\s._-]/.test(out)) return 'untitled';
  return out;
}

/**
 * 截断到 maxLength，但**保住末尾扩展名**，且不切出孤立代理项。
 *
 * 为什么必须保扩展名：调用方（`engine.js` 的 createOutput / finishOutput）传进来的是
 * 已经拼好后缀的完整文件名，如 `${task.filename}.mp4`。标题一长（中文标题很容易 >120 字），
 * 旧的 `out.slice(0, maxLength)` 会把 `.mp4` 整个切掉 —— 产物是**没有扩展名的文件**，
 * 播放器和 Jellyfin 都识别不了，而用户只会看到"下载成功了但打不开"。
 *
 * 为什么不能切出孤立代理项：emoji 等增补平面字符占两个 UTF-16 码元，
 * 正好从中间切开会留下一个孤立的高代理项，产出非法字符串（实测 '😀'×70 → 末位 0xDE00）。
 */
function truncateKeepExtension(out, maxLength) {
  // 末尾形如 ".mp4" / ".danmaku.ass" 的扩展名（最多 20 字符，避免把整个长名字当扩展名）
  const extMatch = out.match(/\.[^.\\/]{1,20}$/);
  const ext = extMatch && extMatch[0].length < maxLength ? extMatch[0] : '';
  const keep = Math.max(1, maxLength - ext.length);
  let base = ext ? out.slice(0, out.length - ext.length) : out;
  let result = base.slice(0, keep) + ext;

  // 丢掉可能跨在高代理项上的半个字符
  const last = result.charCodeAt(result.length - ext.length - 1);
  const dropSurrogate = ext
    ? (last >= 0xd800 && last <= 0xdbff)
    : (result.charCodeAt(result.length - 1) >= 0xd800 && result.charCodeAt(result.length - 1) <= 0xdbff);
  if (dropSurrogate) {
    const head = result.slice(0, result.length - ext.length - 1);
    result = head + ext;
  }

  return result.trim().replace(/[. ]+$/, '') || (ext ? `untitled${ext}` : '');
}

/** 解析 `1-3` / `1-` / `-3` / `5` 形式的分P选择表达式。 */
export function parseRangeExpr(expr, total) {
  const text = String(expr ?? '').trim();
  if (!text) return Array.from({ length: total }, (_, i) => i + 1);
  const picked = new Set();
  for (const part of text.split(/[,，\s]+/).filter(Boolean)) {
    if (part.includes('-')) {
      const [a, b] = part.split('-');
      let start = a.trim() ? parseInt(a, 10) : 1;
      let end = b.trim() ? parseInt(b, 10) : total;
      if (Number.isNaN(start)) start = 1;
      if (Number.isNaN(end)) end = total;
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i++) if (i >= 1 && i <= total) picked.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= total) picked.add(n);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/** 从文本中提取 BV 号 / av 号。 */
export function extractVideoId(text) {
  const s = String(text ?? '');
  const bv = s.match(/(BV[0-9A-Za-z]{10})/);
  if (bv) return { bvid: bv[1] };
  const av = s.match(/\/av(\d+)/i) || s.match(/^av(\d+)$/i) || s.match(/[?&]aid=(\d+)/);
  if (av) return { aid: Number(av[1]) };

  // ★ 课程（pugv）必须**先于**通用 /ep、/ss 判断。
  //
  // 课程链接形如 https://www.bilibili.com/cheese/play/ep123 。若先走通用
  // `/ep(\d+)`，它会被解析成 `{epId: 123}` —— 于是 api.playurl 走 pgc 分支、
  // 打到 /pgc/player/web/v2/playurl（错误的端点），课程任务必然失败。
  // 代码库里 pugv 支持（FNVAL_PUGV / cheeseSeason / engine 透传 cheeseId）
  // 一直是完整的，唯独 URL 解析这一环缺失，导致那条链路从 UI 根本走不到。
  const cheeseEp = s.match(/\/cheese\/play\/ep(\d+)/i);
  if (cheeseEp) return { cheeseId: Number(cheeseEp[1]) };
  // 课程 season（/cheese/play/ss<id>）也归到 cheeseId 通道：
  // B 站的 /pugv/view/web/season 用 ep_id 查询，拿 ss 去查会失败 ——
  // 所以这里只做识别，具体取集由 popup 的 cheeseSeason 逻辑处理。
  const cheeseSs = s.match(/\/cheese\/play\/ss(\d+)/i);
  if (cheeseSs) return { cheeseId: Number(cheeseSs[1]) };

  const ep = s.match(/\/ep(\d+)/i) || s.match(/[?&]ep_id=(\d+)/);
  if (ep) return { epId: Number(ep[1]) };
  const ss = s.match(/\/ss(\d+)/i) || s.match(/[?&]season_id=(\d+)/);
  if (ss) return { seasonId: Number(ss[1]) };
  return null;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 把 `{a}_{b}` 模板中的占位符替换掉，未提供的变量保留为空串。 */
export function applyTemplate(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

export function formatNumber(n, total) {
  const width = String(total).length;
  return String(n).padStart(width, '0');
}

export function dateVars(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    year: d.getFullYear(),
    month: p(d.getMonth() + 1),
    day: p(d.getDate()),
    hour: p(d.getHours()),
    minute: p(d.getMinutes()),
    second: p(d.getSeconds()),
  };
}

/**
 * HTML 转义。
 *
 * 凡是来自 B 站接口的文本（视频标题、分 P 标题、UP 主名、简介……）在写入
 * innerHTML 之前必须先过这一层。这些字段由 UP 主完全可控，若不转义，
 * 一个恶意投稿标题就能在 chrome-extension:// 源下执行脚本，进而读取
 * chrome.storage、调用扩展内部消息通道。
 */
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/**
 * B 站自有域名后缀。用于判断"这个 URL 能不能带凭证请求"。
 *
 * 为什么需要：`/x/player/wbi/v2` 返回的 `subtitle_url` 是**接口数据**，不是我们拼的常量。
 * 若直接 `fetch(url, { credentials: 'include' })` 而不校验域名，等于
 * "对任意可控 URL 发起带凭证的请求" —— 攻击者只要能影响该字段（改包、恶意镜像、
 * 中间人未启用 HSTS 时），就能借扩展之手向自己的域名发带 Cookie 的请求。
 * Cookie 虽按域隔离（不会直接泄露 B 站 SESSDATA），但仍是应当堵住的转发面。
 */
const BILI_HOST_SUFFIXES = [
  'bilibili.com',
  'bilibili.tv',
  'hdslb.com',
  'biliapi.net',
  'bilivideo.com',
  'bilivideo.cn',
];

/**
 * 音视频**下载地址**的域名白名单。
 *
 * ★ 必须比 BILI_HOST_SUFFIXES 多一个 `akamaized.net`：
 *   它是 B 站用的 akamai CDN 域，manifest 的 `host_permissions` 与 DNR 规则 1
 *   都声明了它，但 BILI_HOST_SUFFIXES 里没有。直接拿 BILI_HOST_SUFFIXES 去过滤
 *   播放地址，会把**合法的 akamai 备用 CDN** 全滤掉，造成下载直接失败。
 *
 * 为什么播放地址要单独一套白名单：接口返回的 `base_url` / `backup_url` 此前
 * 只做了 `http://` → `https://` 替换，**没有任何域名校验**，等于响应体里写什么
 * 我们就去请求什么。后果是：
 *   - 用户只授权了 6 个 B 站域（见 manifest），代码却能打任意域 —— 权限声明与实际行为不符
 *   - 真实 IP / 真实 UA / `Origin: chrome-extension://<id>` 外泄到第三方
 *   - 可被指向内网地址（如 `169.254.169.254` 元数据服务）做探测
 * 下载地址不带 Cookie（`credentials: 'omit'`），所以最大的一块（B 站登录态）没有外泄，
 * 但上面这些仍然成立。
 */
const MEDIA_HOST_SUFFIXES = [...BILI_HOST_SUFFIXES, 'akamaized.net'];

/**
 * 把接口给的 URL 规整成**可安全带凭证请求**的形式。
 *
 * 做三件事：
 *   1. `//host/path` → `https://host/path`（协议相对 URL）
 *   2. **强制 https** —— 明文 http 下带 Cookie 等于把凭证放上网线
 *   3. 域名必须在 B 站自有域白名单内
 *
 * @param {string} rawUrl
 * @param {{ suffixes?: string[] }} [opts] 域名白名单，默认 BILI_HOST_SUFFIXES。
 *   播放地址校验要传 MEDIA_HOST_SUFFIXES（见 safeMediaUrl）。
 * @returns {{ url: string, safe: boolean, reason?: string }}
 *   `safe=false` 表示**不应**带凭证（调用方应降级为 `credentials: 'omit'` 或跳过）
 */
export function sanitizeBiliUrl(rawUrl, { suffixes = BILI_HOST_SUFFIXES } = {}) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return { url: '', safe: false, reason: '空 URL' };

  let candidate = raw;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { url: '', safe: false, reason: '无法解析的 URL' };
  }

  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  if (parsed.protocol !== 'https:') {
    return { url: '', safe: false, reason: `不支持的协议：${parsed.protocol}` };
  }

  const host = parsed.hostname.toLowerCase();
  const ok = suffixes.some((s) => host === s || host.endsWith(`.${s}`));
  if (!ok) return { url: parsed.toString(), safe: false, reason: `非白名单域名：${host}` };

  return { url: parsed.toString(), safe: true };
}

/**
 * 校验**音视频下载地址**（playurl 返回的 `base_url` / `backup_url`）。
 *
 * @param {string} rawUrl
 * @returns {string} 合规返回 https 形式的 URL；不合规返回 **空串**（调用方必须过滤掉）
 *
 * 注意不能直接用 `sanitizeBiliUrl` 的默认白名单 —— 见 MEDIA_HOST_SUFFIXES 的注释。
 */
export function safeMediaUrl(rawUrl) {
  const { url, safe } = sanitizeBiliUrl(rawUrl, { suffixes: MEDIA_HOST_SUFFIXES });
  return safe ? url : '';
}

export function log(...args) {
  console.log('%c[Bdown]', 'color:#00a1d6;font-weight:bold', ...args);
}

/**
 * 清洗日志参数里的控制字符。
 *
 * 日志内容（视频标题 / 接口错误信息 / 文件名）部分来自 B 站返回，
 * 若含 
 会让 DevTools 里的一行日志被"回车"截断覆盖 —— 不是安全漏洞，
 * 但会让排障信息失真。这里统一替换成可见转义。
 */
/**
 * 清洗日志参数里的控制字符。
 *
 * 日志内容（视频标题 / 接口错误信息 / 文件名）部分来自 B 站返回，
 * 若含回车等控制字符会让 DevTools 里的一行日志被截断覆盖 —— 不是安全漏洞，
 * 但会让排障信息失真。这里统一替换成可见转义。
 */
function sanitizeLogArgs(args) {
  return args.map((a) => {
    if (typeof a !== 'string') return a;
    // 用字符码构造正则，避免在源码里出现反斜杠转义
    // （写  这类转义会被工具链解释成真正的控制字符，把文件写坏）
    const ctrl = new RegExp(
      '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
      'g',
    );
    return a.replace(ctrl, (ch) => '<0x' + ch.charCodeAt(0).toString(16).padStart(2, '0') + '>');
  });
}

export function warn(...args) {
  console.warn('%c[Bdown]', 'color:#f5a623;font-weight:bold', ...sanitizeLogArgs(args));
}
