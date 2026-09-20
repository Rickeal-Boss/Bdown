/**
 * 弹幕处理：XML 解析 → ASS / SRT / 纯文本 / 原始 XML。
 *
 * 弹幕 XML 格式（`https://comment.bilibili.com/<cid>.xml`）：
 *   <d p="出现时间,模式,字号,颜色,时间戳,弹幕池,发送者UID,弹幕ID">正文</d>
 *
 * 模式：1/2/3 滚动（右→左）、4 底部固定、5 顶部固定、6 逆向滚动（左→右）、
 *       7 高级弹幕、8 代码弹幕、9 BAS 弹幕。
 */

import { toAssTime, toSrtTime, sanitizeFilename, escapeAssText } from './util.js';

/** 字号换算基准：B 站播放器把 25 号字渲染在约 480px 高的画布上。 */
const FONT_BASE_HEIGHT = 480;
const SCROLL_SECONDS = 8;
const FIXED_SECONDS = 4;
const DEFAULT_RES = { x: 1920, y: 1080 };

/**
 * 解析弹幕 XML。
 * @param {string} xml
 * @returns {{ list: DanmakuItem[], chatId: string }}
 */
export function parseDanmakuXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const list = [];
  const nodes = doc.getElementsByTagName('d');
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const p = node.getAttribute('p') || '';
    const parts = p.split(',');
    if (parts.length < 4) continue;
    const text = node.textContent || '';
    if (!text) continue;
    list.push({
      time: Number(parts[0]) || 0,
      mode: Number(parts[1]) || 1,
      fontSize: Number(parts[2]) || 25,
      color: Number(parts[3]) || 0xffffff,
      timestamp: Number(parts[4]) || 0,
      pool: Number(parts[5]) || 0,
      uid: parts[6] || '',
      id: parts[7] || '',
      text: text.replace(/\r?\n/g, ' '),
    });
  }
  const chatId = doc.getElementsByTagName('chatid')[0]?.textContent || '';
  list.sort((a, b) => a.time - b.time);
  return { list, chatId };
}

/** 十进制 RGB -> ASS 的 &HAABBGGRR& */
function assColor(rgb, alpha = 0) {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  return `&H${hex(alpha)}${hex(b)}${hex(g)}${hex(r)}&`;
}

// ASS 转义已提到 util.js 的 escapeAssText —— 字幕（subtitle.js）需要同一份实现，
// 两处各写一份迟早会不一致（而弹幕这边漏转义正是我们担心的失败形态）。
const escapeAss = escapeAssText;

/** 粗略估算文本像素宽度（中文字符按 1em，其余按 0.55em）。 */
function measure(text, fontSize) {
  let units = 0;
  for (const ch of text) {
    units += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1 : 0.55;
  }
  return units * fontSize;
}

/**
 * 车道分配器：保证同一屏内弹幕不互相重叠。
 */
class LaneAllocator {
  constructor(laneCount, gap = 2) {
    this.laneCount = Math.max(1, laneCount);
    this.gap = gap;
    /** @type {number[]} 每条车道下一次可用的时间（固定弹幕用） */
    this.freeAt = new Array(this.laneCount).fill(0);
    /** @type {number[]} 每条车道当前弹幕「完全进入屏幕」的时刻（滚动弹幕用） */
    this.laneAt = new Array(this.laneCount).fill(-Infinity);
  }

  /** 固定弹幕（顶部/底部）：时间区间不重叠即可。 */
  allocateFixed(start, end) {
    for (let i = 0; i < this.laneCount; i++) {
      if (this.freeAt[i] <= start) {
        this.freeAt[i] = end;
        return i;
      }
    }
    return -1;
  }

