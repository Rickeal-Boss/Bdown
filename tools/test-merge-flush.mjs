/**
 * 合并前必须 flush 输入 sink 的自检（不联网）。
 *
 * ## 这个测试存在的理由（真实事故）
 *
 * 用户报：`不是有效的 MP4：未找到 moov 盒子`，栈在
 * `scanFile -> mergeDashStream -> DownloadEngine.mergeInto`。
 *
 * 我一度误判为「B 站 DASH 分片不含 moov」（v1.4.4），后来抓真实 m4s 字节解析，
 * 发现 **有 moov**（`ftyp(32) -> moov(904) -> sidx(304) -> moof(1904) -> mdat`），
 * 并且把真实 m4s 直接喂进 mergeDashStream **能成功产出 6.5MB 可播文件**。
 *
 * 所以 mp4.js 没坏，坏的是**送到它手里的数据**。真因：
 *   - 大文件（> 256MB，sink.js 的 MEMORY_LIMIT）走 OPFS 的 FileHandleSink
 *   - FileHandleSink.writeAt() 只把写入排进异步 `_chain`，**只有 close() 才会
 *     await _chain 并关闭 writable**
 *   - mergeInto 读回 vSink/aSink 时**从未 close 过** → 拿到未落盘的空/半截文件
 *     → 没有 moov
 *   - CI 测不出来：test-engine-e2e 用几 KB 合成片段 → 走 MemorySink（数据在内存，
 *     不关也能读到）→ 一直"4/4 PASS"
 *
 * 本测试用「未关闭就读不到内容」的假 sink 复刻 OPFS 语义，锁住这个修复。
 *
 * 运行：node tools/test-merge-flush.mjs
 */
import { DownloadEngine } from '../src/core/engine.js';
import { MemorySink } from '../src/core/sink.js';
import { buildFmp4 } from './fixtures/fmp4.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/**
 * 复刻 OPFS FileHandleSink 的关键语义：**未 close 就读不到已写内容**。
 * （真实的 OPFS writable 会把数据缓冲起来，直到 close/flush 才落盘。）
 */
class UnflushedFileSink {
  constructor() {
    this._bytes = new Uint8Array(0);
    this._closed = false;
    this.size = 0;
  }
  async writeAt(offset, bytes) {
    const need = offset + bytes.length;
    if (need > this._bytes.length) {
      const next = new Uint8Array(need);
      next.set(this._bytes, 0);
      this._bytes = next;
    }
    this._bytes.set(bytes, offset);
    this.size = Math.max(this.size, need);
  }
  async write(bytes) { return this.writeAt(this.size, bytes); }
  async close() { this._closed = true; }
  async file() {
    // 未 flush 时返回空文件 —— 这正是 mergeInto 以前踩到的坑
    return new Blob([this._closed ? this._bytes : new Uint8Array(0)]);
  }
}

const VIDEO = new Uint8Array(buildFmp4({
  handler: 'vide', sampleEntry: 'avc1', timescale: 16000,
  fragments: 2, samplesPerFragment: 3, sampleDuration: 640, sampleSize: 512, fill: 0x10,
}));
const AUDIO = new Uint8Array(buildFmp4({
  handler: 'soun', sampleEntry: 'mp4a', timescale: 48000,
  fragments: 2, samplesPerFragment: 3, sampleDuration: 1024, sampleSize: 128, fill: 0x80,
}));

async function makeSinks() {
  const v = new UnflushedFileSink();
  const a = new UnflushedFileSink();
  await v.writeAt(0, VIDEO);
  await a.writeAt(0, AUDIO);
  return { v, a };
}

console.log('\n[1] 前置：假 sink 忠实复刻 OPFS 语义');
{
  const { v } = await makeSinks();
  ok('写完但未 close 时，file() 读到 0 字节（复刻未落盘）', (await v.file()).size === 0);
  await v.close();
  ok('close 之后 file() 能读到完整内容', (await v.file()).size === VIDEO.length);
}

console.log('\n[2] ★ 核心：mergeInto 必须先关闭输入 sink 再读回');
{
  const { v, a } = await makeSinks();
  const engine = new DownloadEngine({ api: {}, settings: {}, onUpdate: () => {} });
  // 只关心 mergeInto 的读回行为，落盘部分打桩
  engine.finishOutput = async () => {};

  const out = { sink: new MemorySink() };
  let err = null;
  try {
    await engine.mergeInto({
      task: {},
      vSink: v,
      aSink: a,
      out,
      destination: { kind: 'downloads' },
      filename: 'x.mp4',
    });
  } catch (e) { err = e; }
  ok('mergeInto 不抛错（不再报「未找到 moov」）', err === null, err && err.message);
  ok('视频轨 sink 已被关闭', v._closed === true);
  ok('音频轨 sink 已被关闭', a._closed === true);
  const blob = await out.sink.blob();
  ok('产出了非空文件', blob.size > 0, `size=${blob.size}`);
  const head = Buffer.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 8));
  ok('产物以 ftyp 开头（是合法 MP4）', head.toString('latin1', 4, 8) === 'ftyp', head.toString('latin1', 4, 8));
}

console.log('\n[3] 关闭失败不能让整个合并崩掉（只告警）');
{
  const { v, a } = await makeSinks();
  v.close = async () => { throw new Error('OPFS close failed'); };
  const engine = new DownloadEngine({ api: {}, settings: {}, onUpdate: () => {} });
  engine.finishOutput = async () => {};
  let threw = false;
  try {
    await engine.mergeInto({
      task: {}, vSink: v, aSink: a,
      out: { sink: new MemorySink() },
      destination: { kind: 'downloads' }, filename: 'x.mp4',
    });
  } catch { threw = true; }
  // 视频轨 close 抛错 -> 读回是空文件 -> 合并必然失败，但**不该是未捕获异常风暴**
  // 这里只断言：close 抛错被吞成 warn，流程继续走到 aSink
  ok('视频轨 close 失败后仍继续处理音频轨（不中断）', a._closed === true);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 合并 flush 自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
