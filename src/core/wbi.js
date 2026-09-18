/**
 * B 站 WBI 签名。
 *
 * 参考实现（思路一致，均为社区公开算法）：
 *  - SocialSisterYi/bilibili-API-collect  docs/misc/sign/wbi.md
 *  - yt-dlp  yt_dlp/extractor/bilibili.py  BilibiliBaseIE._get_wbi_key / _sign_wbi
 *  - Bilibili-Evolved  core/src 中的 wbi 模块
 *
 * 流程：
 *  1. GET /x/web-interface/nav 拿到 data.wbi_img.img_url / sub_url
 *  2. 取文件名（不含扩展名）拼成 lookup，再按固定乱序表重排、截取 32 位得到 mixinKey
 *  3. 请求参数按 key 升序排序，值中剔除 !'()* 四个字符，urlencode 得到 query
 *  4. w_rid = md5(query + mixinKey)，并补上 wts（秒级时间戳）
 *
 * 注意：nav 接口未登录时会返回 code=-101，但 data.wbi_img 依然可用，所以不要因为
 * code 非 0 就报错。
 */

import { md5 } from './md5.js';

/** 来自 B 站前端 vendor 的 getMixinKey()，顺序不可改动。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 值里必须剔除的字符（B 站前端 filter 的字符集）。 */
const FORBIDDEN_CHARS = /[!'()*]/g;

const KEY_TTL = 10 * 60 * 1000; // 官方无明确过期时间，取 10 分钟足够保守

let cachedMixinKey = '';
let cachedAt = 0;

/** 从 wbi 图片 URL 中截出 key（`.../bfs/wbi/<key>.png` -> `<key>`）。 */
function keyFromUrl(url) {
  return String(url || '').split('/').pop().split('.')[0];
}

/**
 * 获取（并缓存）mixinKey。
 * @param {() => Promise<any>} fetchNav 返回 nav 接口 JSON 的函数
 */
export async function getMixinKey(fetchNav, { force = false } = {}) {
  if (!force && cachedMixinKey && Date.now() - cachedAt < KEY_TTL) return cachedMixinKey;

  const res = await fetchNav();
  const wbi = res?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) {
    throw new Error('无法获取 WBI 签名密钥（nav 接口返回异常），请稍后重试');
  }
  const lookup = keyFromUrl(wbi.img_url) + keyFromUrl(wbi.sub_url);
  if (lookup.length < 64) {
    throw new Error('WBI 密钥长度异常，接口可能已变更');
  }
  cachedMixinKey = MIXIN_KEY_ENC_TAB.map((i) => lookup[i]).join('').slice(0, 32);
  cachedAt = Date.now();
  return cachedMixinKey;
}

/** 清空缓存（例如切换账号后）。 */
export function resetMixinKey() {
  cachedMixinKey = '';
  cachedAt = 0;
}

/**
 * 对参数做 WBI 签名。
 * @param {Record<string, any>} params 原始参数
 * @param {string} mixinKey
 * @returns {Record<string, string>} 已排序、已签名、已剔除非法字符的完整参数
 */
export function signParams(params, mixinKey) {
  const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
  const cleaned = {};
  for (const key of Object.keys(withTs).sort()) {
    const raw = withTs[key];
    if (raw === undefined || raw === null) continue;
    cleaned[key] = String(raw).replace(FORBIDDEN_CHARS, '');
  }
  const query = Object.entries(cleaned)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return { ...cleaned, w_rid: md5(query + mixinKey) };
}

/**
 * 便捷方法：取 key + 签名 + 拼 query string。
 * @returns {Promise<string>} `a=1&b=2&w_rid=...`
 */
export async function signedQuery(params, fetchNav) {
  const mixinKey = await getMixinKey(fetchNav);
  const signed = signParams(params, mixinKey);
  return Object.entries(signed)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * 生成 `dm_img_*` 指纹参数。
 *
 * 这些参数用于模拟播放器上报的「用户指纹」，缺失时部分视频会返回 -352。
 * 参考 yt-dlp 的 BilibiliBaseIE._dm_params 与
 * https://s1.hdslb.com/bfs/seed/jinkela/short/user-fingerprint/bili-user-fingerprint.min.js
 */
export function buildDmParams() {
  const rnd = (n) => Math.floor(n * Math.random());
  const randStr = (min, max) => {
    const len = min + rnd(max - min + 1);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(33 + rnd(94));
    return s;
  };
  const b64 = (s) => btoa(s).replace(/=+$/, '');

  const w = 1920;
  const h = 1080;
  const r0 = rnd(114);
  const s0 = 10;
  const s1 = 10;
  const r1 = rnd(514);

  return {
    dm_img_list: '[]',
    dm_img_str: b64(randStr(16, 64)),
    dm_cover_img_str: b64(randStr(32, 128)),
    dm_img_inter: JSON.stringify({
      ds: [],
      wh: [2 * w + 2 * h + 3 * r0, 4 * w - h + r0, r0],
      of: [3 * s0 + 2 * s1 + r1, 4 * s0 - 4 * s1 + 2 * r1, r1],
    }),
  };
}
