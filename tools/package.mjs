/**
 * 打包扩展为可提交/可分发的 zip。
 *
 * 零依赖：用 ZIP 的 STORE（不压缩）方式手写容器，Chrome / Edge 都接受，
 * 也不需要系统里装 zip 命令。文件名与目录分隔符按 ZIP 规范用 `/`、`\` 之外
 * 一律用正斜杠，且不放目录项（只放文件项，目录由路径隐含）。
 *
 * 用法：
 *   node tools/package.mjs           # 产出 dist/Bdown-v<version>.zip
 *   node tools/package.mjs --check   # 打完包后回读中央目录做自检
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 不进包的内容：开发/测试/文档/CI 与本地产物。 */
const EXCLUDE_DIRS = new Set([
  '.git', '.github', 'node_modules', 'dist', 'samples', '.audit',
  '.workbuddy-ai', 'tools', 'docs', '.vscode', '.idea', '__pycache__',
]);
const EXCLUDE_FILES = new Set(['.gitignore', '.env', 'package.json', 'package-lock.json']);
const EXCLUDE_EXT = new Set(['.m4s', '.mp4', '.log', '.tmp', '.pyc']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    if (EXCLUDE_FILES.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (!EXCLUDE_EXT.has(name.slice(name.lastIndexOf('.')))) acc.push(full);
  }
  return acc;
}

/** CRC32（IEEE 802.3，与 zlib 一致）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 日期时间（本地时区）。 */
function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(entries) {
  // entries: [{ path: 'src/core/mp4.js', data: Buffer }]
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime();

  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    locals.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // external attrs：高 16 位是 Unix 权限（0644），必须无符号化否则溢出成负数
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/** 回读中央目录，确认 zip 可解析且条目完整。 */
function verifyZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('找不到 EOCD，zip 结构损坏');
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`第 ${i} 条中央目录签名错误`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    names.push(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'));
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`条目 ${names.at(-1)} 的本地头签名错误`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== eocd - centralSize + centralSize) {
    // 位置一致性：中央目录末尾应正好落在 EOCD 起始
    if (p !== eocd) throw new Error(`中央目录长度不符：解析到 ${p}，EOCD 在 ${eocd}`);
  }
  return names;
}

function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const files = walk(ROOT).sort();
  const entries = files.map((f) => ({
    path: relative(ROOT, f).split(sep).join('/'),
    data: readFileSync(f),
  }));

  // manifest 必须存在，否则打出来的包装不上
  if (!entries.some((e) => e.path === 'manifest.json')) {
    throw new Error('包内缺少 manifest.json');
  }

  const zip = buildZip(entries);
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const out = join(ROOT, 'dist', `Bdown-v${version}.zip`);
  writeFileSync(out, zip);

  const names = verifyZip(zip);
  console.log(`✅ 打包完成：${relative(ROOT, out).split(sep).join('/')}  ${entries.length} 个文件 / ${(zip.length / 1024).toFixed(1)} KB`);
  console.log(`   版本号 v${version}（来自 manifest.json）`);
  console.log(`   自检回读：中央目录 ${names.length} 条，全部本地头签名正确`);
  if (process.argv.includes('--check')) {
    for (const n of names) console.log(`   - ${n}`);
  }
  if (!existsSync(out)) throw new Error('输出文件不存在');
}

main();
