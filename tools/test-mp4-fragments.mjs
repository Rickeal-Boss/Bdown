/**
 * 片段扫描的静默失败回归测试（不联网，用合成夹具）。
 *
 * 背景（qa-lead 审计 + 主理人逐行核对，两条独立来源确认）：
 * `readBoxHeader` 要求 `offset + size <= limit`，而片段扫描是在 16KB 的
 * READ_AHEAD 窗口里 `listBoxes`。一旦某个 moof 超过窗口：
 *   - header 解析返回 null
 *   - `listBoxes` 直接 break
 *   - **后面所有片段被静默丢弃**
 * 产出的是「能播但缺半段」的合法 MP4 —— 真机上极难发现，是本项目最危险的失败形态。
 *
 * 修复：改用「松」的头部读取拿到真实 size，再按 size 整块读取，不再依赖窗口。
 *
 * 运行：node tools/test-mp4-fragments.mjs
 */
import { buildFmp4 } from './fixtures/fmp4.mjs';
import { mergeDashStream, memorySource, scanFile, listBoxes } from '../src/core/mp4.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/** 造一个 moof 明显大于 16KB 的 fMP4（trun 里塞很多样本）。 */
function bigMoofFmp4(handler, sampleEntry, timescale, sampleDuration) {
  // trun = 8(hdr) + 4(ver/flags) + 4(count) + 4(data_offset) + 4(first_sample_flags)
  //        + samples * 8
  // 2500 个样本 -> trun ≈ 20KB -> moof > 16KB（必定越过原 READ_AHEAD 窗口）
  return buildFmp4({
    handler,
    sampleEntry,
    timescale,
    fragments: 1,
    samplesPerFragment: 2500,
    sampleDuration,
    sampleSize: 4,
    fill: handler === 'vide' ? 0x10 : 0x80,
  });
}

console.log('\n[1] moof 大于 16KB 时，片段不能被静默丢弃');
{
  const video = bigMoofFmp4('vide', 'avc1', 16000, 640);
  const audio = buildFmp4({
    handler: 'soun', sampleEntry: 'mp4a', timescale: 48000,
    fragments: 1, samplesPerFragment: 3, sampleDuration: 1024, sampleSize: 128, fill: 0x80,
  });

  // 前置：确认视频轨的 moof 确实 > 16KB（否则这个测试没有意义）
  const vTop = listBoxes(video, 0, video.length);
  const vMoof = vTop.find((b) => b.type === 'moof');
  ok('夹具有效：视频轨 moof > 16384 字节', !!vMoof && vMoof.size > 16384,
    vMoof ? `moof=${vMoof.size}` : '未找到 moof');

  const out = [];
  let err = null;
  try {
    await mergeDashStream({
      videoSource: memorySource(new Uint8Array(video)),
      audioSource: memorySource(new Uint8Array(audio)),
      write: async (chunk) => { out.push(chunk); },
    });
  } catch (e) { err = e; }

  ok('合并没有抛错', err === null, err && err.message);
  const blob = Buffer.concat(out.map((c) => Buffer.from(c)));
  const top = listBoxes(new Uint8Array(blob), 0, blob.length);
  const moofs = top.filter((b) => b.type === 'moof');
  // 视频 1 个片段 + 音频 1 个片段 = 2 个 moof。
  // 修复前：视频那个大 moof 会被静默丢弃 -> 只剩 1 个。
  ok('产物包含 2 个 moof（视频大片段没有被丢）',
    moofs.length === 2, `实际 ${moofs.length} 个`);
}

console.log('\n[2] 文件被截断时必须明确报错，不能静默补零');
{
  const video = buildFmp4({
    handler: 'vide', sampleEntry: 'avc1', timescale: 16000,
    fragments: 2, samplesPerFragment: 3, sampleDuration: 640, sampleSize: 512, fill: 0x10,
  });
  // 砍掉最后 100 字节 -> 最后一个 mdat 声明的大小超出实际剩余
  const cut = video.subarray(0, video.length - 100);
  let err = null;
  try {
    await scanFile(memorySource(new Uint8Array(cut)));
  } catch (e) { err = e; }
  ok('截断文件会抛错（而不是产出尾部补零的坏文件）', err !== null);
  ok('错误信息说明了是文件不完整',
    !!err && /文件不完整|不完整/.test(err.message), err && err.message);
  ok('错误信息提示了重新下载',
    !!err && /重新下载/.test(err.message), err && err.message);
}

console.log('\n[3] 正常文件仍然不受影响（防止改坏）');
{
  const video = buildFmp4({
    handler: 'vide', sampleEntry: 'avc1', timescale: 16000,
    fragments: 3, samplesPerFragment: 3, sampleDuration: 640, sampleSize: 512, fill: 0x10,
  });
  const audio = buildFmp4({
    handler: 'soun', sampleEntry: 'mp4a', timescale: 48000,
    fragments: 2, samplesPerFragment: 3, sampleDuration: 1024, sampleSize: 128, fill: 0x80,
  });
  const out = [];
  let err = null;
  try {
    await mergeDashStream({
      videoSource: memorySource(new Uint8Array(video)),
      audioSource: memorySource(new Uint8Array(audio)),
      write: async (chunk) => { out.push(chunk); },
    });
  } catch (e) { err = e; }
  ok('合并成功', err === null, err && err.message);
  const blob = Buffer.concat(out.map((c) => Buffer.from(c)));
  const top = listBoxes(new Uint8Array(blob), 0, blob.length);
  ok('产物有 5 个 moof（3 视频 + 2 音频）',
    top.filter((b) => b.type === 'moof').length === 5,
    `实际 ${top.filter((b) => b.type === 'moof').length}`);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 片段扫描回归${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
