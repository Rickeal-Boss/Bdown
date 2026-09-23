/**
 * 字幕处理。
 *
 * B 站字幕接口：`GET /x/player/wbi/v2?bvid=&cid=` → data.subtitle.subtitles[]
 * 每项形如 { id, lan, lan_doc, subtitle_url }，subtitle_url 指向一个 JSON：
 *   { font_size, font_color, background_alpha, background_color, Stroke,
 *     body: [ { from, to, location, content }, ... ] }
 *
 * 注意：字幕多为 AI 生成，需要登录后才能取到（need_login_subtitle）。
 */

import { toAssTime, toSrtTime, escapeAssText } from './util.js';

/**
 * @param {any} json subtitle_url 返回的 JSON
 * @param {{ lan?: string, lanDoc?: string }} [meta]
 */
export function parseSubtitleJson(json, meta = {}) {
  const body = Array.isArray(json?.body) ? json.body : [];
  return {
    lan: meta.lan || '',
    lanDoc: meta.lanDoc || '',
    items: body.map((it) => ({
      from: Number(it.from) || 0,
      to: Number(it.to) || 0,
      location: Number(it.location) || 2,
      // ★ 折叠连续空行：SRT **以空行分隔块**，字幕文本里若含 "\n\n"
      //   会被解析成两个块 → 整份 SRT 结构损坏（实测 3 条字幕产出 4 块，
      //   块序变成 ["1","2","第二段","3"]）。单个换行是合法的多行字幕，保留。
      content: String(it.content ?? '').replace(/\r?\n(\s*\r?\n)+/g, '\n').trim(),
    })),
  };
}

/**
 * 归一化字幕文本，使其**可以安全地放进 SRT 块**。
 *
 * SRT 以**空行**分隔块。文本里若含连续换行（`\n\n`），会被解析器切成两个块
 * → 整份 SRT 结构损坏（实测 3 条字幕产出 4 块，块序变成 ["1","2","第二段","3"]）。
 * 单个换行是合法的多行字幕，保留。
 */
function normalizeSrtText(text) {
  return String(text ?? '').replace(/\r?\n(\s*\r?\n)+/g, '\n').trim();
}

export function subtitleToSrt(subtitle) {
  return subtitle.items
    .map((it, i) => `${i + 1}\n${toSrtTime(it.from)} --> ${toSrtTime(it.to)}\n${normalizeSrtText(it.content)}\n`)
    .join('\n');
}

export function subtitleToText(subtitle) {
  return subtitle.items.map((it) => it.content).join('\n');
}

/**
 * 转 ASS。`bilingual` 为 true 时，若传入两条字幕（原文 + 译文）会做上下双行显示。
 * @param {object} subtitle
 * @param {{ title?: string, width?: number, height?: number, secondary?: object }} [opts]
 */
export function subtitleToAss(subtitle, opts = {}) {
  const W = opts.width || 1920;
  const H = opts.height || 1080;
  const header = `[Script Info]
; 由 Bdown - B站视频下载助手 生成
Title: ${(opts.title || 'Bilibili Subtitle').replace(/[\r\n]+/g, ' ')}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,${Math.round(H / 22)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1
Style: Secondary,Microsoft YaHei,${Math.round(H / 26)},&H00E0E0E0,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,16,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const secondary = opts.secondary;
  const findSecondary = (item) => {
    if (!secondary) return null;
    // 取时间重叠度最高的那条作为译文
    let best = null;
    let bestOverlap = 0;
    for (const other of secondary.items) {
      const overlap = Math.min(item.to, other.to) - Math.max(item.from, other.from);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = other;
      }
    }
    return bestOverlap > 0 ? best : null;
  };

  // ★ 字幕文本必须转义（与弹幕同规格，共用 util.escapeAssText）。
  // ASS 里 { } \ 是控制字符、物理换行会把 Dialogue 事件行切断 ——
  // 不转义会产出结构损坏的 ASS。
  const lines = subtitle.items.map((it) => {
    const content = escapeAssText(it.content);
    const pair = findSecondary(it);
    if (pair) {
      const second = escapeAssText(pair.content);
      return `Dialogue: 0,${toAssTime(it.from)},${toAssTime(it.to)},Default,,0,0,0,,${content}\nDialogue: 1,${toAssTime(it.from)},${toAssTime(it.to)},Secondary,,0,0,0,,${second}`;
    }
    return `Dialogue: 0,${toAssTime(it.from)},${toAssTime(it.to)},Default,,0,0,0,,${content}`;
  });

  return header + lines.join('\n') + '\n';
}

/** 在字幕列表中挑出最合适的一条（优先中文，其次人工字幕）。 */
export function pickSubtitle(subtitles, preferLan = 'zh-CN') {
  if (!subtitles?.length) return null;
  const score = (s) => {
    const lan = String(s.lan || '');
    const doc = String(s.lan_doc || '');
    let n = 0;
    if (lan === preferLan) n += 100;
    // ★ 中文判定不能只看 `startsWith('zh')`：B 站 **AI 中文字幕的 lan 是 `ai-zh`**，
    //   它不以 zh 开头，旧逻辑因此拿不到任何中文加成 —— 视频若同时有
    //   `ai-zh` 与 `en-US`，默认偏好 zh-CN 时两者同分，谁在数组前面谁赢，
    //   用户"偏好中文"的设置等于失效。改为"含 zh"判定，覆盖 ai-zh / zh-CN / zh-Hans。
    if (/zh/i.test(lan) || /中文|Chinese/i.test(doc)) n += 50;
    // 人工字幕优于 AI 字幕
    if (!/ai/i.test(lan) && !/自动/.test(doc)) n += 20;
    if (s.type === 0 || s.type === undefined) n += 5;
    return n;
  };
  return [...subtitles].sort((a, b) => score(b) - score(a))[0];
}
