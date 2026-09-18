/**
 * 混流器回归自检（合成数据版，不依赖任何外部素材）。
 *
 * 用代码构造两个结构合法的 fragmented MP4（视频轨 + 音频轨），跑一遍合并，
 * 再逐项校验结果。适合在 CI 里跑，也方便在没有真实 B 站素材时验证改动。
 *
 *   node tools/selftest-synthetic.mjs
 */

import crypto from 'node:crypto';
import { blobSource, mergeDashStream, scanFile, listBoxes, findBox } from '../src/core/mp4.js';

/* ------------------------------------------------------------------ *
 * 合成 fMP4
 * ------------------------------------------------------------------ */

function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
};

/**
 * 生成一个单轨的 fragmented MP4。
 * @param {object} o
 * @param {'vide'|'soun'} o.handler
 * @param {string} o.sampleEntry 'avc1' | 'mp4a'
 * @param {number} o.timescale
 * @param {number} o.fragments 片段数
 * @param {number} o.samplesPerFragment 每片段样本数
 * @param {number} o.sampleDuration 每样本时长（以 timescale 计）
 * @param {number} o.sampleSize 每样本字节数
 * @param {number} [o.fill] 填充字节值，便于区分两条轨道
 */
function buildFmp4({ handler, sampleEntry, timescale, fragments, samplesPerFragment, sampleDuration, sampleSize, fill = 0 }) {
  const ftyp = box(
    'ftyp',
    Buffer.from('iso5', 'latin1'),
    u32(0x200),
    Buffer.from('iso5iso6mp41dash', 'latin1')
  );

  const mvhd = box(
    'mvhd',
    Buffer.from([0, 0, 0, 0]),
    u32(0),
    u32(0),
    u32(1000), // movie timescale
    u32(0), // duration = 0（分片流）
    u32(0x00010000),
    u16(0x0100),
    Buffer.alloc(2),
    Buffer.alloc(8),
    Buffer.from([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00,
    ]),
    Buffer.alloc(8), // matrix 剩余 2 组
    Buffer.alloc(24), // pre_defined[6]
    u32(2) // next_track_ID
  );

  const tkhd = box(
    'tkhd',
    Buffer.from([0, 0, 0, 7]),
    u32(0),
    u32(0),
    u32(1), // track_ID
    u32(0),
    u32(0),
    Buffer.alloc(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    Buffer.from([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00,
    ]),
    u32(0),
    u32(0)
  );

  const mdhd = box('mdhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', Buffer.from([0, 0, 0, 0]), u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('\0', 'latin1'));
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0]), u32(1), box(sampleEntry, Buffer.alloc(78)));
  const stts = box('stts', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsc = box('stsc', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsz = box('stsz', Buffer.from([0, 0, 0, 0]), u32(0), u32(0));
  const stco = box('stco', Buffer.from([0, 0, 0, 0]), u32(0));
  const dinf = box('dinf', box('dref', Buffer.from([0, 0, 0, 0]), u32(1), box('url ', Buffer.from([0, 0, 0, 1]))));
  const minf = box(
    'minf',
    handler === 'vide' ? box('vmhd', Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)) : box('smhd', Buffer.from([0, 0, 0, 0]), Buffer.alloc(4)),
    dinf,
    box('stbl', stsd, stts, stsc, stsz, stco)
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));

  // 与 B 站真实文件一致：tfhd 带 default-base-is-moof(0x020000)，
  // 样本时长放在 trex 的 default_sample_duration 里
  const trex = box(
    'trex',
    Buffer.from([0, 0, 0, 0]),
    u32(1), // track_ID
    u32(1), // default_sample_description_index
    u32(sampleDuration),
    u32(0),
    u32(0x00010000)
  );
  const mehd = box('mehd', Buffer.from([0, 0, 0, 0]), u32(0));
  const mvex = box('mvex', mehd, trex);

  const moov = box('moov', mvhd, mvex, trak);

  // 片段
  const chunks = [ftyp, moov];
  for (let i = 0; i < fragments; i++) {
    const sampleCount = samplesPerFragment;
    // trun: header(8) + ver/flags(4) + count(4) + data_offset(4) + (size(4) + cto(4)) * n
    const trunSize = 20 + 8 * sampleCount;
    const trafSize = 16 + 16 + trunSize;
    const moofSize = 16 + trafSize;
    const dataOffset = moofSize + 8; // 跳过 mdat 的 8 字节头部

    const mfhd = box('mfhd', Buffer.from([0, 0, 0, 0]), u32(i + 1));
    const tfhd = box('tfhd', Buffer.from([0x00, 0x02, 0x00, 0x00]), u32(1));
    const tfdt = box('tfdt', Buffer.from([0, 0, 0, 0]), u32(i * sampleCount * sampleDuration));

    const trunParts = [
      Buffer.from([0, 0, 0x0a, 0x05]), // data_offset | first_sample_flags | sample_size | cto
      u32(sampleCount),
      u32(dataOffset),
      u32(0x02000000), // first_sample_flags
    ];
    for (let s = 0; s < sampleCount; s++) {
      trunParts.push(u32(sampleSize));
      trunParts.push(u32(0));
    }
    const trun = box('trun', ...trunParts);
    const traf = box('traf', tfhd, tfdt, trun);
    const moof = box('moof', mfhd, traf);

    const mdat = box('mdat', Buffer.alloc(sampleCount * sampleSize, fill + i));
    chunks.push(moof, mdat);
  }

  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

