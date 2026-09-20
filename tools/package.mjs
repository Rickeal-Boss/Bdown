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

/**
 * 约定：**以下划线开头**的目录是临时/脚本产物，不进包 —— 但 `_locales` 是
 * 扩展必需的国际化目录，必须保留，所以用否定顺序环视排除它。
 *
 * 为什么需要这条：曾经有个校验脚本临时解压目录 `_zv` 因命令中断没被清掉，
 * 下一次打包就把它**整份**塞进了扩展包（文件数 44 → 88、体积 468KB → 940KB）。
 * 这种污染在 zip 里很难肉眼发现，却会让商店提交和真实安装都出问题。
 */
const TEMP_DIR_RE = /^_(?!locales)/;

/**
 * ★ 隐藏文件（点开头）一律不进包。
 *
 * 为什么在 `TEMP_DIR_RE` 之外还要补这条：上次只防了"下划线开头的目录"（`_zv` 那种），
 * 于是污染换了个形态又进来了 —— 两个临时探针脚本 `.sec-ping.mjs` / `.sec-verify.mjs`
 * 被整份打进包里，文件数 44 → 46、体积 +11KB，而包内结构肉眼看不出异常。
 *
 * 点开头的文件比 `_zv` 更危险：`ls` 默认不显示它们，git status 也容易一眼扫漏，
 * 等到商店提交被拒或装上去出问题才发现。Chrome 扩展运行时不需要任何隐藏文件，
 * （`.git` 等已在 EXCLUDE_DIRS 里排除），这里可以一刀切。
 */
const HIDDEN_RE = /^\./;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    if (TEMP_DIR_RE.test(name)) continue;
    if (HIDDEN_RE.test(name)) continue;
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

  // ★ 污染自检：任何"下划线开头但不是 _locales"的目录被打包进来都要**直接失败**。
  // 这类目录几乎都是临时产物（解压校验、脚本输出），混进扩展包会导致
  // 商店提交失败或安装后行为异常，而且只看文件数很难发现。
  const polluted = entries
    .map((e) => e.path.split('/')[0])
    .filter((top) => TEMP_DIR_RE.test(top));
  if (polluted.length) {
    throw new Error(
      `包内混入了临时目录：${[...new Set(polluted)].join(', ')}\n` +
        '  多半是上次校验/脚本中断留下的残留，请删除后重新打包。',
    );
  }

  // _locales 反而必须存在（国际化），缺了说明排除规则写错了
  if (!entries.some((e) => e.path.startsWith('_locales/'))) {
    throw new Error('包内缺少 _locales/（国际化目录被误排除？）');
  }

  // ★ 隐藏文件自检：包内任何 path 段以 `.` 开头都要直接失败。
  //
  // 与上面的临时目录自检是**两种不同形态的污染** —— 上次只加了下划线那一条，
  // 于是 `.sec-*.mjs` 这类点开头的临时脚本照样混了进来。两条都要有。
  const hidden = entries
    .map((e) => e.path)
    .filter((p) => p.split('/').some((seg) => HIDDEN_RE.test(seg)));
  if (hidden.length) {
    throw new Error(
      `包内混入了隐藏文件：${hidden.slice(0, 10).join(', ')}\n` +
        '  多为临时探针/脚本残留（如 .sec-*.mjs）。它们在 ls 里默认不可见，请删除后重新打包。',
    );
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