  /**
   * 滚动弹幕：新弹幕的尾部必须晚于同车道前一条弹幕的尾部离开屏幕。
   * @param {number} start 出现时间
   * @param {number} duration 滚动总时长
   * @param {number} enterRatio 弹幕完全进入屏幕所占时长比例
   */
  allocateScroll(start, duration, enterRatio) {
    for (let i = 0; i < this.laneCount; i++) {
      const prev = this.laneAt[i];
      if (prev === undefined || prev <= start + 1e-6) {
        this.laneAt[i] = start + duration * enterRatio;
        return i;
      }
    }
    // 找不到空车道时退化到最空闲的一条，避免丢弃弹幕
    let best = 0;
    for (let i = 1; i < this.laneCount; i++) {
      if (this.laneAt[i] < this.laneAt[best]) best = i;
    }
    this.laneAt[best] = start + duration * enterRatio;
    return best;
  }
}

/**
 * 生成 ASS 字幕。
 *
 * @param {DanmakuItem[]} list
 * @param {object} [opts]
 * @param {number} [opts.width]  画布宽
 * @param {number} [opts.height] 画布高
 * @param {number} [opts.opacity] 不透明度 0~1（1 = 完全不透明）
 * @param {number} [opts.fontScale] 字号整体缩放
 * @param {string} [opts.fontName] 字体
 * @param {boolean} [opts.bottomReserved] 底部为字幕预留区域
 * @param {string} [opts.title]
 */
