/**
 * mp4.js 自检（不联网，纯字节构造）。
 *
 * 历史教训：v1.4.3 之前 mp4.scanFile 在「B 站 DASH 分片流不含 moov」时
 * 抛「不是有效的 MP4」——merge 模式从 v1.0.0 起就没人能跑成功，
 * 但 CI 用合成 fMP4 测不出来。本测试用**真实分片字节形状**锁住新文案，
 * 防止以后又静默退化。
 *
 * 运行：node tools/test-mp4.mjs
 */
import { scanFile } from '../src/core/mp4.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/**
 * 构造一个最简的「B 站 m4s 形状」：ftyp + moof + mdat，**没有 moov**。
 * 真实 B 站分片就是这种结构 —— moov 在 init 段，分片不带。
 */
function makeBilibiliSegment() {
  // 8 字节 box 头：size + type，最小合法 box
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('ftyp', 'ascii')]);
  const moof = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('moof', 'ascii')]);
  const mdat = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('mdat', 'ascii')]);
  return Buffer.concat([ftyp, moof, mdat]);
}

function asSource(buf) {
  return {
    size: buf.length,
    read: async (off, len) => buf.slice(off, off + len),
  };
}

console.log('\n[1] scanFile 真实分片（无 moov）必须给出明确错误');
{
  const source = asSource(makeBilibiliSegment());
  let err = null;
  try { await scanFile(source); } catch (e) { err = e; }
  ok('确实抛错（不再是静默 pass）', err !== null);
  ok('错误文案明确说明「B 站 DASH 分片流不含 moov」',
    err && /DASH 分片流不含 moov/.test(err.message), err && err.message);
  ok('错误文案建议切到「音视频分离」',
    err && /音视频分离/.test(err.message), err && err.message);
  // 防止以后退化回旧文案
  ok('不再是旧的「未找到 moov 盒子」', err && !/未找到 moov 盒子/.test(err.message), err && err.message);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} mp4.js 自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
