/**
 * 轻量 MP4 (ISO BMFF) 盒子解析与 DASH 无损合并。
 *
 * ## 为什么需要它
 * B 站高清视频（>=720P60 / 1080P+ / 4K / 8K / HDR / 杜比视界）只提供 DASH 格式：
 * 视频轨与音频轨是两个独立的 fragmented MP4（`*.m4s`）。直接拼接两个文件得到的是
 * 无法播放的垃圾数据，必须做「混流（mux）」。
 *
 * ## 实现思路（无损、可流式）
 * 观察 B 站 m4s 的实际结构（本项目已用真实文件核对）：
 *
 *   ftyp + free* + moov{ mvhd, mvex{ mehd, trex, trep }, trak{...track_ID=1...}, udta }
 *        + sidx + [ moof{ mfhd, traf{ tfhd(track_ID=1, flags=0x020000), tfdt, trun } } + mdat ] × N
 *
 * 关键点：`tfhd` 的 flags 带 `default-base-is-moof (0x020000)`，即 `trun` 里的
 * `data_offset` 是相对于所属 `moof` 起点的偏移。于是只要 **moof 与紧随其后的 mdat
 * 作为一个整体搬迁**，所有样本的字节位置就完全不需要重算 —— 媒体数据可以逐字节
 * 原样复制，零解码、零重编码、零质量损失。
 *
 * 因此合并只需三步：
 *   1. 复制视频文件的 ftyp；
 *   2. 重建一个 moov：把视频的 trak 与音频的 trak 放进同一个 moov（track_ID 改为 1 / 2），
 *      并重建 mvex（mehd + 两条 trex）；
 *   3. 按解码时间戳把两个文件的 moof+mdat 片段交错写出，同时修正
 *      `mfhd.sequence_number` 与 `tfhd.track_ID`。
 *
 * 输出为标准 fragmented MP4，Chrome / Edge / VLC / mpv / ffmpeg / PotPlayer 均可直接播放。
 */

import { warn } from './util.js';

/** @typedef {{ size: number, read(offset: number, length: number): Promise<Uint8Array> }} RandomSource */
/** @typedef {{ type: string, size: number, headerSize: number, start: number, end: number }} Box */

/* ------------------------------------------------------------------ *
 * 数据源
 * ------------------------------------------------------------------ */

/** @returns {RandomSource} */
export function memorySource(bytes) {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    },
  };
}

/** 基于 File / Blob（含 OPFS 文件）的随机读取数据源。 */
export function blobSource(blob) {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(blob.size, offset + length);
      const buf = await blob.slice(offset, end).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

/* ------------------------------------------------------------------ *
 * 盒子解析
 * ------------------------------------------------------------------ */

/** 支持 64 位 largesize 与 size=0（延伸到末尾）两种写法。 */
export function readBoxHeader(bytes, offset, limit = bytes.length) {
  if (offset + 8 > limit) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = dv.getUint32(offset);
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = dv.getUint32(offset + 8) * 4294967296 + dv.getUint32(offset + 12);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return null;
  return { type, size, headerSize, start: offset, end: offset + size };
}

/**
 * 只解析盒子头部，不校验 size 是否落在已读取的范围内。
 * 用于「只想知道后面那个 mdat 有多大，但不想读整个 mdat」的场景。
 */
export function readBoxHeaderLoose(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = dv.getUint32(offset);
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    size = dv.getUint32(offset + 8) * 4294967296 + dv.getUint32(offset + 12);
    headerSize = 16;
  }
  if (size < headerSize) return null;
  return { type, size, headerSize, start: offset, end: offset + size };
}

/** 列出 [start, end) 范围内的同级盒子。 */
export function listBoxes(bytes, start = 0, end = bytes.length) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    const box = readBoxHeader(bytes, off, end);
    if (!box) break;
    out.push(box);
    off = box.end;
  }
  return out;
}

export function findBox(boxes, type) {
  return boxes.find((b) => b.type === type) || null;
}

