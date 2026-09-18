/**
 * 哔哩哔哩 Web API 封装。
 *
 * 设计要点
 *  - 所有请求都带 `Referer: https://www.bilibili.com/`，否则部分接口返回 -403。
 *  - 使用 `credentials: 'include'`，扩展已声明 host_permissions，因此会自动携带
 *    浏览器里的 SESSDATA，实现「已登录即用高清晰度」。
 *  - playurl 走 WBI 签名版接口（/x/player/wbi/playurl），并附带 dm_img_* 指纹参数，
 *    规避 -352 风控。
 */

import { getMixinKey, signParams, buildDmParams, resetMixinKey } from './wbi.js';
import { av2bv } from './avbv.js';
import { AUDIO_QUALITIES, CODECS } from './quality.js';
import { retry, log, warn } from './util.js';

const API = 'https://api.bilibili.com';
const REFERER = 'https://www.bilibili.com/';

/**
 * 浏览器原生 fetch 在扩展页面调用时只自动加 `Referer`（取决于调用方式），
 * UA 也只会是 Chrome 自己的。B 站近年的风控对扩展来源 UA（无 Edg/Chrome 字样 +
 * 无 Origin）的请求直接返回 code=-400，症状是「请求参数错误」——但实际是服务器
 * 端的来源校验，不是参数问题。
 *
 * 参照 `stevenjoezhang/bilibili-downloader` 与 `bilibili-helper-o` 的
 * fetch headers：显式设置桌面浏览器 UA、Origin、Referer。
 *
 * ——证据：本机 curl / Node fetch 怎么发都 code:0；浏览器扩展场景下 -400。
 */
const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  Referer: REFERER,
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** fnval 位掩码：DASH + HDR + 4K + 杜比音频 + 杜比视界 + 8K + AV1 */
export const FNVAL_DASH = 16 | 64 | 128 | 256 | 512 | 1024 | 2048; // = 4048
/** 番剧接口额外需要的位（yt-dlp 用 12240 = 4048 | 8192）。 */
export const FNVAL_PGC_DASH = FNVAL_DASH | 8192; // = 12240
/** fnval=1 时返回 durl（可直下的单文件 MP4/FLV），清晰度上限较低。 */
export const FNVAL_DURL = 1;

const ERROR_MESSAGES = {
  '-101': '账号未登录，请先在浏览器中登录 B 站',
  '-400': '请求参数错误',
  '-403': '访问权限不足（可能需要登录、大会员或该内容已被限制）',
  '-404': '视频不存在或已被删除',
  '-352': '被 B 站风控拦截，请稍后重试或降低并发',
  '-412': '请求被风控拒绝，请稍后重试',
  '-509': '请求过于频繁，请稍后重试',
  62002: '稿件不可见（可能已失效或为私密稿件）',
  62004: '稿件审核中',
  87007: '该视频为充电专属内容',
  '-10403': '当前地区无法观看（地区限制）',
};

export class BiliError extends Error {
  constructor(code, message, url) {
    // 自定义 message 优先；只有在没给 message 时才回退到 ERROR_MESSAGES 表
    // —— 否则本地主动抛的「请求缺少 bvid」类提示会被 -400 的「请求参数错误」
    // 默认文案覆盖，掩盖真实原因。
    const friendly = message || ERROR_MESSAGES[String(code)];
    super(friendly ? `${friendly}（code ${code}）` : `接口错误 code=${code}`);
    this.name = 'BiliError';
    this.code = code;
    this.url = url;
  }
}

