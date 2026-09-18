/**
 * 通用工具函数。
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带指数退避的重试。 */
export async function retry(fn, { times = 3, baseDelay = 400, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === times - 1) break;
      if (onRetry) onRetry(err, i + 1);
      await sleep(baseDelay * 2 ** i);
    }
  }
  throw lastErr;
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

/** Windows 保留设备名（带不带扩展名都不允许作为文件名）。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

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
  if (out.length > maxLength) out = out.slice(0, maxLength).trim().replace(/[. ]+$/, '');
  // 只剩下 . _ - 空白的名字没有有效信息，统一兜底
  if (!out || !/[^\s._-]/.test(out)) return 'untitled';
  return out;
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

export function log(...args) {
  console.log('%c[Bdown]', 'color:#00a1d6;font-weight:bold', ...args);
}

export function warn(...args) {
  console.warn('%c[Bdown]', 'color:#f5a623;font-weight:bold', ...args);
}
