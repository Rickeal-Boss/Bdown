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
 * 完整的 BV 合法性正则。
 *
 * 真实 BVID 固定以 `BV1` 起头，后面 9 个字符取自上面 TABLE 这 58 字符 base58 集，
 * 故意排除了 `0` / `O` / `I` / `l`（人眼易混）。旧正则 `/^BV[0-9A-Za-z]{10}$/` 只
 * 检查了「12 个字母数字」，把含 `I` 的伪造 BV（用户截图中的 `BVITX...KE9J`）也
 * 判定为合法并打到 B 站，结果 B 站返回 `-400`「请求错误」——本地看似通过，
 * 实际接口拒绝，原因在客户端。
 */
const BV_RE = new RegExp(`^BV1[${TABLE}]{9}$`);

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
  if (!BV_RE.test(bv)) throw new Error(`非法的 BV 号: ${bvid}`);
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const idx = TABLE.indexOf(bv[POS[i]]);
    if (idx < 0) throw new Error(`BV 号包含非法字符: ${bvid}`);
    sum += idx * 58 ** i;
  }
  return (sum - ADD) ^ XOR;
}

export function isBvid(text) {
  return BV_RE.test(String(text || '').trim());
}
