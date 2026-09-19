/**
 * 生成用于 mux-test.mjs 的样本 m4s 文件。
 *
 * 为什么需要：CI 里原来有一条
 *   `if [ -d samples ] && ls samples/*.m4s ...; then node tools/mux-test.mjs; else echo 跳过; fi`
 * 仓库里从来没有 samples/，所以那条**永远走 else 分支**，一直是"跳过的绿"——
 * 看着像有真实素材校验，其实 0 覆盖。
 *
 * 现在改成：用共享夹具现场合成样本再跑，步骤真正执行。
 * 合成的样本与 B 站真实分片的顶层结构一致（ftyp + moov + moof×N + mdat×N）。
 *
 * 用法：node tools/fixtures/make-samples.mjs [输出目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildFmp4 } from './fmp4.mjs';

const outDir = process.argv[2] || 'samples';
fs.mkdirSync(outDir, { recursive: true });

const video = buildFmp4({
  handler: 'vide',
  sampleEntry: 'avc1',
  timescale: 16000,
  fragments: 3,
  samplesPerFragment: 4,
  sampleDuration: 640,
  sampleSize: 512,
  fill: 0x10,
});

const audio = buildFmp4({
  handler: 'soun',
  sampleEntry: 'mp4a',
  timescale: 48000,
  fragments: 2,
  samplesPerFragment: 3,
  sampleDuration: 1024,
  sampleSize: 128,
  fill: 0x80,
});

const vPath = path.join(outDir, 'video.m4s');
const aPath = path.join(outDir, 'audio.m4s');
fs.writeFileSync(vPath, video);
fs.writeFileSync(aPath, audio);

console.log(`已生成样本：${vPath} (${video.length}B) / ${aPath} (${audio.length}B)`);