export class BiliApi {
  /**
   * @param {{ fetchImpl?: typeof fetch, onDebug?: (msg: string, data?: any) => void }} [opts]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
    this.onDebug = opts.onDebug || (() => {});
    /** @type {{ isLogin: boolean, uname: string, mid: number, vip: boolean, checkedAt: number }|null} */
    this.account = null;
  }

  /** 底层 GET：自动加 Referer、带 cookie、解析 JSON、检查 code。 */
  async get(pathOrUrl, { params, signed = false, raw = false, timeout = 20000, needLogin = false } = {}) {
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl);
    if (params && /playurl|view/.test(url.pathname)) {
      // 服务端对「没有任何视频标识（bvid/avid/ep_id/season_id）」的请求会返回
      // code=-400「请求错误」——这条信息会走 ERROR_MESSAGES 表被翻译成
      // 「请求参数错误」掩盖根因。本地先拦下，给具体提示（与 view 接口是否签名无关）。
      const idKeys = Object.keys(params).filter((k) => ['bvid', 'avid', 'ep_id', 'season_id'].includes(k));
      if (!idKeys.length) {
        throw new BiliError(
          -400,
          '请求缺少视频标识（bvid / avid / ep_id），任务规格可能不完整',
          url.toString(),
        );
      }
    }
    let query = '';
    if (params) {
      if (signed) {
        const mixinKey = await getMixinKey(() => this.nav({ quiet: true }));
        const sp = signParams(params, mixinKey);
        query = new URLSearchParams(sp).toString();
      } else {
        query = new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
        ).toString();
      }
    }
    if (query) url.search = url.search ? `${url.search}&${query}` : `?${query}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: COMMON_HEADERS,
      });
    } finally {
      clearTimeout(timer);
    }

    if (raw) {
      if (!res.ok) throw new BiliError(res.status, `HTTP ${res.status}`, url.toString());
      return res;
    }

    if (!res.ok) throw new BiliError(res.status, `HTTP ${res.status}`, url.toString());

    let json;
    try {
      json = await res.json();
    } catch {
      throw new BiliError(-1, `响应不是合法 JSON：${url}`, url.toString());
    }

    this.onDebug('GET', { url: url.toString(), code: json.code });
    if (json.code !== 0) {
      if (needLogin && json.code === -101) {
        throw new BiliError(json.code, '该清晰度需要登录后才能获取', url.toString());
      }
      throw new BiliError(json.code, json.message, url.toString());
    }
    return json.data;
  }

  /**
   * 账号与 WBI 密钥。
   * 注意：未登录时接口返回 code=-101，但 data.wbi_img 依然有效，不能直接抛错。
   */
  async nav({ quiet = false } = {}) {
    const url = `${API}/x/web-interface/nav`;
    const res = await this.fetchImpl(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Referer: REFERER },
    });
    const json = await res.json();
    if (!quiet) {
      this.account = {
        isLogin: !!json?.data?.isLogin,
        uname: json?.data?.uname || '',
        mid: json?.data?.mid || 0,
        vip: !!json?.data?.vipStatus,
        checkedAt: Date.now(),
      };
      log('账号状态', this.account);
    }
    // 未登录时返回 { code: -101, data: { wbi_img: {...} } }，这里原样返回给 wbi 模块
    return json;
  }

  /** 当前账号是否已登录（带 60 秒缓存）。 */
  async ensureAccount({ force = false } = {}) {
    if (!force && this.account && Date.now() - this.account.checkedAt < 60_000) return this.account;
    await this.nav();
    return this.account;
  }

  /** 视频基本信息（标题、封面、分P、合集入口等）。 */
  async videoInfo({ bvid, aid }) {
    const params = bvid ? { bvid } : { aid };
    return this.get('/x/web-interface/view', { params });
  }

  /** 视频详情（含 ugc_season 合集信息），需要 WBI 签名。 */
  async videoDetail({ bvid, aid }) {
    const params = {};
    if (bvid) params.bvid = bvid;
    if (aid) params.aid = aid;
    return this.get('/x/web-interface/wbi/view/detail', { params, signed: true });
  }

  /**
   * 取播放地址。
   * @param {object} o
   * @param {string} [o.bvid]
   * @param {number} [o.aid]
   * @param {number} o.cid
   * @param {number} [o.qn] 期望清晰度
   * @param {'dash'|'durl'} [o.mode]
   * @param {number} [o.epId] 番剧 ep
   * @returns {Promise<PlayInfo>}
   */
  async playurl({ bvid, aid, cid, qn = 127, mode = 'dash', epId, fourk = 1 }) {
    const logged = await this.ensureAccount().then((a) => a.isLogin).catch(() => false);
    const params = {
      cid,
      qn,
      fnver: 0,
      // 番剧（pgc）接口需要额外的 fnval 位才能拿到全部清晰度：
      // yt-dlp 对 pgc/player/web/v2/playurl 用的是 12240 = 4048 | 8192。
      fnval: mode === 'durl' ? FNVAL_DURL : epId ? FNVAL_PGC_DASH : FNVAL_DASH,
      fourk,
      otype: 'json',
      // B 站的 /x/player/wbi/playurl 在 2025 年后收紧了对 platform 的校验，
      // 「pc」会返回 code=-400「请求参数错误」。参照 yt-dlp 的取值，改为 'web'。
      // —— 证据：ref_39aff72d.txt（yt-dlp bilibili.py）多处以 platform='web' 调用。
      platform: 'web',
      high_quality: 1,
      ...buildDmParams(),
    };
    if (bvid) params.bvid = bvid;
    else if (aid) params.avid = aid;
    if (!logged) params.try_look = 1;

    const path = epId
      ? '/pgc/player/web/v2/playurl'
      : '/x/player/wbi/playurl';
    if (epId) params.ep_id = epId;

    let data;
    try {
      data = await this.get(path, { params, signed: true });
    } catch (err) {
      // 签名密钥可能已过期，强制刷新后重试一次
      if (err instanceof BiliError && ['-403', '-352', '-412'].includes(String(err.code))) {
        warn('playurl 失败，刷新 WBI 密钥后重试', err.message);
        resetMixinKey();
        data = await retry(
          async () => {
            const mixinKey = await getMixinKey(() => this.nav({ quiet: true }), { force: true });
            const sp = signParams(params, mixinKey);
            const url = `${API}${path}?${new URLSearchParams(sp).toString()}`;
            const res = await this.fetchImpl(url, {
              credentials: 'include',
              headers: { Referer: REFERER, Origin: 'https://www.bilibili.com' },
            });
            const json = await res.json();
            if (json.code !== 0) throw new BiliError(json.code, json.message, url);
            return json.data;
          },
          { times: 2 }
        );
      } else {
        throw err;
      }
    }
    return normalizePlayInfo(data, mode);
  }

  /** 播放器信息：字幕列表、章节、互动等。 */
  async playerV2({ bvid, cid, aid }) {
    const params = { cid };
    if (bvid) params.bvid = bvid;
    else if (aid) params.aid = aid;
    return this.get('/x/player/wbi/v2', { params, signed: true });
  }

  /** 弹幕 XML（protobuf 之外的老接口，仍是 XML，最通用）。 */
  async danmakuXml(cid) {
    const res = await this.get(`https://comment.bilibili.com/${cid}.xml`, { raw: true });
    return res.text();
  }

  /** 番剧剧集列表。 */
  async seasonSection(seasonId) {
    return this.get('/pgc/web/season/section', { params: { season_id: seasonId } });
  }

  /** 番剧基础信息。 */
  async seasonInfo(seasonId) {
    return this.get('/pgc/view/web/season', { params: { season_id: seasonId } });
  }

  /** 用户投稿列表（用于 UP 主主页批量，可选功能）。 */
  async spaceVideos({ mid, pn = 1, ps = 30, keyword = '' }) {
    return this.get('/x/space/wbi/arc/search', {
      params: { mid, pn, ps, keyword, order: 'pubdate', platform: 'web' },
      signed: true,
    });
  }

  /** 收藏夹内容（可选功能）。 */
  async favList({ mediaId, pn = 1, ps = 20 }) {
    return this.get('/x/v3/fav/resource/list', {
      params: { media_id: mediaId, pn, ps, platform: 'web', order: 'mtime' },
    });
  }
}

