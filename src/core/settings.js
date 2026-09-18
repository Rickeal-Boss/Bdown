/**
 * 文件名模板与设置存储。
 */

import { applyTemplate, sanitizeFilename, formatNumber, dateVars } from './util.js';

export const DEFAULT_SETTINGS = {
  /** 单P（普通视频）命名模板 */
  singleNameTemplate: '{title}',
  /** 多P/合集命名模板 */
  batchNameTemplate: '{title}_P{n}_{part}',
  /** 是否在文件名中保留清晰度 */
  nameWithQuality: false,
  /** 清晰度后缀模板 */
  qualitySuffix: '_{qualityShort}',

  /** 默认清晰度：0 = 自动选最高可用 */
  defaultQuality: 0,
  /** 编码偏好 */
  preferCodec: 'avc',
  /** 音轨偏好：'best' | 'lossless' | 'normal' */
  audioPreference: 'best',

  /** 下载方式 */
  downloadMode: 'merge', // merge | separate | durl
  /** 并发分片数 */
  concurrency: 8,
  /** 失败重试次数 */
  retries: 2,

  /** 附加内容 */
  saveCover: false,
  saveDanmaku: true,
  danmakuFormat: 'ass', // ass | xml | srt | txt
  saveSubtitle: false,
  subtitleFormat: 'srt', // srt | ass | txt
  subtitleLan: 'zh-CN',

  /** 弹幕 ASS 参数 */
  danmakuOpacity: 0.85,
  danmakuFontScale: 1,
  danmakuFontName: 'Microsoft YaHei',
  danmakuWidth: 1920,
  danmakuHeight: 1080,

  /** 下载完成后的行为 */
  notifyOnComplete: true,
  /** 保存方式：'ask' 每次询问 | 'downloads' 直接交给浏览器下载目录 */
  saveMode: 'ask',

  /** 并发任务数 */
  maxParallelTasks: 2,

  /** 是否在视频页显示悬浮按钮 */
  showFloatingButton: true,
  /** 是否在播放器工具栏注入下载按钮 */
  showPlayerButton: true,
};

const KEYS = Object.keys(DEFAULT_SETTINGS);

/** 读取全部设置（合并默认值）。 */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(KEYS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** 写入部分设置。 */
export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

/** 监听设置变化。 */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    for (const [k, v] of Object.entries(changes)) {
      if (KEYS.includes(k)) patch[k] = v.newValue;
    }
    if (Object.keys(patch).length) callback(patch);
  };
  chrome.storage.local.onChanged.addListener(listener);
  return () => chrome.storage.local.onChanged.removeListener(listener);
}

/**
 * 生成文件名（不含扩展名）。
 *
 * 可用变量：
 *   {title} {part} {n} {p} {bvid} {aid} {cid} {user} {userID}
 *   {quality} {qualityShort} {codec} {duration}
 *   {year} {month} {day} {hour} {minute} {second}
 *
 * @param {object} o
 * @param {object} o.settings
 * @param {object} o.vars
 * @param {boolean} [o.isBatch]
 * @param {number} [o.quality]
 * @param {string} [o.qualityShort]
 * @param {string} [o.codec]
 */
export function buildFilename({ settings, vars, isBatch = false, quality, qualityShort, codec }) {
  const template = isBatch ? settings.batchNameTemplate : settings.singleNameTemplate;
  const allVars = { ...vars };
  if (quality) allVars.quality = quality;
  if (qualityShort) allVars.qualityShort = qualityShort;
  if (codec) allVars.codec = codec;

  let name = applyTemplate(template, allVars);
  if (settings.nameWithQuality && qualityShort) {
    name += applyTemplate(settings.qualitySuffix, allVars);
  }
  return sanitizeFilename(name);
}

/**
 * 从视频信息 + 分P信息构造模板变量。
 * @param {object} o
 */
export function buildVars({ info, page, index, total }) {
  const dv = dateVars(info.pubdate || Math.floor(Date.now() / 1000));
  const pages = info.pages || [];
  const n = page?.page ?? index + 1;
  return {
    title: info.title || 'untitled',
    part: page?.part || '',
    n: formatNumber(n, total || pages.length || n),
    p: n,
    bvid: info.bvid || '',
    aid: info.aid || '',
    cid: page?.cid || '',
    user: info.owner?.name || '',
    userID: info.owner?.mid || '',
    duration: page?.duration || info.duration || '',
    ...dv,
  };
}
