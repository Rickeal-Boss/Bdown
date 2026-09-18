/**
 * 清晰度 / 编码 / 音轨 元数据表。
 *
 * 数值来源：SocialSisterYi/bilibili-API-collect（playurl 文档）、yt-dlp、Bilibili-Evolved，
 * 并与真实接口返回的 accept_quality / support_formats 做过比对。
 */

/** 视频清晰度（qn / dash.video[].id）。 */
export const QUALITIES = {
  127: { label: '8K 超高清', short: '8K', vip: true },
  126: { label: '杜比视界', short: 'Dolby Vision', vip: true },
  125: { label: 'HDR 真彩', short: 'HDR', vip: true },
  120: { label: '4K 超清', short: '4K', vip: true },
  116: { label: '1080P60 高帧率', short: '1080P60', vip: true },
  112: { label: '1080P 高码率', short: '1080P+', vip: true },
  100: { label: '智能修复', short: 'AI', vip: true },
  80: { label: '1080P 高清', short: '1080P', login: true },
  74: { label: '720P60 高帧率', short: '720P60', login: true },
  64: { label: '720P 准高清', short: '720P' },
  32: { label: '480P 标清', short: '480P' },
  16: { label: '360P 流畅', short: '360P' },
  6: { label: '240P 极速', short: '240P' },
};

/** DASH 编码 id（dash.video[].codecid）。 */
export const CODECS = {
  7: { name: 'AVC', full: 'AVC / H.264', desc: '兼容性最好，体积偏大' },
  12: { name: 'HEVC', full: 'HEVC / H.265', desc: '体积适中，兼容性一般' },
  13: { name: 'AV1', full: 'AV1', desc: '体积最小，兼容性中等' },
};

/** 音轨 id（dash.audio[].id）。 */
export const AUDIO_QUALITIES = {
  30216: { label: '64K', desc: '低码率' },
  30232: { label: '132K', desc: '中码率' },
  30280: { label: '192K', desc: '高码率' },
  30250: { label: '杜比全景声', desc: 'Dolby Atmos', special: true },
  30251: { label: 'Hi-Res 无损', desc: 'FLAC', special: true },
  30300: { label: 'Hi-Res 无损', desc: 'FLAC', special: true },
};

export function qualityLabel(id) {
  return QUALITIES[id]?.label || String(id);
}

export function qualityShort(id) {
  return QUALITIES[id]?.short || String(id);
}

export function codecName(codecid) {
  return CODECS[codecid]?.name || `codecid-${codecid}`;
}

export function audioLabel(id) {
  return AUDIO_QUALITIES[id]?.label || String(id);
}

export function isVipQuality(id) {
  return !!QUALITIES[id]?.vip;
}

export function isLoginQuality(id) {
  return !!QUALITIES[id]?.login;
}

/** 根据 support_formats 推断「缺少哪些清晰度」的提示。 */
export function describeMissing(acceptQuality, supportFormats) {
  const accepted = new Set(acceptQuality || []);
  const missing = (supportFormats || [])
    .filter((f) => !accepted.has(f.quality))
    .map((f) => QUALITIES[f.quality]?.label || f.new_description || f.display_desc || f.quality);
  return missing;
}

/**
 * 编码优先级（默认 AVC 优先，兼容性最好）。
 * @param {number} codecid
 * @param {'avc'|'hevc'|'av1'} prefer
 */
export function codecScore(codecid, prefer = 'avc') {
  const order = {
    avc: [7, 12, 13],
    hevc: [12, 7, 13],
    av1: [13, 12, 7],
  }[prefer] || [7, 12, 13];
  const idx = order.indexOf(codecid);
  return idx < 0 ? 99 : idx;
}
