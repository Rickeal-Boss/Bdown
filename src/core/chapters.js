/**
 * 视频章节（chapters）解析与导出。
 *
 * 数据来源：`/x/player/wbi/v2` -> `data.view_points[]`。
 * **我们本来就在调这个接口取字幕**（`api.playerV2`），所以取章节是**零额外请求**。
 *
 * 实测（BV16s7b68EEz，无章节的视频）：`view_points: []`。
 * 有章节时元素结构（B 站未公开文档，按社区惯例兼容多种字段名）：
 *   { type?, from, to?, content } / { start?, end?, title? } / { time?, text? }
 *
 * 导出两种格式：
 *   - `chapters.txt`：YouTube 风格 `0:00 标题`，通用性最好
 *   - `chapters.vtt`：WebVTT CHAPTERS，PotPlayer / mpv / VLC 可识别
 */

/** 把秒/毫秒/字符串都规整成「秒」。非法返回 null。 */
function toSeconds(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  // B 站这里通常给秒；数值大得离谱（> 1e6）当成毫秒处理
  return n > 1e6 ? n / 1000 : n;
}

/**
 * 把任意形态的 view_points 规整成 `[{ start, end, content }]`（单位：秒）。
 * 无法解析的条目丢弃，不抛异常。
 *
 * @param {unknown} raw `data.view_points`
 * @param {{ duration?: number }} [opts] 总时长（秒），用于补全最后一条的 end
 * @returns {{start:number, end:number|null, content:string}[]} 按 start 升序
 */
export function parseViewPoints(raw, { duration } = {}) {
  if (!Array.isArray(raw) || !raw.length) return [];

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const content = String(item.content ?? item.title ?? item.text ?? '').trim();
    const start = toSeconds(item.from ?? item.start ?? item.time);
    if (start === null || !content) continue;
    const end = toSeconds(item.to ?? item.end);
    out.push({ start, end: end !== null && end > start ? end : null, content });
  }

  out.sort((a, b) => a.start - b.start);

  // 补全 end：没有就用下一条的 start；最后一条用总时长
  const total = Number(duration) > 0 ? Number(duration) : null;
  for (let i = 0; i < out.length; i++) {
    if (out[i].end === null) out[i].end = i + 1 < out.length ? out[i + 1].start : total;
  }
  return out;
}

/** 秒 -> `H:MM:SS` / `M:SS` */
export function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}

/** 秒 -> `HH:MM:SS.mmm`（WebVTT 用） */
export function formatVttTimestamp(seconds) {
  const n = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  const ms = Math.round((n - Math.floor(n)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** 导出 YouTube 风格 chapters.txt */
export function chaptersToTxt(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) return '';
  return `${list.map((c) => `${formatTimestamp(c.start)} ${cleanChapterText(c.content)}`).join('\n')}\n`;
}

/** 导出 WebVTT 章节轨 */
export function chaptersToVtt(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) return 'WEBVTT\n';
  const lines = ['WEBVTT', ''];
  for (const c of list) {
    const end = c.end !== null && c.end !== undefined ? c.end : c.start + 1;
    lines.push(formatVttTimestamp(c.start));
    lines.push(`${formatVttTimestamp(c.start)} --> ${formatVttTimestamp(end)}`);
    lines.push(cleanChapterText(c.content));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * v1.4.29 安全审查 F-003：章节标题（UP 主可控）此前原样写入导出文件 ——
 * 内容含空行会把 VTT cue / TXT 条目切开，产出结构损坏的章节文件。
 * 对照：SRT 有 normalizeSrtText 空行折叠、弹幕文本有换行折叠、NFO 全字段
 * 转义，唯独章节漏了同款清洗。与 normalizeSrtText 同口径：去 \r、折叠连续空行。
 */
function cleanChapterText(s) {
  return String(s ?? '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n');
}
// v1.4.29 数据一致性 F11：CHAPTER_TXT_NAME / CHAPTER_VTT_NAME 导出常量全库
// 零引用（engine.fetchExtras 手工拼文件名），删除。
