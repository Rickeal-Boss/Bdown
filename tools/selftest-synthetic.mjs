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

// 合成 fMP4 的实现统一放在 tools/fixtures/fmp4.mjs —— 以前这里有一份独立拷贝，
// 两处会各自跑偏（就出现过 data_offset 算错 20 字节、只有一处被修的情况）。
import { box, u32, u16, buildFmp4 } from './fixtures/fmp4.mjs';

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