export function findBoxes(boxes, type) {
  return boxes.filter((b) => b.type === type);
}

/** 容器盒子的子盒子列表。 */
export function childrenOf(bytes, box) {
  if (!box) return [];
  return listBoxes(bytes, box.start + box.headerSize, box.end);
}

function u32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function setU32(bytes, offset, value) {
  if (offset < 0 || offset + 4 > bytes.length) return false;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0);
  return true;
}

function boxFlags(bytes, box) {
  return (bytes[box.start + box.headerSize + 1] << 16)
    | (bytes[box.start + box.headerSize + 2] << 8)
    | bytes[box.start + box.headerSize + 3];
}

/** mdhd.timescale（媒体时间刻度）。 */
export function readMdhdTimescale(bytes, mdhd) {
  const version = bytes[mdhd.start + mdhd.headerSize];
  // version/flags(4) + creation + modification -> timescale
  const offset = mdhd.start + mdhd.headerSize + 4 + (version === 1 ? 16 : 8);
  return u32(bytes, offset);
}

/** mvhd.timescale（影片时间刻度）。 */
export function readMvhdTimescale(bytes, mvhd) {
  const version = bytes[mvhd.start + mvhd.headerSize];
  const offset = mvhd.start + mvhd.headerSize + 4 + (version === 1 ? 16 : 8);
  return u32(bytes, offset);
}

/** trak 的 track_ID。 */
export function readTkhdTrackId(bytes, tkhd) {
  const version = bytes[tkhd.start + tkhd.headerSize];
  const offset = tkhd.start + tkhd.headerSize + 4 + (version === 1 ? 16 : 8);
  return u32(bytes, offset);
}

/** 在「以盒子起点为 0」的字节里定位 track_ID 字段。 */
function trackIdFieldOffset(boxBytes, type) {
  const box = readBoxHeader(boxBytes, 0);
  if (!box) return -1;
  const version = boxBytes[box.headerSize];
  // version(1)+flags(3) 之后
  if (type === 'tkhd') return box.headerSize + 4 + (version === 1 ? 16 : 8);
  if (type === 'trex') return box.headerSize + 4;
  return -1;
}

/* ------------------------------------------------------------------ *
 * 文件扫描
 * ------------------------------------------------------------------ */

const READ_AHEAD = 16 * 1024;

/**
 * 扫描一个 m4s 文件，取出合并所需的全部信息。
 * @param {RandomSource} source
 */
