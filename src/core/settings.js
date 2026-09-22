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
  downloadMode: 'merge', // merge | separate | audio | durl
  /** 并发分片数 */
  concurrency: 8,
  /** 失败重试次数 */
  retries: 2,

  /** 附加内容 */
  saveCover: false,
  saveDanmaku: true,
  danmakuFormat: 'ass', // ass | xml | srt | txt
  saveSubtitle: false,
  /** 章节（view_points）—— 与字幕共用同一次请求，开启几乎零成本 */
  saveChapters: false,
  /** NFO 元数据（Jellyfin / Kodi 归档）。用的是已取到的 view 数据，零额外请求 */
  saveNfo: false,
  /** 章节格式：txt（YouTube 风格）或 vtt（WebVTT 章节轨） */
  chapterFormat: 'txt',
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
  /** 断点续传：默认关闭（浏览器端行为还没法在 CI 里验证，开启后如异常请关掉） */
  resumeEnabled: false,

  /** 是否在视频页显示悬浮按钮 */
  showFloatingButton: true,
  /** 是否在播放器工具栏注入下载按钮 */
  showPlayerButton: true,
};

const KEYS = Object.keys(DEFAULT_SETTINGS);

/** DEFAULT_SETTINGS 里类型是 number 的字段名（用于读取时做归一化）。 */
const NUMERIC_KEYS = KEYS.filter((k) => typeof DEFAULT_SETTINGS[k] === 'number');

/** 读取全部设置（合并默认值）。 */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(KEYS);
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // 归一化数值字段：chrome.storage 不改类型，但 options/popup 的
  // select / input 直接 .value 时是**字符串**，写盘后再读回仍是字符串。
  // 这对大多数字段无害，但对清晰度相关字段（如 defaultQuality）极危险：
  //   - JS 里 `!"0" === false`（非空字符串是 truthy）
  //   - 所以 `if (!quality)` 不会把字符串 "0" 识别为"自动"
  //   - 直接走到降级分支，accept 最小档（360P）就成了默认结果
  // 统一 Number()，让所有下游逻辑（buildPlan 等）拿到的都是数字。
  for (const k of NUMERIC_KEYS) {
    if (merged[k] !== undefined && merged[k] !== null && merged[k] !== '') {
      const n = Number(merged[k]);
      if (Number.isFinite(n)) merged[k] = n;
    }
  }
  return merged;
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

/**
 * 按「下载方式」给出保存对话框的建议文件名与类型过滤。
 *
 * 「仅音频」时必须建议音频扩展名：该模式是 singleOutput，engine 会直接写进
 * 用户选中的句柄，建议名错了的话磁盘文件名与面板显示就会不一致。
 *
 * ⚠️ 无法在这里精确判定无损与否：本函数在 run() 之前被调用，此时 `plan` 尚未建立、
 * 音轨的 `mimeType` 也还没取到。所以 `suggested` 恒为 `.m4a`，而 `types` 里同时给出
 * `.m4a` / `.flac` 两种扩展名，由用户按实际音质在保存对话框里手动选择 —— description
 * 里明确提示这一点，不做做不到的承诺。
 *
 * @param {string} mode downloadMode（merge | separate | audio | durl）
 * @param {string} name 不含扩展名的文件名
 */
export function savePickerHint(mode, name) {
  if (mode === 'audio') {
    return {
      // 无损轨请手动改为 .flac：此处拿不到音轨类型，无法自动判断（见上方注释）
      suggested: `${name}.m4a`,
      types: [
        {
          description: '音频文件（Hi-Res 无损轨请手动改为 .flac）',
          accept: { 'audio/mp4': ['.m4a'], 'audio/flac': ['.flac'] },
        },
      ],
    };
  }
  if (mode === 'separate') {
    return {
      suggested: `${name}.video.mp4`,
      types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
    };
  }
  return {
    suggested: `${name}.mp4`,
    types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
  };
}

/**
 * 弹窗「下载方式」四模式的一句话说明。
 *
 * ★ 抽成**单一来源**常量。此前这段文案在 popup.js 里抄了两份（render() 与
 * radio 的 change 事件），改一处忘另一处必然漂移 —— 已经漂移过一次。
 *
 * ⚠️ 措辞纪律：不得写「直接可播」「实测可用」「已真机验证」这类对**未真机验证**
 * 行为的承诺。仅音频产物扩展名由音轨真实类型决定（见 engine.js 的
 * audioOutputMeta()）：普通 AAC / 杜比 → `.m4a`，Hi-Res 无损 → `.flac`。
 */
export const MODE_HINTS = {
  merge: '下载 DASH 音视频后无损合并为单个 MP4（推荐，支持全部清晰度）',
  separate: '分别保存 video.mp4 与 audio.m4a，自行用播放器/ffmpeg 处理',
  audio: '只下载音轨，不转码；普通音轨存 .m4a，Hi-Res 无损存 .flac',
  durl: '直接下载单文件 MP4，无需合并；但清晰度上限较低（通常 720P/1080P）',
};

/**
 * 选了「仅音频」、但该视频**没有独立音轨**时的提示。
 *
 * ⚠️ 不得承诺「将下载完整视频」：engine.js 的 buildPlan 在 audio 模式下
 * `if (!audio) throw new Error(...)` 是**无条件抛错**，实际什么都下不了、
 * 任务直接转 error。承诺会退回去下完整视频是彻底的假话。
 * 这里只给**可操作**的替代指引（让用户自己改模式）。
 */
export const AUDIO_UNAVAILABLE_HINT =
  '⚠ 该视频没有独立音轨（多为老视频/单文件直下），无法只下载音频，请在上方改用「合并为 MP4」';

/**
 * 按下载方式估算某一清晰度档的产物体积（字节）—— 弹窗「预计 X MB」的唯一口径。
 *
 * 抽成纯函数的理由：
 *   ① 体积**随下载方式变化**（仅音频只下音轨）。这个口径必须能被单测锁定，
 *      否则「切换模式后列表体积不刷新」这类缺陷只能靠肉眼看出来。
 *   ② 之前这段判断内联在 popup.js 的 buildQualityOptions() 里，DOM 模块无法在
 *      Node 里 import，等于零测试覆盖。
 *
 * ⚠️ 调用方在**切换下载方式后必须重算**这些体积：仅音频与合并的口径相差一个视频轨，
 *    不重算的话列表会显示比实际产物大一个数量级的数字。
 *
 * @param {string} mode downloadMode（merge | separate | audio | durl）
 * @param {number|undefined} videoSize 该档视频轨体积；该档无视频轨时传 undefined
 * @param {number|undefined} audioSize 所选音轨体积
 */
export function estimateSizeBytes(mode, videoSize, audioSize) {
  const audio = Number(audioSize) || 0;
  // 仅音频：产物只有音轨，视频轨完全不下 —— 只算音轨。
  if (mode === 'audio') return audio;
  // 其余模式都要下视频轨：该档没有视频轨即不可用，体积记 0（不返回 NaN）。
  const video = Number(videoSize) || 0;
  return video ? video + audio : 0;
}