export function danmakuToAss(list, opts = {}) {
  const W = opts.width || DEFAULT_RES.x;
  const H = opts.height || DEFAULT_RES.y;
  const fontScale = (opts.fontScale ?? 1) * (H / FONT_BASE_HEIGHT);
  const fontName = opts.fontName || 'Microsoft YaHei';
  const alpha = Math.round((1 - (opts.opacity ?? 0.85)) * 255);
  const alphaTag = `\\alpha&H${alpha.toString(16).padStart(2, '0').toUpperCase()}&`;

  const scrollTop = Math.round(H * 0.02);
  const bottomReserve = opts.bottomReserved === false ? 0 : Math.round(H * 0.12);
  const scrollBottom = H - bottomReserve;

  const header = `[Script Info]
; 由 Bdown - B站视频下载助手 生成
; 弹幕数量: ${list.length}
Title: ${opts.title || 'Bilibili Danmaku'}
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Danmaku,${fontName},${Math.round(25 * fontScale)},&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,7,0,0,0,1
Style: DanmakuTop,${fontName},${Math.round(25 * fontScale)},&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,8,0,0,0,1
Style: DanmakuBottom,${fontName},${Math.round(25 * fontScale)},&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // 车道数量按平均行高估算
  const avgFont = 25 * fontScale;
  const lineHeight = avgFont * 1.15;
  const laneCount = Math.max(1, Math.floor((scrollBottom - scrollTop) / lineHeight));
  const topAlloc = new LaneAllocator(Math.max(1, Math.floor(laneCount / 3)));
  const bottomAlloc = new LaneAllocator(Math.max(1, Math.floor(laneCount / 3)));
  const scrollAlloc = new LaneAllocator(laneCount);

  const lines = [];

  for (const item of list) {
    const fontSize = Math.round(item.fontSize * fontScale);
    const color = assColor(item.color, 0);
    const text = escapeAss(item.text);
    const start = item.time;
    const tags = [`\\fn${fontName}`, `\\fs${fontSize}`, `\\c${color}`, `\\bord2`, `\\shad1`, alphaTag];

    if (item.mode === 4 || item.mode === 5) {
      // 固定弹幕
      const isTop = item.mode === 5;
      const alloc = isTop ? topAlloc : bottomAlloc;
      const end = start + FIXED_SECONDS;
      const lane = alloc.allocateFixed(start, end);
      if (lane < 0) continue;
      const y = isTop
        ? scrollTop + lane * lineHeight + lineHeight / 2
        : H - bottomReserve - lane * lineHeight - lineHeight / 2;
      const pos = isTop ? `\\an8\\pos(${W / 2},${y.toFixed(0)})` : `\\an2\\pos(${W / 2},${y.toFixed(0)})`;
      lines.push(
        `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},${isTop ? 'DanmakuTop' : 'DanmakuBottom'},,0,0,0,,{${pos}${tags.join('')}}${text}`
      );
      continue;
    }

    if (item.mode === 6) {
      // 逆向滚动（左 → 右）
      const w = measure(item.text, fontSize);
      const duration = SCROLL_SECONDS * ((W + w) / W);
      const lane = scrollAlloc.allocateScroll(start, duration, w / (W + w));
      const y = scrollTop + lane * lineHeight + lineHeight / 2;
      const move = `\\move(${(-w).toFixed(0)},${y.toFixed(0)},${(W + w).toFixed(0)},${y.toFixed(0)})`;
      lines.push(
        `Dialogue: 0,${toAssTime(start)},${toAssTime(start + duration)},Danmaku,,0,0,0,,{${move}${tags.join('')}}${text}`
      );
      continue;
    }

    if (item.mode === 7 || item.mode === 8 || item.mode === 9) {
      // 高级/代码/BAS 弹幕：原样保留文本，用固定位置兜底
      const lane = topAlloc.allocateFixed(start, start + FIXED_SECONDS);
      if (lane < 0) continue;
      const y = scrollTop + lane * lineHeight + lineHeight / 2;
      lines.push(
        `Dialogue: 0,${toAssTime(start)},${toAssTime(start + FIXED_SECONDS)},DanmakuTop,,0,0,0,,{\\an8\\pos(${W / 2},${y.toFixed(0)})${tags.join('')}}${text}`
      );
      continue;
    }

    // 默认：滚动弹幕（右 → 左）
    const w = measure(item.text, fontSize);
    const duration = SCROLL_SECONDS * ((W + w) / W);
    const lane = scrollAlloc.allocateScroll(start, duration, w / (W + w));
    const y = scrollTop + lane * lineHeight + lineHeight / 2;
    const move = `\\move(${W.toFixed(0)},${y.toFixed(0)},${(-w).toFixed(0)},${y.toFixed(0)})`;
    lines.push(
      `Dialogue: 0,${toAssTime(start)},${toAssTime(start + duration)},Danmaku,,0,0,0,,{${move}${tags.join('')}}${text}`
    );
  }

  return header + lines.join('\n') + '\n';
}

/** 弹幕转 SRT（每条弹幕独立一行，适合做「台词式」回顾）。 */
export function danmakuToSrt(list) {
  return list
    .map((item, i) => {
      const end = Math.max(item.time + 1.2, item.time + 0.5);
      return `${i + 1}\n${toSrtTime(item.time)} --> ${toSrtTime(end)}\n${item.text}\n`;
    })
    .join('\n');
}

/** 弹幕转纯文本（时间 + 内容）。 */
export function danmakuToText(list) {
  return list
    .map((item) => `[${toAssTime(item.time)}] ${item.text}`)
    .join('\n');
}

/** 过滤 + 去重，用于「只保留特定弹幕」。 */
export function filterDanmaku(list, { maxLength = 0, blockWords = [], dedupe = false } = {}) {
  const blocked = blockWords.filter(Boolean);
  const seen = new Set();
  return list.filter((item) => {
    if (maxLength > 0 && item.text.length > maxLength) return false;
    if (blocked.some((w) => item.text.includes(w))) return false;
    if (dedupe) {
      const key = `${item.text}@${Math.round(item.time)}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

export function danmakuFilename(base, ext) {
  return `${sanitizeFilename(base)}.${ext}`;
}

/**
 * @typedef {object} DanmakuItem
 * @property {number} time 出现时间（秒）
 * @property {number} mode 模式
 * @property {number} fontSize 字号
 * @property {number} color 颜色（十进制 RGB）
 * @property {number} timestamp
 * @property {number} pool
 * @property {string} uid
 * @property {string} id
 * @property {string} text
 */