export async function scanFile(source) {
  const head = await source.read(0, Math.min(source.size, READ_AHEAD));
  const top = listBoxes(head, 0, head.length);

  let ftypBox = null;
  let moovBox = null;
  for (const b of top) {
    if (b.type === 'ftyp') ftypBox = b;
    else if (b.type === 'moov') moovBox = b;
    else if (b.type === 'moof') break;
  }
  if (!moovBox) throw new Error('不是有效的 MP4：未找到 moov 盒子（该文件可能不是 DASH 分片流）');

  const moov = await source.read(moovBox.start, moovBox.size);
  const ftyp = ftypBox ? await source.read(ftypBox.start, ftypBox.size) : defaultFtyp();

  const moovChildren = listBoxes(moov, moovBox.headerSize, moov.length);
  const mvhd = findBox(moovChildren, 'mvhd');
  const movieTimescale = mvhd ? readMvhdTimescale(moov, mvhd) : 1000;

  const trak = findBox(moovChildren, 'trak');
  const mdia = trak ? findBox(childrenOf(moov, trak), 'mdia') : null;
  const mdhd = mdia ? findBox(childrenOf(moov, mdia), 'mdhd') : null;
  const mediaTimescale = mdhd ? readMdhdTimescale(moov, mdhd) : movieTimescale;

  // trex.default_sample_duration：B 站 m4s 的 tfhd 不带 default_sample_duration，
  // 样本时长实际记录在 trex 里，取出来作为兜底。
  const mvex = findBox(moovChildren, 'mvex');
  const trex = mvex ? findBox(childrenOf(moov, mvex), 'trex') : null;
  const trexDefaults = trex ? readTrexDefaults(moov, trex) : null;

  // 顺序扫描片段（moof + 紧随其后的 mdat）
  const fragments = [];
  let off = moovBox.end;
  let sequence = 0;

  while (off + 8 <= source.size) {
    const chunk = await source.read(off, Math.min(READ_AHEAD, source.size - off));
    if (chunk.length < 8) break;
    const boxes = listBoxes(chunk, 0, chunk.length);
    if (!boxes.length) {
      // 无法解析：避免死循环，直接放弃后续片段
      break;
    }

    let handled = false;
    for (const b of boxes) {
      const absStart = off + b.start;
      if (b.type === 'moof') {
        const tail = await source.read(absStart + b.size, 8);
        const mdatHeader = tail.length >= 8 ? readBoxHeaderLoose(tail, 0) : null;
        const mdatSize = mdatHeader && mdatHeader.type === 'mdat' ? mdatHeader.size : 0;
        const info = parseMoof(chunk.subarray(b.start, b.end), absStart, mediaTimescale, trexDefaults);
        fragments.push({
          moofStart: absStart,
          totalSize: b.size + mdatSize,
          trackId: info.trackId,
          baseTime: info.baseTime,
          duration: info.duration,
          timescale: mediaTimescale,
          tfhdTrackIdOffset: info.tfhdTrackIdOffset,
          tfhdTrackIdOffsets: info.tfhdTrackIdOffsets,
          // moof[0..8] + mfhd size[8..12] + 'mfhd'[12..16] + version/flags[16..20] + sequence_number[20..24]
          mfhdSeqOffset: absStart + 20,
        });
        sequence += 1;
        off = absStart + b.size + mdatSize;
        handled = true;
        break;
      }
      if (['sidx', 'mfra', 'free', 'skip', 'styp', 'mdat', 'udta', 'uuid'].includes(b.type)) {
        off = absStart + b.size;
        handled = true;
        break;
      }
      // 未知盒子：整体跳过，保证前进
      off = absStart + b.size;
      handled = true;
      break;
    }
    if (!handled) break;
    void sequence;
  }

  if (!fragments.length) throw new Error('未在文件中找到媒体片段（moof），无法合并');

  const duration = fragments.reduce((acc, f) => Math.max(acc, f.baseTime + f.duration), 0) / (mediaTimescale || 1);

  return {
    ftyp,
    moov,
    fragments,
    duration,
    timescale: mediaTimescale,
    movieTimescale,
  };
}

/**
 * 单个 trun 里的样本时长总和。
 *
 * 未显式携带 sample_duration 时，回退顺序为：tfhd 的 default_sample_duration
 * → trex 的 default_sample_duration。B 站 m4s 的 tfhd 通常只有
 * default-base-is-moof（0x020000），所以时长实际来自 trex（视频 640、音频 1024）。
 */
function readTrunDuration(bytes, trun, tfhd, trexDefaults) {
  const flags = boxFlags(bytes, trun);
  let p = trun.start + trun.headerSize + 4;
  const sampleCount = u32(bytes, p);
  p += 4;
  if (flags & 0x000001) p += 4; // data_offset（int32，相对 base_data_offset）
  if (flags & 0x000004) p += 4; // first_sample_flags

  const defDuration = tfhd ? readTfhdDefaultDuration(bytes, tfhd) : 0;
  const fallback = defDuration || trexDefaults?.duration || 0;
  const hasDuration = !!(flags & 0x000100);
  let total = 0;
  for (let i = 0; i < sampleCount; i++) {
    if (hasDuration) {
      total += u32(bytes, p);
      p += 4;
    } else {
      total += fallback;
    }
    if (flags & 0x000200) p += 4; // sample_size
    if (flags & 0x000400) p += 4; // sample_flags
    // sample_composition_time_offset：version 1 时是 int32（有符号），
    // 但这里只跳过不取值，所以有无符号都不影响。
    if (flags & 0x000800) p += 4;
  }
  return total;
}

