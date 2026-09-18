/**
 * 断点续传的持久化层（OPFS）。
 *
 * 每个「可续传的轨道」存两个文件：
 *   <key>.part  —— 已下载的部分内容（FileHandleSink，open() 用了
 *                  keepExistingData: true，所以重开不会清空已有字节）
 *   <key>.json  —— 清单：{ size, ranges, updatedAt, key }
 *
 * 设计要点
 *  - key 由**内容身份**（bvid/aid/cid/epId + 清晰度 + 编码 + 音视轨）派生，
 *    **不包含 URL** —— CDN 地址每次 playurl 都会换，但内容字节不变，
 *    所以续传不能拿 URL 当身份。
 *  - 所有纯逻辑（key 派生、清单校验）都单独导出，可在 CI 里完整验证；
 *    只有真正碰 OPFS 的部分依赖浏览器。
 */

import { OpfsWorkspace, FileHandleSink } from './sink.js';
import { mergeRanges, completedBytes, serialise, deserialise } from './resume.js';

/** 清单默认有效期：7 天。过期就当没有，避免残留脏数据拖慢每次启动。 */
export const RESUME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 纯函数：由内容身份派生稳定的续传 key。
 *
 * @param {object} o
 * @param {string} [o.bvid]
 * @param {number} [o.aid]
 * @param {number} o.cid
 * @param {number} [o.epId]
 * @param {number} [o.quality]
 * @param {string} [o.codec]
 * @param {'v'|'a'} [o.track] 视轨 / 音轨
 */
export function resumeKey({ bvid, aid, cid, epId, quality, codec, track } = {}) {
  const id = bvid ? `bv${bvid}` : aid ? `av${aid}` : epId ? `ep${epId}` : '';
  if (!id || !Number.isFinite(Number(cid))) return '';
  const parts = [id, `c${Number(cid)}`];
  if (Number.isFinite(Number(quality))) parts.push(`q${Number(quality)}`);
  if (codec) parts.push(String(codec).replace(/[^A-Za-z0-9]/g, ''));
  if (track) parts.push(track === 'a' ? 'a' : 'v');
  return parts.join('_');
}

/**
 * 纯函数：判断一份清单能否用于续传。
 *
 * 必须同时满足：
 *  1. 清单存在且 size 是正数
 *  2. size 与当前期望的 **完全一致**（CDN 换了内容 / 换清晰度都会导致不一致）
 *  3. 没过期
 *  4. 已完成区间有效，且**真的没下完**（下完就没必要续）
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function canResume(meta, expectedSize, { ttlMs = RESUME_TTL_MS, now = Date.now() } = {}) {
  if (!meta || typeof meta !== 'object') return { ok: false, reason: 'meta 为空' };
  const size = Number(meta.size);
  const want = Number(expectedSize);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'meta.size 非法' };
  if (!Number.isFinite(want) || want <= 0) return { ok: false, reason: 'expectedSize 非法' };
  if (size !== want) return { ok: false, reason: `大小不匹配（清单 ${size} vs 期望 ${want}）` };

  const updatedAt = Number(meta.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return { ok: false, reason: '缺少 updatedAt' };
  if (now - updatedAt > ttlMs) return { ok: false, reason: '清单已过期' };

  const ranges = mergeRanges(meta.ranges);
  if (!ranges.length) return { ok: false, reason: '没有已完成区间' };
  const done = completedBytes(ranges);
  if (done <= 0) return { ok: false, reason: '已完成字节为 0' };
  if (done >= size) return { ok: false, reason: '其实已经下完了' };

  return { ok: true, reason: '' };
}

/**
 * OPFS -backed 续传仓库。
 */
export class ResumeStore {
  /**
   * @param {OpfsWorkspace} [workspace]
   * @param {{ ttlMs?: number }} [opts]
   */
  constructor(workspace, opts = {}) {
    this.ws = workspace || new OpfsWorkspace('bdown-resume');
    this.ttlMs = Number(opts.ttlMs) || RESUME_TTL_MS;
  }

  async ensure() {
    return this.ws.ensure();
  }

  /**
   * 读取清单。不存在 / 损坏都返回 null（不抛异常）。
   * @param {string} key
   */
  async read(key) {
    if (!key) return null;
    try {
      const dir = await this.ensure();
      const handle = await dir.getFileHandle(`${key}.json`);
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        key,
        size: Number(parsed.size) || 0,
        ranges: deserialise(parsed.ranges),
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * 写入清单。
   * @param {string} key
   * @param {{ size: number, ranges: {start:number,end:number}[], updatedAt?: number }} meta
   */
  async write(key, meta) {
    if (!key || !meta) return false;
    try {
      const dir = await this.ensure();
      const handle = await dir.getFileHandle(`${key}.json`, { create: true });
      const w = await handle.createWritable();
      await w.write(JSON.stringify({
        key,
        size: Number(meta.size) || 0,
        ranges: serialise(meta.ranges),
        updatedAt: Number(meta.updatedAt) || Date.now(),
      }));
      await w.close();
      return true;
    } catch {
      return false;
    }
  }

  /** 删除清单与分片文件。 */
  async clear(key) {
    if (!key) return;
    await this.ws.remove(`${key}.json`);
    await this.ws.remove(`${key}.part`);
  }

  /**
   * 打开（或新建）分片文件，并给出可续传的区间。
   *
   * @param {string} key
   * @param {number} size 期望的总大小
   * @returns {Promise<{ sink: FileHandleSink, ranges: {start:number,end:number}[], resumed: boolean }>}
   */
  async openPartial(key, size) {
    const dir = await this.ensure();
    const handle = await dir.getFileHandle(`${key}.part`, { create: true });
    const sink = await new FileHandleSink(handle).open();

    // 以实际文件长度为准修正 size（避免清单偏大导致末尾越界）
    let realSize = Number(size) || 0;
    try {
      const f = await handle.getFile();
      if (f.size > 0 && (!realSize || f.size !== realSize)) {
        // 文件内容比清单短很正常（还没下完）；比清单长说明清单过期，以文件为准
        if (!realSize || f.size > realSize) realSize = f.size;
      }
    } catch { /* ignore */ }

    const meta = await this.read(key);
    const verdict = canResume(meta, realSize, { ttlMs: this.ttlMs });
    if (!verdict.ok) {
      return { sink, ranges: [], resumed: false };
    }
    return { sink, ranges: mergeRanges(meta.ranges), resumed: true };
  }
}
