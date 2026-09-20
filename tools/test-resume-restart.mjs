/**
 * 复现「暂停 → 继续却从头下载」的链路测试。
 *
 * 为什么必须写这个测试：`openPartial` 的判定依赖真实的 OPFS 行为
 * （文件长度随随机偏移写入而增长、清单与 .part 是两个文件分开读写），
 * 这些在纯逻辑测试里全部被绕开了。上一轮 `planResume` / `mismatchWithDisk`
 * 的测试全是纯函数，所以**判据写错了也照样全绿** —— 直到用户在真机上
 * 遇到"暂停后继续却从头下"才发现。
 *
 * 这里用一份内存版 OPFS 把真实行为跑出来：写入偏移会扩展文件长度，
 * 未写入的空洞由 0 填充（与 File System Access API 一致）。
 *
 * 运行：node tools/test-resume-restart.mjs
 */

/* ---------- 内存版 OPFS（模拟 File System Access API 的关键语义） ---------- */

class FakeFile {
  constructor() { this.buf = new Uint8Array(0); }
  get size() { return this.buf.length; }
}

class FakeWritable {
  constructor(file) { this.file = file; this.closed = false; }
  async write(arg) {
    // 简写形态：write(data) —— 追加到末尾（ResumeStore.write 写清单用的就是这种）
    if (typeof arg === 'string' || arg instanceof Uint8Array || arg instanceof ArrayBuffer) {
      const data = typeof arg === 'string'
        ? new TextEncoder().encode(arg)
        : (arg instanceof ArrayBuffer ? new Uint8Array(arg) : arg);
      this._put(this.file.buf.length, data);
      return;
    }
    // 对象形态：{ type:'write', position, data } 与 { type:'truncate', size }
    if (arg.type === 'truncate') {
      this.file.buf = this.file.buf.slice(0, arg.size);
      return;
    }
    this._put(arg.position, arg.data ?? new Uint8Array(0));
  }

  _put(position, data) {
    const need = position + data.length;
    if (need > this.file.buf.length) {
      const nb = new Uint8Array(need); // 扩展，空洞补 0
      nb.set(this.file.buf);
      this.file.buf = nb;
    }
    this.file.buf.set(data, position);
  }
  async close() { this.closed = true; }
  async abort() { this.closed = true; }
}

class FakeHandle {
  constructor(file) { this.file = file; }
  async createWritable() { return new FakeWritable(this.file); }
  async getFile() {
    // 与浏览器一致：返回**当前已提交**长度的快照
    const buf = this.file.buf;
    return {
      size: buf.length,
      text: async () => new TextDecoder().decode(buf),
      arrayBuffer: async () => buf.slice().buffer,
    };
  }
}

class FakeDir {
  constructor() { this.files = new Map(); this.dirs = new Map(); }
  /** OpfsWorkspace.ensure() 会先取子目录 */
  async getDirectoryHandle(name, { create } = {}) {
    if (!this.dirs.has(name)) {
      if (!create) throw new Error(`NotFoundError: ${name}`);
      this.dirs.set(name, new FakeDir());
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw new Error(`NotFoundError: ${name}`);
      this.files.set(name, new FakeFile());
    }
    return new FakeHandle(this.files.get(name));
  }
  async removeEntry(name) { this.files.delete(name); }
}

// Node 22 起 `globalThis.navigator` 是只读 getter，直接赋值会抛
// "Cannot set property navigator of #<Object> which has only a getter"。
Object.defineProperty(globalThis, 'navigator', {
  value: { storage: { getDirectory: async () => new FakeDir() } },
  configurable: true,
  writable: true,
});

/* ---------- 现在才导入被测代码（它运行时才会去读 navigator） ---------- */

const { ResumeStore, planResume } = await import('../src/core/resume-store.js');
const { FileHandleSink } = await import('../src/core/sink.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const SIZE = 20 * 1024 * 1024; // 20MB 的一条轨
const CHUNK = 4 * 1024 * 1024;

/** 模拟一次"下了前 n 个分片就暂停"：写入 .part 并落清单。 */
async function simulateDownloadThenPause(store, key, chunkCount) {
  const opened = await store.openPartial(key, SIZE);
  const sink = opened.sink;
  const ranges = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK;
    const data = new Uint8Array(CHUNK);
    await sink.writeAt(start, data);
    ranges.push({ start, end: start + CHUNK });
  }
  await sink.close(); // 对应暂停时的 closeSinkQuietly
  await store.write(key, { size: SIZE, ranges });
  return ranges;
}