/** 解析 moof，取出轨道号、解码时间与总时长。 */
function parseMoof(moofBytes, absMoofStart, mediaTimescale, trexDefaults) {
  const result = {
    trackId: 1,
    baseTime: 0,
    duration: 0,
    timescale: mediaTimescale,
    tfhdTrackIdOffset: -1,
    /** 一个 moof 可能含多个 traf，每个 traf 的 track_ID 都要单独补。 */
    tfhdTrackIdOffsets: [],
  };
  const self = readBoxHeader(moofBytes, 0, moofBytes.length);
  if (!self || self.type !== 'moof') return result;
  const children = listBoxes(moofBytes, self.headerSize, self.end);
  const trafs = findBoxes(children, 'traf');
  if (!trafs.length) return result;

  let baseTime = Infinity;
  let endTime = 0;

  for (const traf of trafs) {
    const trafChildren = listBoxes(moofBytes, traf.start + traf.headerSize, traf.end);
    const tfhd = findBox(trafChildren, 'tfhd');

    if (tfhd) {
      const flags = boxFlags(moofBytes, tfhd);
      const defaultBaseIsMoof = (flags & 0x020000) !== 0;
      const baseDataOffsetPresent = (flags & 0x000001) !== 0;
      // 无损合并的前提：样本地址相对 moof 起点。若写的是文件绝对地址，
      // 一旦把 moof+mdat 整体搬走，trun.data_offset 就指向了错误位置。
      if (!defaultBaseIsMoof && baseDataOffsetPresent) {
        throw new Error(
          '该媒体片段的 tfhd 使用了绝对 base_data_offset（flags 含 0x000001 且未置 default-base-is-moof），' +
          '搬迁后样本地址会失效，无法无损合并。请改用「仅视频」或「仅音频」模式。'
        );
      }
      const idOffset = absMoofStart + tfhd.start + tfhd.headerSize + 4;
      const trackId = u32(moofBytes, tfhd.start + tfhd.headerSize + 4);
      result.tfhdTrackIdOffsets.push({ offset: idOffset, trackId });
      if (result.tfhdTrackIdOffsets.length === 1) {
        result.tfhdTrackIdOffset = idOffset;
        result.trackId = trackId;
      }
    }

    let trafBaseTime = 0;
    const tfdt = findBox(trafChildren, 'tfdt');
    if (tfdt) {
      const version = moofBytes[tfdt.start + tfdt.headerSize];
      const p = tfdt.start + tfdt.headerSize + 4;
      trafBaseTime =
        version === 1 ? u32(moofBytes, p) * 4294967296 + u32(moofBytes, p + 4) : u32(moofBytes, p);
    }

    let trafDuration = 0;
    for (const trun of findBoxes(trafChildren, 'trun')) {
      trafDuration += readTrunDuration(moofBytes, trun, tfhd, trexDefaults);
    }

    baseTime = Math.min(baseTime, trafBaseTime);
    endTime = Math.max(endTime, trafBaseTime + trafDuration);
  }

  result.baseTime = Number.isFinite(baseTime) ? baseTime : 0;
  result.duration = Math.max(0, endTime - result.baseTime);
  return result;
}

/** trex 的默认样本时长 / 大小 / 描述索引。 */
function readTrexDefaults(moovBytes, trex) {
  const p = trex.start + trex.headerSize + 4 + 4; // version/flags + track_ID
  return {
    descriptionIndex: u32(moovBytes, p),
    duration: u32(moovBytes, p + 4),
    size: u32(moovBytes, p + 8),
  };
}

/** mehd 中的分片总时长（单位 = mvhd timescale）。 */
export function readMehdDuration(moovBytes, mehd) {
  const version = moovBytes[mehd.start + mehd.headerSize];
  const p = mehd.start + mehd.headerSize + 4;
  return version === 1 ? u32(moovBytes, p) * 4294967296 + u32(moovBytes, p + 4) : u32(moovBytes, p);
}

