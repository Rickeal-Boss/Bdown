/**
 * 断点续传的纯逻辑层（不碰网络、不碰存储，便于单元测试）。
 *
 * 为什么单独抽出来：浏览器里的 OPFS / 文件句柄行为无法在 CI 里验证，
 * 但「已下载区间 → 还差哪些区间」这套逻辑是完全确定的、可测的。
 * 把确定性部分与不确定性部分切开，至少保证前者 100% 正确。
 *
 * 区间约定：{ start, end } 表示 [start, end) 半开区间，与 HTTP Range 一致。
 */

/**
 * 校验并规范化一个区间。
 * @returns {{ start: number, end: number }|null} 非法返回 null
 */
export function normalizeRange(r) {
  if (!r || typeof r !== 'object') return null;
  const start = Number(r.start);
  const end = Number(r.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start) return null;
  return { start, end };
}

/**
 * 合并重叠或相邻的区间，输出按 start 升序、两两不相连的列表。
 *
 * 相邻（a.end === b.start）也合并，否则分片下载时会产生大量 1 字节碎片。
 */
export function mergeRanges(ranges) {
  const cleaned = (ranges || []).map(normalizeRange).filter(Boolean);
  if (!cleaned.length) return [];
  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [{ ...cleaned[0] }];
  for (let i = 1; i < cleaned.length; i++) {
    const cur = cleaned[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) {
      // 重叠或相邻 → 吞并
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * 已下载字节数（区间已合并、不重叠，直接求和）。
 */
export function completedBytes(ranges) {
  return mergeRanges(ranges).reduce((n, r) => n + (r.end - r.start), 0);
}

/**
 * 给定总长度与已完成区间，算出还缺哪些区间。
 *
 * @param {number} total 文件总字节数
 * @param {{start:number,end:number}[]} done 已完成区间（可重叠、可无序）
 * @returns {{start:number,end:number}[]} 缺失区间，按 start 升序
 */
export function missingRanges(total, done) {
  const size = Number(total);
  if (!Number.isFinite(size) || size <= 0) return [];
  const merged = mergeRanges(done).filter((r) => r.end > r.start);

  const gaps = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start >= size) break;
    if (r.start > cursor) gaps.push({ start: cursor, end: Math.min(r.start, size) });
    cursor = Math.max(cursor, Math.min(r.end, size));
    if (cursor >= size) break;
  }
  if (cursor < size) gaps.push({ start: cursor, end: size });
  return gaps;
}

/**
 * 把缺失区间按目标大小切成下载分片。
 *
 * @param {{start:number,end:number}[]} gaps
 * @param {number} chunkSize 目标分片大小（字节）
 */
export function toChunks(gaps, chunkSize) {
  const size = Number(chunkSize);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`非法的分片大小: ${chunkSize}`);
  }
  const out = [];
  for (const g of gaps || []) {
    let off = g.start;
    while (off < g.end) {
      const end = Math.min(off + size, g.end);
      out.push({ start: off, end });
      off = end;
    }
  }
  return out;
}

/**
 * 记录一个已完成区间（增量更新）。
 * 返回合并后的新列表，不修改入参。
 */
export function addRange(done, range) {
  const r = normalizeRange(range);
  if (!r) return mergeRanges(done);
  return mergeRanges([...(done || []), r]);
}

/**
 * 判断是否已全部下载完。
 */
export function isComplete(total, done) {
  const size = Number(total);
  if (!Number.isFinite(size) || size <= 0) return false;
  return missingRanges(size, done).length === 0;
}

/** 序列化（存 chrome.storage / IndexedDB 前用）。 */
export function serialise(ranges) {
  return JSON.stringify(mergeRanges(ranges));
}

/** 反序列化，顺手做容错（脏数据不该让整个任务崩）。 */
export function deserialise(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? mergeRanges(parsed) : [];
  } catch {
    return [];
  }
}
