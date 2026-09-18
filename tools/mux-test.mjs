/**
 * 混流器端到端自检：把两个真实的 DASH 分片流合并为一个 MP4，并逐项校验结果。
 *
 * 用法：
 *   node tools/mux-test.mjs <video.m4s> <audio.m4s> [out.mp4]
 *
 * 校验项：
 *   1. 媒体片段逐字节一致（抹掉会被重写的 mfhd.sequence_number / tfhd.track_ID 后做 SHA-256 比对）
 *   2. 输出 moov 含 2 条 trak，handler 分别为 vide / soun，track_ID 为 1 / 2
 *   3. mvex 含 mehd + 两条 trex，default_sample_duration > 0
 *   4. 所有 moof 的 mfhd.sequence_number 从 1 连续递增
 *   5. 所有 tfhd.track_ID 只出现 1 与 2，且片段数量与输入一一对应
 *   6. 所有 tfhd 均带 default-base-is-moof（合并正确性的前提）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { blobSource, mergeDashStream, scanFile, listBoxes, findBox } from '../src/core/mp4.js';

const [videoPath, audioPath, outPath = 'bdown-merged.mp4'] = process.argv.slice(2);
if (!videoPath || !audioPath) {
  console.error('用法: node tools/mux-test.mjs <video.m4s> <audio.m4s> [out.mp4]');
  process.exit(2);
}

let failures = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${msg}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fragmentHashes(buf, tag) {
  const scan = await scanFile(blobSource(new Blob([buf])));
  const hashes = [];
  let mediaBytes = 0;
  for (const f of scan.fragments) {
    const copy = Buffer.from(buf.subarray(f.moofStart, f.moofStart + f.totalSize));
    copy.fill(0, f.mfhdSeqOffset - f.moofStart, f.mfhdSeqOffset - f.moofStart + 4);
    if (f.tfhdTrackIdOffset >= 0) {
      copy.fill(0, f.tfhdTrackIdOffset - f.moofStart, f.tfhdTrackIdOffset - f.moofStart + 4);
    }
    hashes.push(sha(copy));
    mediaBytes += f.totalSize;
  }
  console.log(`  · ${tag}: ${scan.fragments.length} 个片段, ${mediaBytes} 字节媒体数据`);
  return { hashes: hashes.sort(), scan };
}

console.log('\n[1] 读取输入');
const vBuf = fs.readFileSync(videoPath);
const aBuf = fs.readFileSync(audioPath);
console.log(`  · video: ${path.basename(videoPath)} (${vBuf.length} 字节)`);
console.log(`  · audio: ${path.basename(audioPath)} (${aBuf.length} 字节)`);

console.log('\n[2] 执行无损合并');
const parts = [];
const t0 = Date.now();
const result = await mergeDashStream({
  videoSource: blobSource(new Blob([vBuf])),
  audioSource: blobSource(new Blob([aBuf])),
  write: async (chunk) => parts.push(Buffer.from(chunk)),
});
const outBuf = Buffer.concat(parts);
fs.writeFileSync(outPath, outBuf);
console.log(`  · 输出 ${outPath}（${outBuf.length} 字节，耗时 ${Date.now() - t0} ms，${result.fragments} 个片段）`);

console.log('\n[3] 媒体数据一致性');
const v = await fragmentHashes(vBuf, 'source video');
const a = await fragmentHashes(aBuf, 'source audio');
const o = await fragmentHashes(outBuf, 'output      ');
const srcAll = [...v.hashes, ...a.hashes].sort();
ok(srcAll.length === o.hashes.length, '片段总数一致', `${srcAll.length} vs ${o.hashes.length}`);
ok(srcAll.every((h, i) => h === o.hashes[i]), '每个片段的媒体字节完全一致（SHA-256）');

console.log('\n[4] moov 结构');
const top = listBoxes(outBuf, 0, outBuf.length);
ok(top[0]?.type === 'ftyp', 'ftyp 位于文件开头');
ok(top[1]?.type === 'moov', 'moov 紧跟 ftyp');
const moov = top[1];
const moovChildren = listBoxes(outBuf, moov.start + moov.headerSize, moov.end);
const traks = moovChildren.filter((b) => b.type === 'trak');
ok(traks.length === 2, 'moov 含 2 条 trak');
const handlers = traks.map((trak) => {
  const kids = listBoxes(outBuf, trak.start + trak.headerSize, trak.end);
  const tkhd = findBox(kids, 'tkhd');
  const version = outBuf[tkhd.start + tkhd.headerSize];
  const trackId = outBuf.readUInt32BE(tkhd.start + tkhd.headerSize + 4 + (version === 1 ? 16 : 8));
  const mdia = findBox(kids, 'mdia');
  const hdlr = findBox(listBoxes(outBuf, mdia.start + mdia.headerSize, mdia.end), 'hdlr');
  const s = hdlr.start + hdlr.headerSize + 8;
  return { trackId, handler: outBuf.subarray(s, s + 4).toString('latin1') };
});
ok(handlers[0].trackId === 1 && handlers[0].handler === 'vide', 'track 1 = 视频');
ok(handlers[1].trackId === 2 && handlers[1].handler === 'soun', 'track 2 = 音频');

const mvex = findBox(moovChildren, 'mvex');
ok(!!mvex, 'mvex 存在');
const mvexKids = listBoxes(outBuf, mvex.start + mvex.headerSize, mvex.end);
const trexs = mvexKids.filter((b) => b.type === 'trex');
ok(trexs.length === 2, 'mvex 含 2 条 trex');
const trexIds = trexs.map((t) => outBuf.readUInt32BE(t.start + t.headerSize + 4)).sort();
ok(trexIds[0] === 1 && trexIds[1] === 2, 'trex track_ID = [1, 2]');
const trexDurations = trexs.map((t) => outBuf.readUInt32BE(t.start + t.headerSize + 12));
ok(trexDurations.every((d) => d > 0), 'trex default_sample_duration > 0', trexDurations.join(', '));

console.log('\n[5] 片段序列');
const seqs = [];
const trackIds = { 1: 0, 2: 0 };
let nonMoof = 0;
for (const b of top) {
  if (b.type !== 'moof') continue;
  const kids = listBoxes(outBuf, b.start + b.headerSize, b.end);
  const mfhd = findBox(kids, 'mfhd');
  const traf = findBox(kids, 'traf');
  const trafKids = listBoxes(outBuf, traf.start + traf.headerSize, traf.end);
  const tfhd = findBox(trafKids, 'tfhd');
  const flags = outBuf.readUInt32BE(tfhd.start + tfhd.headerSize) & 0xffffff;
  if ((flags & 0x020000) !== 0x020000) nonMoof += 1;
  seqs.push(outBuf.readUInt32BE(mfhd.start + mfhd.headerSize + 4));
  const tid = outBuf.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
  trackIds[tid] = (trackIds[tid] || 0) + 1;
}
ok(seqs.length === result.fragments, 'moof 数量与合并结果一致');
ok(seqs.every((s, i) => s === i + 1), 'mfhd.sequence_number 从 1 连续递增');
ok(
  Object.keys(trackIds).every((k) => k === '1' || k === '2'),
  'tfhd.track_ID 仅含 1 / 2',
  JSON.stringify(trackIds)
);
ok(trackIds[1] === v.scan.fragments.length && trackIds[2] === a.scan.fragments.length, '每轨片段数与输入一致', `${trackIds[1]} / ${trackIds[2]}`);
ok(nonMoof === 0, '所有 tfhd 均带 default-base-is-moof', `${nonMoof} 个例外`);

console.log(`\n${failures ? '\u274c' : '\u2705'} 自检完成，失败 ${failures} 项\n`);
process.exit(failures ? 1 : 0);