function readTfhdDefaultDuration(bytes, tfhd) {
  const flags = boxFlags(bytes, tfhd);
  let p = tfhd.start + tfhd.headerSize + 4 + 4; // version/flags + track_ID
  if (flags & 0x000001) p += 8;
  if (flags & 0x000002) p += 4;
  if (flags & 0x000008) return u32(bytes, p);
  return 0;
}

/* ------------------------------------------------------------------ *
 * moov 重建
 * ------------------------------------------------------------------ */

function makeBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concatBytes(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/**
 * 合并两个 moov，得到含两条 track 的新 moov。
 * @param {Uint8Array} videoMoov
 * @param {Uint8Array} audioMoov
 * @param {number} durationSeconds
 * @param {number} [movieTimescale]
 */
export function buildMergedMoov(videoMoov, audioMoov, durationSeconds, movieTimescale) {
  const vChildren = listBoxes(videoMoov, 8, videoMoov.length);
  const aChildren = listBoxes(audioMoov, 8, audioMoov.length);

  const mvhdBox = findBox(vChildren, 'mvhd');
  const vTrak = findBox(vChildren, 'trak');
  const aTrak = findBox(aChildren, 'trak');
  if (!mvhdBox || !vTrak || !aTrak) throw new Error('moov 结构异常：缺少 mvhd 或 trak');

  const vMvex = findBox(vChildren, 'mvex');
  const aMvex = findBox(aChildren, 'mvex');
  const vTrex = vMvex ? findBox(childrenOf(videoMoov, vMvex), 'trex') : null;
  const aTrex = aMvex ? findBox(childrenOf(audioMoov, aMvex), 'trex') : null;
  const udta = findBox(vChildren, 'udta');

  // --- mvhd：时长清零（分片流由 mehd 描述总时长），next_track_ID 置 3
  const mvhd = videoMoov.slice(mvhdBox.start, mvhdBox.end);
  const mvhdVersion = mvhd[mvhdBox.headerSize];
  const mvhdTimescaleOffset = mvhdBox.headerSize + 4 + (mvhdVersion === 1 ? 16 : 8);
  const mvhdDurationOffset = mvhdTimescaleOffset + 4;
  // version/flags(4)+creation+modification+timescale+duration+rate+volume+reserved(2)+reserved[2]+matrix[9]+pre_defined[6]
  const nextTrackOffset = mvhdBox.headerSize + (mvhdVersion === 1 ? 108 : 96);
  const scale = movieTimescale || u32(mvhd, mvhdTimescaleOffset);
  if (mvhdVersion === 1) {
    setU32(mvhd, mvhdDurationOffset, 0);
    setU32(mvhd, mvhdDurationOffset + 4, 0);
  } else {
    setU32(mvhd, mvhdDurationOffset, 0);
  }
  if (!setU32(mvhd, nextTrackOffset, 3)) {
    // mvhd 长度异常（罕见），next_track_ID 只是个提示字段，跳过即可
    warn('mvhd 长度异常，跳过 next_track_ID 修正');
  }

  // --- trak：track_ID 规整为 1（视频）/ 2（音频）
  const vTrakBytes = videoMoov.slice(vTrak.start, vTrak.end);
  const aTrakBytes = audioMoov.slice(aTrak.start, aTrak.end);
  patchTrackId(vTrakBytes, 'tkhd', 1);
  patchTrackId(aTrakBytes, 'tkhd', 2);

  // --- mvex：mehd + trex(1) + trex(2)
  const mehdPayload = new Uint8Array(8);
  new DataView(mehdPayload.buffer).setUint32(4, Math.round(durationSeconds * scale));
  const mehd = makeBox('mehd', mehdPayload);

  const mvex = makeBox(
    'mvex',
    concatBytes([
      mehd,
      buildTrex(vTrex ? videoMoov.slice(vTrex.start, vTrex.end) : null, 1),
      buildTrex(aTrex ? audioMoov.slice(aTrex.start, aTrex.end) : null, 2),
    ])
  );

  const parts = [mvhd, mvex, vTrakBytes, aTrakBytes];
  if (udta) parts.push(videoMoov.slice(udta.start, udta.end));
  return makeBox('moov', concatBytes(parts));
}

function patchTrackId(trakBytes, type, id) {
  const boxes = listBoxes(trakBytes, 8, trakBytes.length);
  const target = findBox(boxes, type);
  if (!target) return;
  const offset = trackIdFieldOffset(trakBytes.subarray(target.start, target.end), type);
  if (offset >= 0) setU32(trakBytes, target.start + offset, id);
}

function buildTrex(src, trackId) {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, 32);
  for (let i = 0; i < 4; i++) out[4 + i] = 'trex'.charCodeAt(i);
  // version + flags 保持 0
  if (src && src.length >= 32) {
    out.set(src.subarray(12, 32), 12);
  } else {
    new DataView(out.buffer).setUint32(16, 1); // default_sample_description_index
  }
  new DataView(out.buffer).setUint32(12, trackId);
  return out;
}