console.log('\n[1] ★ 顺序下载后暂停 → 继续必须能续上（用户报的场景）');
{
  const store = new ResumeStore();
  const key = 'bvTEST_c1_q80_avc_v';
  const wrote = await simulateDownloadThenPause(store, key, 3); // 下完 12MB / 20MB

  const meta = await store.read(key);
  ok('清单已写入', meta !== null);
  ok('清单 size 正确', meta?.size === SIZE, String(meta?.size));

  const reopened = await store.openPartial(key, SIZE);
  ok('★ 继续时判定为可续传', reopened.resumed === true,
    `resumed=${reopened.resumed} ranges=${JSON.stringify(reopened.ranges)} —— 这会触发 truncate(0) 从头下载`);
  ok('已下区间被认回来', reopened.ranges.length === 1 && reopened.ranges[0].end === wrote.length * CHUNK,
    JSON.stringify(reopened.ranges));
  ok('sink.size 回填了已下字节（进度条不回退）',
    reopened.sink.size === wrote.length * CHUNK, `size=${reopened.sink.size}`);
}

console.log('\n[2] 乱序完成（并发分片的常态）→ 也不能误判为从头下');
{
  const store = new ResumeStore();
  const key = 'bvTEST_c2_q80_avc_v';
  const opened = await store.openPartial(key, SIZE);
  // 先写后面的分片，再写前面的 —— 并发下这很常见
  await opened.sink.writeAt(3 * CHUNK, new Uint8Array(CHUNK));
  await opened.sink.writeAt(0, new Uint8Array(CHUNK));
  await opened.sink.close();
  await store.write(key, { size: SIZE, ranges: [{ start: 0, end: CHUNK }, { start: 3 * CHUNK, end: 4 * CHUNK }] });

  const reopened = await store.openPartial(key, SIZE);
  ok('★ 有空洞的区间也能续传', reopened.resumed === true,
    `resumed=${reopened.resumed} ranges=${JSON.stringify(reopened.ranges)}`);
  ok('两段区间都被保留', reopened.ranges.length === 2, JSON.stringify(reopened.ranges));
}

console.log('\n[3] 只下了一小片就暂停 → 同样要能续');
{
  const store = new ResumeStore();
  const key = 'bvTEST_c3_q80_avc_v';
  await simulateDownloadThenPause(store, key, 1);
  const reopened = await store.openPartial(key, SIZE);
  ok('★ 只下 1/5 也能续', reopened.resumed === true,
    `resumed=${reopened.resumed} ranges=${JSON.stringify(reopened.ranges)}`);
}

console.log('\n[4] 对照：这些情况**必须**判为从头下');
{
  const store = new ResumeStore();

  // 4a 大小对不上（换了清晰度）
  await simulateDownloadThenPause(store, 'k_mismatch', 2);
  const wrongSize = await store.openPartial('k_mismatch', SIZE + 1024);
  ok('大小不匹配 → 从头下', wrongSize.resumed === false, `resumed=${wrongSize.resumed}`);

  // 4b 没有清单
  const noMeta = await store.openPartial('k_nometa', SIZE);
  ok('无清单 → 从头下', noMeta.resumed === false);

  // 4c 清单说下完了，但 .part 是空的（真残缺）
  const store2 = new ResumeStore();
  await store2.write('k_empty', { size: SIZE, ranges: [{ start: 0, end: SIZE }] });
  const emptyPart = await store2.openPartial('k_empty', SIZE);
  ok('★ 清单说下完但文件是空的 → 必须从头下（不能静默产出坏文件）',
    emptyPart.resumed === false || emptyPart.ranges.length === 0,
    `resumed=${emptyPart.resumed} ranges=${JSON.stringify(emptyPart.ranges)}`);
}

console.log('\n[5] 判据自检：mismatchWithDisk 不能把"正常续传"误判为残缺');
{
  // 顺序写完前 3 片：文件长度 = 12MB，已完成字节 = 12MB
  const r1 = planResume({ size: SIZE, ranges: [{ start: 0, end: 3 * CHUNK }], updatedAt: Date.now() },
    SIZE, { actualSize: 3 * CHUNK });
  ok('文件长度 == 已完成字节 → 可续', r1.kind === 'partial', `${r1.kind} ${r1.reason}`);

  // 只写前面的区间，但文件因写过后段而更长：长度 20MB > 已完成 8MB
  const r2 = planResume({ size: SIZE, ranges: [{ start: 0, end: 2 * CHUNK }], updatedAt: Date.now() },
    SIZE, { actualSize: SIZE });
  ok('★ 文件长度 > 已完成字节（有空洞）→ 仍可续', r2.kind === 'partial', `${r2.kind} ${r2.reason}`);

  // 真残缺：文件只有 4MB，清单说完成了 12MB
  const r3 = planResume({ size: SIZE, ranges: [{ start: 0, end: 3 * CHUNK }], updatedAt: Date.now() },
    SIZE, { actualSize: CHUNK });
  ok('文件长度 < 已完成字节 → 判残缺重下', r3.kind === 'fresh', `${r3.kind}`);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 暂停/继续 链路自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