/**
 * @typedef {object} PlayInfo
 * @property {'dash'|'durl'} mode
 * @property {number} quality 实际返回的清晰度
 * @property {number[]} acceptQuality 可选清晰度
 * @property {number} duration 秒
 * @property {VideoTrack[]} videos
 * @property {AudioTrack[]} audios
 * @property {DurlTrack[]} durl
 */

/** 把接口原始响应整理成统一结构。 */
export function normalizePlayInfo(data, mode) {
  const duration = Number(data.timelength || 0) / 1000 || Number(data.dash?.duration) || 0;
  const videos = [];
  const audios = [];
  const durl = [];

  const dash = data.dash;
  if (dash) {
    for (const v of dash.video || []) {
      videos.push({
        quality: v.id,
        codecid: v.codecid,
        codec: CODECS[v.codecid]?.name || `codecid-${v.codecid}`,
        codecs: v.codecs,
        width: v.width,
        height: v.height,
        frameRate: v.frameRate,
        bandwidth: v.bandwidth,
        size: v.size || Math.trunc(((v.bandwidth || 0) * duration) / 8),
        url: httpsUrl(v.baseUrl || v.base_url),
        backupUrls: (v.backupUrl || v.backup_url || []).map(httpsUrl),
        mimeType: v.mimeType || 'video/mp4',
      });
    }

    const pushAudio = (a, type) => {
      if (!a) return;
      audios.push({
        id: a.id,
        type,
        label: type === 'flac' ? 'Hi-Res 无损' : AUDIO_QUALITIES[a.id]?.label || String(a.id),
        codecs: a.codecs,
        bandwidth: a.bandwidth,
        size: a.size || Math.trunc(((a.bandwidth || 0) * duration) / 8),
        url: httpsUrl(a.baseUrl || a.base_url),
        backupUrls: (a.backupUrl || a.backup_url || []).map(httpsUrl),
        mimeType: a.mimeType || 'audio/mp4',
      });
    };
    for (const a of dash.audio || []) pushAudio(a, 'audio');
    for (const a of dash.dolby?.audio || []) pushAudio(a, 'dolby');
    pushAudio(dash.flac?.audio, 'flac');
  }

  for (const d of data.durl || []) {
    durl.push({
      url: httpsUrl(d.url),
      size: d.size,
      length: Number(d.length || 0) / 1000,
      backupUrls: (d.backup_url || []).map(httpsUrl),
    });
  }

  return {
    mode: dash ? 'dash' : 'durl',
    quality: data.quality,
    acceptQuality: data.accept_quality || [],
    acceptDescription: data.accept_description || [],
    supportFormats: data.support_formats || [],
    duration,
    videos,
    audios,
    durl,
    language: data.language?.items || [],
    raw: data,
  };
}

