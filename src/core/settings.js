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

/**
 * 数字型设置的**合法区间**（v1.4.30 加固）。
 *
 * 为什么必须钳制而不是只做 `Number()`：
 *   storage 里的值可能被写坏（手改 / 旧版本字段淘汰 / 同步冲突 / 别处 bug）。
 *   实测 `concurrency: "NaN"` 时下游 `Math.max(1, Math.min(16, this.settings.concurrency || 8))`
 *   会得到 NaN（`"NaN" || 8` 是非空串 truthy → "NaN" → Math.min 得 NaN → Math.max 得 NaN），
 *   于是分片 worker 循环 **0 次**，任务却标记 done —— 静默产出 0 字节文件。
 *   负数 / 0 / 超上限同理会把并发、重试、画布尺寸等推到非法状态。
 *
 * 取值策略（钳制 vs 回落默认）：
 *   - **非有限数**（NaN / Infinity / 非数字字符串）→ 回落 `DEFAULT_SETTINGS`：
 *     这类值无法表达任何"意图"，默认值最安全。
 *   - **有限但越界**（0 / 负数 / 超上限）→ **钳到最近边界**，而不是回落默认：
 *     越界值表达了明确的"方向性意图"（想更大 / 想更小），钳制比丢弃更贴近用户本意，
 *     也避免"我设了 999 怎么变回 8"的困惑。
 *   - `''` / `null` / `undefined` 视为"未设置" → 回落默认。
 *
 * 区间来源：options.html 的 min/max 提示、engine/downloader 的实际消费上限。
 */
const NUMERIC_RANGES = {
  defaultQuality: [0, 127], // B 站 qn 上限 127（8K）；0 = 自动
  concurrency: [1, 16], // engine.js: Math.max(1, Math.min(16, ...))
  retries: [0, 5], // 0 是合法值（不重试）
  danmakuOpacity: [0.1, 1],
  danmakuFontScale: [0.5, 2],
  danmakuWidth: [16, 16384],
  danmakuHeight: [16, 16384],
  maxParallelTasks: [1, 8],
};

/**
 * 布尔型设置：只有**字面 `true`** 才算开启。
 *
 * 为什么不能 `!!v`：storage 里存成字符串 `"false"`（非空串）或数字 `0` 时，
 * `!!v` 会把它当 truthy —— `notifyOnComplete: "false"` 反而开启了通知。
 * 严格 `=== true` 让"非真即假"，与 `lib.dom` 里 checkbox 的 `.checked` 语义一致。
 * 所有写入方（options/popup/dashboard/service-worker）写的都是真布尔，不会误伤。
 */
const BOOLEAN_KEYS = KEYS.filter((k) => typeof DEFAULT_SETTINGS[k] === 'boolean');

/**
 * 枚举字段的合法值域（v1.4.29 数据一致性 F8）。
 *
 * 此前 loadSettings 只归一化数值字段，枚举字段存了非法值会原样下发 ——
 * 虽然各消费点（resolveTaskSettings 白名单、pickDestination 等）有分散兜底，
 * 但新增字段时极易漏。这里一处收口：非法值 → 回落默认值。
 * （subtitleLan 是自由字符串，不设白名单。）
 */
const ENUM_KEYS = {
  preferCodec: ['avc', 'hevc', 'av1'],
  audioPreference: ['best', 'normal', 'lossless'],
  downloadMode: ['merge', 'separate', 'audio', 'durl'],
  danmakuFormat: ['ass', 'xml', 'srt', 'txt'],
  subtitleFormat: ['srt', 'ass', 'txt'],
  chapterFormat: ['txt', 'vtt'],
  saveMode: ['ask', 'downloads'],
};

/**
 * 把任意来源的原始设置（storage 读出的全量 / onChanged 的零散补丁）
 * 归一化成**合法设置**（v1.4.31 数据一致性 F5）。
 *
 * ★ 为什么必须是单一出口：v1.4.30 的钳制只做在 `loadSettings()` 里，
 *   而「设置页改一项 → onSettingsChanged → engine.settings」这条**实时变更通道**
 *   消费的是未归一化的 `v.newValue` —— storage 已被写坏（concurrency:"NaN"）时，
 *   用户在设置页随便改一项，就把 "NaN" 灌进了引擎：分片 worker 循环 0 次、
 *   任务标 done、静默产出 0 字节文件（正是钳制注释里要防的形态，绕了个道又进来）。
 *   loadSettings 与 onSettingsChanged 必须走同一个函数，否则就是「复制两份必漏一份」。
 *
 * 数值字段：统一 Number()，让所有下游逻辑（buildPlan 等）拿到的都是数字。
 * chrome.storage 不改类型，但 options/popup 的 select / input 直接 .value 时是
 * **字符串**，写盘后再读回仍是字符串。这对大多数字段无害，但对清晰度相关字段
 * （如 defaultQuality）极危险：JS 里 `!"0" === false`（非空字符串是 truthy），
 * `if (!quality)` 不会把字符串 "0" 识别为"自动"，直接走到降级分支，
 * accept 最小档（360P）就成了默认结果。
 */
function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // v1.4.30：Number() 之外补「有限性 + 区间钳制」—— 见 NUMERIC_RANGES 注释。
  for (const [k, [lo, hi]] of Object.entries(NUMERIC_RANGES)) {
    const rawValue = merged[k];
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      merged[k] = DEFAULT_SETTINGS[k];
      continue;
    }
    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      merged[k] = DEFAULT_SETTINGS[k];
      continue;
    }
    merged[k] = Math.min(hi, Math.max(lo, n));
  }
  // 布尔字段强制为真布尔（非字面 true 一律 false）—— 见 BOOLEAN_KEYS 注释。
  for (const k of BOOLEAN_KEYS) {
    merged[k] = merged[k] === true;
  }
  // 枚举字段白名单校验：storage 被写坏（手改/旧版本字段淘汰/同步冲突）时
  // 回落默认值，而不是把非法值透传给下游
  for (const [k, allowed] of Object.entries(ENUM_KEYS)) {
    if (merged[k] !== undefined && !allowed.includes(merged[k])) {
      merged[k] = DEFAULT_SETTINGS[k];
    }
  }
  return merged;
}

/** 读取全部设置（合并默认值）。 */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(KEYS);
  return normalizeSettings(stored);
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
      if (!KEYS.includes(k)) continue;
      // ★ v1.4.31（数据一致性 F5）：实时变更与 loadSettings 走**同一个**归一化出口。
      //   之前直传 v.newValue —— 钳制/布尔严格化/枚举白名单全部形同虚设，
      //   "NaN" 之类的脏值能绕过 loadSettings 直接灌进引擎。
      //   用单键补丁过一遍 normalizeSettings，取回归一化后的该字段。
      patch[k] = normalizeSettings({ [k]: v.newValue })[k];
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
  separate: '分别保存视频与音频两个文件（音频按真实类型存 .m4a / 无损 .flac），自行用播放器/ffmpeg 处理',
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
