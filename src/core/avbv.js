/**
 * AV 号 <-> BV 号互转。
 *
 * 算法为社区公开的官方前端实现（table / xor / add 三个常量固定不变）。
 * 参考：SocialSisterYi/bilibili-API-collect 与多个下载器的 av2bv 实现。
 */

const TABLE = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';
const POS = [11, 10, 3, 8, 4, 6];
const XOR = 177451812;
const ADD = 8728348608;

const BV_TEMPLATE = ['B', 'V', '1', ' ', ' ', '4', ' ', '1', ' ', '7', ' ', ' '];

/**
 * @param {number|string} aid av 号
 * @returns {string} BV 号
 */
export function av2bv(aid) {
  let av = Number(aid);
  if (!Number.isFinite(av) || av < 0) throw new Error(`非法的 av 号: ${aid}`);
  av = (av ^ XOR) + ADD;
  const chars = [...BV_TEMPLATE];
  for (let i = 0; i < 6; i++) {
    chars[POS[i]] = TABLE[Math.floor(av / 58 ** i) % 58];
  }
  return chars.join('');
}

/**
 * @param {string} bvid BV 号
 * @returns {number} av 号
 */
export function bv2av(bvid) {
  const bv = String(bvid).trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) throw new Error(`非法的 BV 号: ${bvid}`);
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const idx = TABLE.indexOf(bv[POS[i]]);
    if (idx < 0) throw new Error(`BV 号包含非法字符: ${bvid}`);
    sum += idx * 58 ** i;
  }
  return (sum - ADD) ^ XOR;
}

export function isBvid(text) {
  return /^BV[0-9A-Za-z]{10}$/.test(String(text || '').trim());
}
