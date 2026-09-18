/**
 * 完整流水线冒烟测试（需要访问 api.bilibili.com 与 CDN，会真实下载数据）。
 *
 * 覆盖：playurl 取流 → Range 分片并发下载 → 无损混流 → 结构校验。
 *
 *   node tools/smoke-pipeline.mjs [bvid] [qn]
 *
 * qn 建议用小清晰度（16 = 360P）以节省流量。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { BiliApi, pickVideoTrack, pickAudioTrack } from '../src/core/api.js';
import { downloadRanged } from '../src/core/downloader.js';
import { MemorySink } from '../src/core/sink.js';
import { blobSource, memorySource, mergeDashStream, scanFile } from '../src/core/mp4.js';
import { formatBytes } from '../src/core/util.js';

const bvid = process.argv[2] || 'BV1GJ411x7h7';
const qn = Number(process.argv[3] || 16);

let failures = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${msg}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const api = new BiliApi();

console.log(`\n[1] 取流（${bvid} / qn=${qn}）`);
const info = await api.videoInfo({ bvid });
const cid = info.pages[0].cid;
const play = await api.playurl({ bvid, cid, qn, mode: 'dash' });
const video = pickVideoTrack(play.videos, play.acceptQuality.includes(qn) ? qn : play.acceptQuality.at(-1), 'avc');
const audio = pickAudioTrack(play.audios);
console.log(`  · 视频轨 ${video.quality} ${video.codec} ${video.width}x${video.height}，预估 ${formatBytes(video.size)}`);
console.log(`  · 音轨 ${audio.label}（${audio.codecs}），预估 ${formatBytes(audio.size)}`);

console.log('\n[2] Range 分片并发下载');
async function grab(track, label) {
  const sink = new MemorySink();
  let last = 0;
  const t0 = Date.now();
  const res = await downloadRanged({
    urls: [track.url, ...track.backupUrls],
    size: track.size,
    sink,
    concurrency: 8,
    onProgress: (p) => {
      last = p.ratio;
    },
  });
  const elapsed = (Date.now() - t0) / 1000;
  const bytes = sink.size;
  console.log(
    `  · ${label}: ${formatBytes(bytes)} / ${elapsed.toFixed(2)}s = ${formatBytes(bytes / elapsed)}/s（进度 ${(last * 100).toFixed(0)}%）`
  );
  const blob = sink.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

const vBytes = await grab(video, '视频轨');
const aBytes = await grab(audio, '音轨  ');
ok(vBytes.length > 0, '视频轨下载非空', formatBytes(vBytes.length));
ok(aBytes.length > 0, '音轨下载非空', formatBytes(aBytes.length));

const vScan = await scanFile(memorySource(vBytes));
const aScan = await scanFile(memorySource(aBytes));
console.log(`  · 视频 ${vScan.fragments.length} 个片段 / ${vScan.duration.toFixed(2)}s`);
console.log(`  · 音频 ${aScan.fragments.length} 个片段 / ${aScan.duration.toFixed(2)}s`);

console.log('\n[3] 无损混流');
const parts = [];
const t0 = Date.now();
const merged = await mergeDashStream({
  videoSource: memorySource(vBytes),
  audioSource: memorySource(aBytes),
  write: async (c) => parts.push(Buffer.from(c)),
});
const out = Buffer.concat(parts);
console.log(`  · ${formatBytes(out.length)}，${merged.fragments} 个片段，耗时 ${Date.now() - t0} ms`);
const outPath = 'bdown-pipeline-test.mp4';
fs.writeFileSync(outPath, out);
console.log(`  · 已写入 ${outPath}`);

console.log('\n[4] 校验');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function hashes(buf) {
  const scan = await scanFile(blobSource(new Blob([buf])));
  return scan.fragments
    .map((f) => {
      const copy = Buffer.from(buf.subarray(f.moofStart, f.moofStart + f.totalSize));
      copy.fill(0, f.mfhdSeqOffset - f.moofStart, f.mfhdSeqOffset - f.moofStart + 4);
      if (f.tfhdTrackIdOffset >= 0) {
        copy.fill(0, f.tfhdTrackIdOffset - f.moofStart, f.tfhdTrackIdOffset - f.moofStart + 4);
      }
      return sha(copy);
    })
    .sort();
}
const srcHashes = [...(await hashes(Buffer.from(vBytes))), ...(await hashes(Buffer.from(aBytes)))].sort();
const outHashes = await hashes(out);
ok(srcHashes.length === outHashes.length, '片段总数一致', `${srcHashes.length} vs ${outHashes.length}`);
ok(srcHashes.every((h, i) => h === outHashes[i]), '媒体字节逐片段完全一致（SHA-256）');
ok(out.length > vBytes.length + aBytes.length - 4096, '输出体积合理');

console.log(`\n${failures ? '\u274c' : '\u2705'} 流水线冒烟测试完成，失败 ${failures} 项\n`);
process.exit(failures ? 1 : 0);