function defaultFtyp() {
  const brands = ['isom', 'iso5', 'iso6', 'mp41', 'dash'];
  const payload = new Uint8Array(8 + brands.length * 4);
  payload.set([0x69, 0x73, 0x6f, 0x35], 0); // major_brand = iso5
  new DataView(payload.buffer).setUint32(4, 0x00000200);
  brands.forEach((b, i) => {
    for (let j = 0; j < 4; j++) payload[8 + i * 4 + j] = b.charCodeAt(j);
  });
  return makeBox('ftyp', payload);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 把 DASH 视频轨 + 音频轨合并为一个 MP4，并流式写出。
 *
 * @param {object} o
 * @param {RandomSource} o.videoSource
 * @param {RandomSource} o.audioSource
 * @param {(chunk: Uint8Array) => Promise<void>} o.write 顺序写出数据块
 * @param {(p: { phase: string, ratio: number }) => void} [o.onProgress]
 */
export async function mergeDashStream({ videoSource, audioSource, write, onProgress = () => {} }) {
  onProgress({ phase: 'scan', ratio: 0 });
  const [v, a] = await Promise.all([scanFile(videoSource), scanFile(audioSource)]);

  const duration = Math.max(v.duration, a.duration);
  const moov = buildMergedMoov(v.moov, a.moov, duration, v.movieTimescale);

  let written = 0;
  const emit = async (bytes) => {
    await write(bytes);
    written += bytes.length;
  };

  await emit(v.ftyp);
  await emit(moov);

  // 按解码时间戳（秒）交错两个轨道的片段
  const items = [
    ...v.fragments.map((f) => ({ side: 'v', f, t: f.baseTime / (f.timescale || 1) })),
    ...a.fragments.map((f) => ({ side: 'a', f, t: f.baseTime / (f.timescale || 1) })),
  ].sort((x, y) => x.t - y.t);

  const totalBytes = items.reduce((n, it) => n + it.f.totalSize, 0);
  let doneBytes = 0;
  let seq = 0;
  const COPY_CHUNK = 1 << 20; // 1MB

  for (const item of items) {
    const { f } = item;
    seq += 1;
    const expectedTrackId = item.side === 'v' ? 1 : 2;
    const src = item.side === 'v' ? videoSource : audioSource;

    // 需要打的补丁：mfhd.sequence_number 与（必要时）tfhd.track_ID
    const patches = [{ offset: f.mfhdSeqOffset, value: seq }];
    // 一个 moof 内可能有多个 traf，逐个把 track_ID 统一成 1（视频）/ 2（音频）
    for (const t of f.tfhdTrackIdOffsets || []) {
      if (t.offset >= 0 && t.trackId !== expectedTrackId) {
        patches.push({ offset: t.offset, value: expectedTrackId });
      }
    }
    if (!(f.tfhdTrackIdOffsets || []).length && f.tfhdTrackIdOffset >= 0 && f.trackId !== expectedTrackId) {
      patches.push({ offset: f.tfhdTrackIdOffset, value: expectedTrackId });
    }

    let offset = f.moofStart;
    let remaining = f.totalSize;

    while (remaining > 0) {
      const len = Math.min(COPY_CHUNK, remaining);
      const chunk = await readExact(src, offset, len);
      const chunkEnd = offset + len;
      for (const p of patches) {
        if (p.offset >= offset && p.offset + 4 <= chunkEnd) {
          setU32(chunk, p.offset - offset, p.value);
        }
      }
      await emit(chunk);
      offset += len;
      remaining -= len;
      doneBytes += len;
      onProgress({ phase: 'merge', ratio: Math.min(1, doneBytes / totalBytes) });
    }
  }

  onProgress({ phase: 'merge', ratio: 1 });
  return { bytes: written, fragments: items.length, duration };
}

async function readExact(source, offset, length) {
  const bytes = await source.read(offset, length);
  if (bytes.length === length) return bytes;
  const out = new Uint8Array(length);
  out.set(bytes);
  let filled = bytes.length;
  while (filled < length) {
    const more = await source.read(offset + filled, length - filled);
    if (!more.length) break;
    out.set(more, filled);
    filled += more.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 自检 / 测试辅助
 * ------------------------------------------------------------------ */

/** 统计 MP4 的轨道与片段信息，用于校验合并结果。 */
export function inspectMp4(bytes) {
  const top = listBoxes(bytes, 0, bytes.length);
  const moov = findBox(top, 'moov');
  const info = {
    hasFtyp: !!findBox(top, 'ftyp'),
    hasMoov: !!moov,
    tracks: [],
    fragments: top.filter((b) => b.type === 'moof').length,
    mvex: null,
    bytes: bytes.length,
  };
  if (moov) {
    for (const trak of findBoxes(listBoxes(bytes, moov.start + moov.headerSize, moov.end), 'trak')) {
      const kids = listBoxes(bytes, trak.start + trak.headerSize, trak.end);
      const tkhd = findBox(kids, 'tkhd');
      const mdia = findBox(kids, 'mdia');
      let handler = null;
      let timescale = null;
      let codec = null;
      if (mdia) {
        const mk = listBoxes(bytes, mdia.start + mdia.headerSize, mdia.end);
        const hdlr = findBox(mk, 'hdlr');
        if (hdlr) {
          const s = hdlr.start + hdlr.headerSize + 8;
          handler = String.fromCharCode(bytes[s], bytes[s + 1], bytes[s + 2], bytes[s + 3]);
        }
        const mdhd = findBox(mk, 'mdhd');
        if (mdhd) timescale = readMdhdTimescale(bytes, mdhd);
        const minf = findBox(mk, 'minf');
        if (minf) {
          const stbl = findBox(listBoxes(bytes, minf.start + minf.headerSize, minf.end), 'stbl');
          if (stbl) {
            const stsd = findBox(listBoxes(bytes, stbl.start + stbl.headerSize, stbl.end), 'stsd');
            if (stsd) {
              const entries = listBoxes(bytes, stsd.start + stsd.headerSize + 8, stsd.end);
              if (entries[0]) codec = entries[0].type;
            }
          }
        }
      }
      info.tracks.push({
        trackId: tkhd ? readTkhdTrackId(bytes, tkhd) : null,
        handler,
        timescale,
        codec,
      });
    }
    const mvex = findBox(listBoxes(bytes, moov.start + moov.headerSize, moov.end), 'mvex');
    if (mvex) {
      info.mvex = listBoxes(bytes, mvex.start + mvex.headerSize, mvex.end).map((b) => {
        if (b.type === 'trex') return `trex(track=${u32(bytes, b.start + b.headerSize + 4)})`;
        return b.type;
      });
    }
  }
  return info;
}
