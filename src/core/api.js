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
/**
 * 课程（pugv）用 **16（只要 DASH）**，与 yt-dlp 的实现一致。
 * 我们原先沿用 ugc 的 4048，但 4048 含 HDR/4K/杜比/8K 等位，对 pugv 是否
 * 适用从未验证过；yt-dlp 这里明确写死 16。
 */
export const FNVAL_PUGV = 16;

const ERROR_MESSAGES = {
  '-101': '账号未登录，请先在浏览器中登录 B 站',
  '-400': '请求参数错误',
  '-401': '非法访问（URL 缺少必填字段或内容不可用），请回到视频页重新点一次「下载」',
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
      // 关键：必须「存在且**非空**」。只检查 key 会漏掉
      // `{bvid: undefined}` / `{bvid: ''}` —— 这正是 cid 故障的原样翻版：
      // key 在、值为空，闸门放行，signParams 又把空值悄悄丢掉，
      // 请求发出去没有任何视频标识，B 站返 -400。
      const idKeys = (() => {
        const ID_KEYS = ['bvid', 'avid', 'ep_id', 'season_id'];
        return Object.keys(params).filter((k) =>
          ID_KEYS.includes(k)
          && params[k] !== undefined && params[k] !== null && params[k] !== '');
      })();
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

    if (!res.ok) {
      // B 站的 WAF 对「Origin 是 chrome-extension://」的请求返回 412/403 的
      // HTML 错误页（标题「出错啦! - bilibili.com」）。这时状态码本身就说明
      // 是被风控拦了，而不是接口业务错误，要单独说清楚。
      const ctype = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
      if (res.status === 412 || res.status === 403 || ctype.includes('text/html')) {
        throw new BiliError(
          res.status,
          `被 B 站风控拦截（HTTP ${res.status}）。扩展页的请求会带 ` +
            `Origin: chrome-extension://...，B 站只放行 Origin 为 ` +
            `https://www.bilibili.com 或不含 Origin 的请求。请确认扩展的 ` +
            `declarativeNetRequest 规则已生效（rules/referer.json 的 id 3/4），` +
            `并重新加载扩展。`,
          url.toString(),
        );
      }
      throw new BiliError(res.status, `HTTP ${res.status}`, url.toString());
    }

    let json;
    const ctype = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
    if (ctype.includes('text/html')) {
      throw new BiliError(
        -1,
        'B 站返回了 HTML 错误页而不是 JSON，通常是被风控拦截（WAF）。' +
          '请检查扩展的 declarativeNetRequest 规则是否生效。',
        url.toString(),
      );
    }
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
      // B 站返回的 -400 文案很泛（"请求错误" / "请求参数错误"），用户看不出
      // 是客户端没填 id、还是 BVID 本身不存在。下面按常见情形给出具体诊断。
      // 完整请求 URL 已放在 error.url 里，方便到 chrome://extensions 的
      // service worker console 里查具体发了什么参数。
      if (json.code === -400) {
        const idKeys = Object.keys(params || {}).filter((k) => ['bvid', 'avid', 'ep_id', 'season_id'].includes(k));
        // 过滤掉 undefined / 空串，避免输出「bvid=undefined 不存在」这种误导文案
        const ids = idKeys.map((k) => `${k}=${params[k]}`);
        // 注：上一步本地预校验已经把「id 全缺」拦下了；到这里说明 id 已传，但 B 站仍返 -400
        if (ids.length === 0) {
          throw new BiliError(
            -400,
            '请求缺少视频标识（bvid / avid / ep_id），任务规格可能不完整',
            url.toString(),
          );
        }
        // id 已传 → 大概率是 BVID/AVID 在 B 站不存在 / 已删除 / 风控
        throw new BiliError(
          -400,
          `B 站返回「请求错误」，很可能 ${ids.join(' / ')} 在 B 站不存在或已被删除；` +
            `也可能是当前网络对 api.bilibili.com 被拦截。请到控制台查看完整 URL。`,
          url.toString(),
        );
      }
      throw new BiliError(json.code, json.message, url.toString());
    }
    return json.data;
  }

  /**
   * 账号与 WBI 密钥。
   * 注意：未登录时接口返回 code=-101，但 data.wbi_img 依然有效，不能直接抛错。
   */
  /**
   * 账号/导航接口。
   *
   * 这里**刻意不走通用的 `get()`**：`get()` 会在响应体里找 `code` 字段，而 nav
   * 未登录时返回 `{ code: -101, data: { wbi_img: {...} } }`——-101 是**正常状态**，
   * 不是错误，WBI 模块还要从中取密钥。
   *
   * 但原来的实现有三个硬伤（会导致「已登录用户被误判成未登录」，进而清晰度降级）：
   *   1. 无超时 —— 网络挂起时永久卡住（它在 get() 的 20s 定时器之外）
   *   2. 无重试 —— 一次失败就抛
   *   3. 不查 `res.ok` / content-type —— B 站 WAF 返回 412 HTML 时，`res.json()`
   *      会裸抛 SyntaxError，调用方 catch 后当成"未登录"
   *
   * 现已补上超时（8s）、重试（2 次）、状态与 content-type 校验。
   */
  async nav({ quiet = false, timeout = 8000, retries = 2 } = {}) {
    const url = `${API}/x/web-interface/nav`;
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort('nav-timeout'), timeout);
      try {
        const res = await this.fetchImpl(url, {
          credentials: 'include',
          cache: 'no-store',
          signal: ctrl.signal,
          headers: { Referer: REFERER, ...COMMON_HEADERS },
        });

        // WAF / 风控会返回 HTML 错误页（如 412），先挡掉，避免 res.json() 裸抛
        if (!res.ok) throw new BiliError(res.status, `HTTP ${res.status}`, url);
        const ctype = res.headers?.get?.('content-type') || '';
        if (ctype && !/json/i.test(ctype)) {
          throw new BiliError(-1, `响应不是 JSON（content-type: ${ctype}），可能被风控拦截`, url);
        }

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
        // 未登录时返回 { code: -101, data: { wbi_img: {...} } }，原样返回给 wbi 模块
        return json;
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          warn(`nav 第 ${attempt + 1} 次失败，重试中`, err?.message);
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** 当前账号是否已登录（带 60 秒缓存）。 */
  /**
   * 当前账号状态（带缓存 + 失败回退）。
   *
   * **关键改动**：nav 偶发失败（网络抖动 / WAF）时，如果本地已有**近期确认过**的
   * 登录态，就继续沿用缓存而不是把用户降级成"未登录"。
   * 否则一次抖动就会让用户从 1080P 掉到 720P（playurl 里 `try_look` 与清晰度都依赖 isLogin）。
   */
  async ensureAccount({ force = false, staleToleranceMs = 30 * 60 * 1000 } = {}) {
    const fresh = this.account && Date.now() - this.account.checkedAt < 60_000;
    if (!force && fresh) return this.account;

    try {
      await this.nav();
      return this.account;
    } catch (err) {
      const stale = this.account;
      // 有旧缓存且在容忍期内 → 沿用它，只是标记一下
      if (!force && stale && Date.now() - stale.checkedAt < staleToleranceMs) {
        warn('nav 失败，沿用上次已知的账号状态（避免误判为未登录导致清晰度降级）', err?.message);
        return stale;
      }
      throw err;
    }
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
  async playurl({ bvid, aid, cid, qn = 127, mode = 'dash', epId, cheeseId, fourk = 1 }) {
    // 三态：true=已确认登录 / false=已确认未登录 / null=**拿不到登录态**（nav 失败且无缓存）
    //
    // 为什么不能用二态：nav 偶发失败（WAF / 断网）时如果一律当"未登录"，
    // playurl 就会带上 `try_look=1`（B 站的"未登录试看"参数），服务端很可能
    // 只返回低清试看流 —— 用户明明登录了却下到 360P，且完全不知道原因。
    // 拿不到登录态时要**保守**：不带 try_look，把判断权留给服务端 Cookie。
    const logged = await this.ensureAccount()
      .then((a) => (a && typeof a.isLogin === 'boolean' ? a.isLogin : null))
      .catch(() => null);
    // 自动清晰度的取值（qn=0 表示「让客户端按账号挑」）。
    //
    // B 站的清晰度上限规则：
    //   - 大会员       → 全部（8K / 4K / HDR / 1080P60 / 1080P+ 高码率）
    //   - 已登录非会员 → 1080P 30 帧（非高码率）
    //   - 少数限免影片 → 满血清晰度（B 站自己放行，无需客户端特殊处理）
    //
    // 这里不能直接写 127：对已登录非会员，B 站遇到超出权限的 qn 会把整份
    // 清单降级成 360P 预览，反而比 1080P 更差。也不能写 0：实测 qn=0 时
    // 响应里 accept_quality 为 null，拿不到可用清单。
    const account = await this.ensureAccount().catch(() => null);
    const resolvedQn = qn > 0 ? qn : (account && account.vip ? 127 : (logged ? 80 : 64));
    const kind = cheeseId ? 'pugv' : epId ? 'pgc' : 'ugc';
    const params = {
      cid,
      qn: resolvedQn,
      fnver: 0,
      // 番剧（pgc）接口需要额外的 fnval 位才能拿到全部清晰度：
      // yt-dlp 对 pgc/player/web/v2/playurl 用的是 12240 = 4048 | 8192。
      fnval: mode === 'durl'
        ? FNVAL_DURL
        : kind === 'pugv'
          ? FNVAL_PUGV
          : kind === 'pgc'
            ? FNVAL_PGC_DASH
            : FNVAL_DASH,
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
    // 只在**确认**未登录时才带 try_look；登录态未知（logged === null）时不带，
    // 让服务端按请求里的 Cookie 自行判断，避免误拿试看流
    if (logged === false) params.try_look = 1;

    // 课程（pugv）：DownKyi 的注释明确写了「必须有 episodeId，否则会返回请求
    // 错误（code -400）」—— 所以 cheeseId 是必填，不能像番剧那样只给 cid。
    const path = kind === 'pugv'
      ? '/pugv/player/web/playurl'
      : kind === 'pgc'
        ? '/pgc/player/web/v2/playurl'
        : '/x/player/wbi/playurl';
    // cid 是 playurl 的必填项。缺了它 B 站返回 code=-400「请求错误」，
    // 与「BV 不存在」返回的是同一个错误码，极难分辨——所以本地先说清楚。
    if (!cid) {
      throw new BiliError(
        -400,
        '任务缺少 cid（分P 标识），无法请求播放地址。请回到视频页面重新点一次「下载」，' +
          '或在下载中心删除该任务后重新添加。',
        `${API}${kind === 'pugv' ? '/pugv/player/web/playurl' : kind === 'pgc' ? '/pgc/player/web/v2/playurl' : '/x/player/wbi/playurl'}?bvid=${bvid || ''}`,
      );
    }

    if (epId) params.ep_id = epId;
    if (cheeseId) params.ep_id = cheeseId;
    // pugv 文档只列了 avid（B 站就没写 bvid）。课程场景补一个 avid 兜底，
    // 避免"既无 bvid 又无 avid"被本地闸门拦下。
    if (kind === 'pugv' && !params.avid && !params.bvid) {
      const nav = Number(aid);
      if (Number.isFinite(nav) && nav > 0) params.avid = nav;
    }

    let data;
    try {
      data = await this.get(path, { params, signed: true });
    } catch (err) {
      // 签名密钥可能已过期，强制刷新后重试一次
      // 番剧：v2（ep_id）拿不到就降级到 v1（只传 cid）。
      // DownKyi 与 sakidown 都用 `/pgc/player/web/playurl` + cid，
      // yt-dlp 用 v2 + ep_id —— 两种都能通，留个降级更稳。
      if (kind === 'pgc' && err instanceof BiliError && err.code === -400) {
        try {
          warn('番剧 v2 接口失败，降级到 v1（只传 cid）', err.message);
          const v1 = { cid, qn: resolvedQn, fnver: 0, fnval: FNVAL_DASH, fourk };
          if (bvid) v1.bvid = bvid;
          else if (aid) v1.avid = aid;
          const res2 = await this.get('/pgc/player/web/playurl', { params: v1, signed: true });
          const info2 = normalizePlayInfo(res2, mode);
          if (info2 && (info2.videos.length || info2.durl.length)) { data = info2; return data; }
        } catch (e2) {
          warn('番剧 v1 降级也失败', e2?.message);
        }
      }
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
  /**
   * 番剧 season 信息。
   *
   * B 站的 `/pgc/view/web/season` **同时接受 `season_id` 与 `ep_id`**。
   * popup 之前拿 `spec.epId` 去调它却塞进了 `season_id`，属于传错参。
   * 这里按入参名分流，谁有值用谁。
   */
  async seasonInfo(seasonIdOrEpId, { epId } = {}) {
    const params = {};
    if (Number(seasonIdOrEpId) > 0) params.season_id = seasonIdOrEpId;
    if (Number(epId) > 0) params.ep_id = epId;
    return this.get('/pgc/view/web/season', { params });
  }

  /**
   * 课程（pugv）season 信息，用于由 ep_id 反查该集的 cid。
   * 对齐 DownKyi 的 `CheeseInfo`。**未真机验证**（课程通常是付费内容）。
   */
  async cheeseSeason(epId) {
    const res = await this.get('/pugv/view/web/season', { params: { ep_id: epId } });
    if (!res) return null;
    return {
      title: res.title || res.season_title || '',
      episodes: Array.isArray(res.episodes) ? res.episodes.map((e) => ({
        id: Number(e.id ?? e.episode_id ?? 0),
        cid: Number(e.cid ?? 0),
        title: e.title || '',
      })) : [],
    };
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
  const qOf = (v) => Number(v.quality ?? v.id) || 0;

  // 用户指定了清晰度时，只考虑「不超过该档」的轨道；auto（<=0）则全部候选。
  // 注意：DASH 下 qn 是无效的（实测：传 0/80/125/127 返回的轨道集合完全一致），
  // B 站按账号权限返回它能给的全部轨道，清晰度必须**在客户端挑**。
  const maxQ = Number(quality) > 0 ? Number(quality) : Infinity;
  const eligible = videos.filter((v) => qOf(v) <= maxQ);
  const pool = eligible.length ? eligible : videos;

  const sorted = [...pool].sort((a, b) => {
    // 1) 清晰度降序 —— 第一优先级。旧实现完全没排清晰度，只按码率取最大，
    //    导致低清轨码率稍高时会被误选（这正是"非会员下出 360P"的真实原因）。
    const aq = qOf(a);
    const bq = qOf(b);
    if (aq !== bq) return bq - aq;
    // 2) 编码偏好
    const ai = order.indexOf(a.codecid);
    const bi = order.indexOf(b.codecid);
    const as = ai < 0 ? 99 : ai;
    const bs = bi < 0 ? 99 : bi;
    if (as !== bs) return as - bs;
    // 3) 同清晰度同编码下，码率高的优先
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
  return sorted[0];
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