let failures = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${msg}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fragmentHashes(buf) {
  const scan = await scanFile(blobSource(new Blob([buf])));
  const hashes = [];
  for (const f of scan.fragments) {
    const copy = Buffer.from(buf.subarray(f.moofStart, f.moofStart + f.totalSize));
    copy.fill(0, f.mfhdSeqOffset - f.moofStart, f.mfhdSeqOffset - f.moofStart + 4);
    if (f.tfhdTrackIdOffset >= 0) {
      copy.fill(0, f.tfhdTrackIdOffset - f.moofStart, f.tfhdTrackIdOffset - f.moofStart + 4);
    }
    hashes.push(sha(copy));
  }
  return { hashes: hashes.sort(), scan };
}

const readU32 = (buf, off) => buf.readUInt32BE(off);

async function main() {
  console.log('\n[1] 构造合成 DASH 流');
  const video = buildFmp4({
    handler: 'vide',
    sampleEntry: 'avc1',
    timescale: 16000,
    fragments: 3,
    samplesPerFragment: 4,
    sampleDuration: 640,
    sampleSize: 1024,
    fill: 0x10,
  });
  const audio = buildFmp4({
    handler: 'soun',
    sampleEntry: 'mp4a',
    timescale: 48000,
    fragments: 2,
    samplesPerFragment: 5,
    sampleDuration: 1024,
    sampleSize: 256,
    fill: 0x80,
  });
  console.log(`  · video: ${video.length} 字节, audio: ${audio.length} 字节`);

  console.log('\n[2] 合并');
  const parts = [];
  const result = await mergeDashStream({
    videoSource: blobSource(new Blob([video])),
    audioSource: blobSource(new Blob([audio])),
    write: async (c) => parts.push(Buffer.from(c)),
  });
  const out = Buffer.concat(parts);
  console.log(`  · 输出 ${out.length} 字节，${result.fragments} 个片段`);
  ok(result.fragments === 5, '片段数 = 3(视频) + 2(音频)');

  console.log('\n[3] 媒体数据一致性');
  const v = await fragmentHashes(video);
  const a = await fragmentHashes(audio);
  const o = await fragmentHashes(out);
  const srcAll = [...v.hashes, ...a.hashes].sort();
  ok(srcAll.length === o.hashes.length, '片段总数一致', `${srcAll.length} vs ${o.hashes.length}`);
  ok(srcAll.every((h, i) => h === o.hashes[i]), '媒体字节逐片段完全一致');

  console.log('\n[4] 结构');
  const top = listBoxes(out, 0, out.length);
  ok(top[0].type === 'ftyp', 'ftyp 在开头');
  ok(top[1].type === 'moov', 'moov 紧跟 ftyp');
  const moovKids = listBoxes(out, top[1].start + 8, top[1].end);
  const traks = moovKids.filter((b) => b.type === 'trak');
  ok(traks.length === 2, 'moov 含 2 条 trak');
  const ids = traks.map((t) => {
    const tkhd = findBox(listBoxes(out, t.start + 8, t.end), 'tkhd');
    // version/flags(4) + creation(4) + modification(4) -> track_ID
    return readU32(out, tkhd.start + tkhd.headerSize + 12);
  });
  ok(ids[0] === 1 && ids[1] === 2, 'track_ID = [1, 2]', JSON.stringify(ids));
  const mvex = findBox(moovKids, 'mvex');
  const trexs = listBoxes(out, mvex.start + 8, mvex.end).filter((b) => b.type === 'trex');
  ok(trexs.length === 2, 'mvex 含 2 条 trex');
  ok(
    trexs.map((t) => readU32(out, t.start + t.headerSize + 4)).sort().join(',') === '1,2',
    'trex track_ID = [1, 2]'
  );

  console.log('\n[5] 片段序列');
  const seqs = [];
  const trackCount = {};
  let badFlags = 0;
  for (const b of top) {
    if (b.type !== 'moof') continue;
    const kids = listBoxes(out, b.start + 8, b.end);
    const mfhd = findBox(kids, 'mfhd');
    seqs.push(readU32(out, mfhd.start + mfhd.headerSize + 4));
    const tfhd = findBox(listBoxes(out, findBox(kids, 'traf').start + 8, findBox(kids, 'traf').end), 'tfhd');
    const flags = out.readUInt32BE(tfhd.start + tfhd.headerSize) & 0xffffff;
    if ((flags & 0x020000) !== 0x020000) badFlags += 1;
    const tid = readU32(out, tfhd.start + tfhd.headerSize + 4);
    trackCount[tid] = (trackCount[tid] || 0) + 1;
  }
  ok(seqs.every((s, i) => s === i + 1), 'mfhd.sequence_number 从 1 连续递增', seqs.join(','));
  ok(trackCount[1] === 3 && trackCount[2] === 2, '每轨片段数正确', JSON.stringify(trackCount));
  ok(badFlags === 0, '所有 tfhd 带 default-base-is-moof');

  console.log(`\n${failures ? '\u274c' : '\u2705'} 合成自检完成，失败 ${failures} 项\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
