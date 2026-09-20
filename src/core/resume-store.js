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
import { warn } from './util.js';

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
 * 纯函数：拿到一份清单后，决定这一轨该怎么续。
 *
 * 单独抽出来是因为 OPFS 行为在 CI 里没法验证，而"该不该续、续哪些区间"
 * 是**完全确定**的逻辑，必须 100% 覆盖 —— 判断错一次的代价是把一份
 * 已经下完的 .part 抹掉重下，或者续到一份残缺数据上。
 *
 * @param {object|null} meta 清单（来自 ResumeStore.read）
 * @param {number} realSize 这一轨的真实总字节数
 * @returns {{ kind: 'complete'|'partial'|'fresh', ranges: {start:number,end:number}[], reason: string }}
 *   complete —— 清单显示**已经下完**：直接跳过下载（ranges = 全量）
 *   partial  —— 可以续：ranges 是已完成区间（半开 [start, end)）
 *   fresh    —— 不能续：调用方必须 truncate(0) 从头下
 */
export function planResume(meta, realSize, { ttlMs = RESUME_TTL_MS, now = Date.now() } = {}) {
  const size = Number(realSize);
  if (!Number.isFinite(size) || size <= 0) {
    return { kind: 'fresh', ranges: [], reason: 'realSize 非法' };
  }

  // ★ complete 必须**先于** canResume 判定。
  //
  // canResume 的契约是「已完成字节 < 总字节才算可续」，所以**下完的轨它一律判 false**。
  // 只依赖它的话，已完成的轨会掉进 fresh 分支被 truncate(0) 整个抹掉重下。
  //
  // 合并模式下这是必现场景：视频轨先下完、音频轨下到一半时暂停 →
  // 继续时视频轨本该直接跳过，却会被重下整份，续传等于没生效。
  // （前提：fetchTo 成功时写"全量区间"清单而不是 clear，见 engine.markTrackComplete。）
  if (meta && Number(meta.size) === size) {
    const ranges = mergeRanges(meta.ranges);
    if (ranges.length && completedBytes(ranges) >= size) {
      // 返回一个"全量已完成"的区间：downloadRanged 会算出 0 个缺口、
      // 起 0 个 worker 直接返回，一个字节都不用再下。
      return { kind: 'complete', ranges: [{ start: 0, end: size }], reason: '' };
    }
  }

  const verdict = canResume(meta, size, { ttlMs, now });
  if (!verdict.ok) return { kind: 'fresh', ranges: [], reason: verdict.reason };
  return { kind: 'partial', ranges: mergeRanges(meta.ranges), reason: '' };
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
    const plan = planResume(meta, realSize, { ttlMs: this.ttlMs });

    if (plan.kind === 'fresh') {
      // ★ 不能续传时必须**真的截断** .part 文件。
      //
      // 只返回 `ranges: []` 而不截断的话：调用方（engine.prepareStage → fetchTo）
      // 正常路径**不会**调 resetSink（resetSink 只在 catch 分支里调），
      // 于是旧的 .part 内容原样保留。新内容比它短时 → 尾部残留上一轮的字节
      // → 产出"新头 + 旧尾"的坏文件。这与 mergeInto 忘记 truncate 是同一类问题。
      try {
        await sink.truncate(0);
      } catch (err) {
        warn(`续传清单不可用时截断 .part 失败（可能残留旧字节）`, err?.message);
      }
      return { sink, ranges: [], resumed: false };
    }
    const ranges = plan.ranges;
    // ★ 必须把已续上的字节数回填给 sink.size。
    //
    // FileHandleSink 的 size 只在 writeAt 时按 `max(size, offset+len)` 增长，
    // 而续传跳过已完成的区间时**根本不会 writeAt**，于是 size 还是 0。
    // 上层（engine.refreshProgress）正是拿 `staging.video.size` 算进度的 ——
    // 不回填的话，续传后进度条会先退回到 0 再慢慢涨回去，看起来像"重新开始下了"。
    sink.size = completedBytes(ranges);
    return { sink, ranges, resumed: true };
  }
}