function httpsUrl(u) {
  if (!u) return u;
  return String(u).replace(/^http:\/\//, 'https://');
}

/**
 * 在给定清晰度下挑出最优视频轨。
 * @param {VideoTrack[]} videos
 * @param {number} quality
 * @param {'avc'|'hevc'|'av1'} preferCodec
 */
export function pickVideoTrack(videos, quality, preferCodec = 'avc') {
  if (!videos.length) return null;
  const order = { avc: [7, 12, 13], hevc: [12, 7, 13], av1: [13, 12, 7] }[preferCodec] || [7, 12, 13];
  const sameQ = videos.filter((v) => v.quality === quality);
  const pool = sameQ.length ? sameQ : videos;
  const sorted = [...pool].sort((a, b) => {
    const ai = order.indexOf(a.codecid);
    const bi = order.indexOf(b.codecid);
    const as = ai < 0 ? 99 : ai;
    const bs = bi < 0 ? 99 : bi;
    if (as !== bs) return as - bs;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
  // 同编码下选码率最高的
  const best = sorted[0];
  const sameCodec = sorted.filter((v) => v.codecid === best.codecid);
  return sameCodec.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

/** 挑出最优音轨：优先无损/杜比，其次 192K。 */
export function pickAudioTrack(audios, { preferLossless = true } = {}) {
  if (!audios.length) return null;
  const rank = (a) => {
    if (a.type === 'flac') return preferLossless ? 0 : 3;
    if (a.type === 'dolby') return preferLossless ? 1 : 2;
    return 4 - Math.min(3, Math.floor((a.id - 30200) / 100));
  };
  return [...audios].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  })[0];
}

export { av2bv };
