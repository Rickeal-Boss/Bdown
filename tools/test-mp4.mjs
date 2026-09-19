/**
 * mp4.js 自检（不联网，纯字节构造）。
 *
 * 历史教训（重要）：
 * - v1.4.4 曾断言「B 站 DASH 分片流不含 moov」，据此改了错误文案。
 *   **该结论已被实测证伪**：实测 BV16s7b68EEz 的 Q32/Q16 全部轨道，box 结构均为
 *   `ftyp -> moov -> sidx -> moof -> mdat`，**有 moov**（904 字节）。
 * - 所以「未找到 moov」的真因是别的（文件不完整 / 纯 segment / 不是 DASH 分片），
 *   错误文案必须保持中立并输出诊断信息，不能再下断言。
 *
 * 本测试锁两件事：
 *   1) 真实结构的输入，**必须能找到 moov**（不能退化成"找不到"）
 *   2) 无 moov 的输入，抛**中立**错误且带已扫描 box 列表（便于定位）
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

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function asSource(buf) {
  return { size: buf.length, read: async (off, len) => buf.slice(off, off + len) };
}

console.log('\n[1] 真实结构（ftyp + moov + sidx + moof + mdat）必须找到 moov');
{
  // 复刻实测到的 B 站 m4s 顶层结构（尺寸不要求精确，只要顺序与类型对）
  const buf = Buffer.concat([
    box('ftyp', Buffer.alloc(24)),
    box('moov', Buffer.alloc(896)), // 真实是 904 字节
    box('sidx', Buffer.alloc(296)),
    box('moof', Buffer.alloc(1896)),
    box('mdat', Buffer.alloc(64)),
  ]);
  let err = null;
  try { await scanFile(asSource(buf)); } catch (e) { err = e; }
  // 可能因为 moof 内容不合法而抛别的错，但**绝不能**是"未找到 moov"
  ok('不再报「未找到 moov」（这是 v1.4.4 误判后最危险的退化）',
    !(err && /未找到 moov/.test(err.message)), err && err.message);
  ok('也不再报 v1.4.4 那条已被证伪的断言', !(err && /分片流不含 moov/.test(err.message)), err && err.message);
}

console.log('\n[2] 无 moov 的输入：中立错误 + 诊断信息');
{
  const buf = Buffer.concat([box('ftyp', Buffer.alloc(24)), box('moof', Buffer.alloc(32)), box('mdat', Buffer.alloc(32))]);
  let err = null;
  try { await scanFile(asSource(buf)); } catch (e) { err = e; }
  ok('确实抛错', err !== null);
  ok('文案中立：说「无法合并」而不下"分片流都没有 moov"的结论',
    err && /无法合并/.test(err.message), err && err.message);
  ok('带已扫描到的 box 列表用于定位', err && /已扫描到的顶层 box/.test(err.message), err && err.message);
  ok('列出实际看到的 box 类型（ftyp/moof/mdat）',
    err && /ftyp/.test(err.message) && /moof/.test(err.message), err && err.message);
  ok('给出可操作建议（重试 / 音视频分离）',
    err && /重试/.test(err.message) && /音视频分离/.test(err.message), err && err.message);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} mp4.js 自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
