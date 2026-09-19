/**
 * 合成 fMP4 夹具（供多个测试脚本共用）。
 *
 * 为什么要抽出来：`tools/selftest-synthetic.mjs` 模块末尾会自动 `main()` 并
 * `process.exit`，**直接 import 它会把调用方进程劫持掉**。以前每个测试都各自
 * 拷一份 buildFmp4，已经出现 3 份重复拷贝。统一放这里。
 *
 * 用法：import { buildFmp4 } from './fmp4.mjs';
 */
export function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

export const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

export const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
};

/**
 * 生成一个单轨的 fragmented MP4。
 * @param {object} o
 * @param {'vide'|'soun'} o.handler
 * @param {string} o.sampleEntry 'avc1' | 'mp4a'
 * @param {number} o.timescale
 * @param {number} o.fragments 片段数
 * @param {number} o.samplesPerFragment 每片段样本数
 * @param {number} o.sampleDuration 每样本时长（以 timescale 计）
 * @param {number} o.sampleSize 每样本字节数
 * @param {number} [o.fill] 填充字节值，便于区分两条轨道
 */
export function buildFmp4({ handler, sampleEntry, timescale, fragments, samplesPerFragment, sampleDuration, sampleSize, fill = 0 }) {
  const ftyp = box(
    'ftyp',
    Buffer.from('iso5', 'latin1'),
    u32(0x200),
    Buffer.from('iso5iso6mp41dash', 'latin1')
  );

  const mvhd = box(
    'mvhd',
    Buffer.from([0, 0, 0, 0]),
    u32(0),
    u32(0),
    u32(1000), // movie timescale
    u32(0), // duration = 0（分片流）
    u32(0x00010000),
    u16(0x0100),
    Buffer.alloc(2),
    Buffer.alloc(8),
    Buffer.from([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00,
    ]),
    Buffer.alloc(8), // matrix 剩余 2 组
    Buffer.alloc(24), // pre_defined[6]
    u32(2) // next_track_ID
  );

  const tkhd = box(
    'tkhd',
    Buffer.from([0, 0, 0, 7]),
    u32(0),
    u32(0),
    u32(1), // track_ID
    u32(0),
    u32(0),
    Buffer.alloc(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    Buffer.from([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00,
    ]),
    u32(0),
    u32(0)
  );

  const mdhd = box('mdhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', Buffer.from([0, 0, 0, 0]), u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('\0', 'latin1'));
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0]), u32(1), box(sampleEntry, Buffer.alloc(78)));
  const stts = box('stts', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsc = box('stsc', Buffer.from([0, 0, 0, 0]), u32(0));
  const stsz = box('stsz', Buffer.from([0, 0, 0, 0]), u32(0), u32(0));
  const stco = box('stco', Buffer.from([0, 0, 0, 0]), u32(0));
  const dinf = box('dinf', box('dref', Buffer.from([0, 0, 0, 0]), u32(1), box('url ', Buffer.from([0, 0, 0, 1]))));
  const minf = box(
    'minf',
    handler === 'vide' ? box('vmhd', Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)) : box('smhd', Buffer.from([0, 0, 0, 0]), Buffer.alloc(4)),
    dinf,
    box('stbl', stsd, stts, stsc, stsz, stco)
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));

  // 与 B 站真实文件一致：tfhd 带 default-base-is-moof(0x020000)，
  // 样本时长放在 trex 的 default_sample_duration 里
  const trex = box(
    'trex',
    Buffer.from([0, 0, 0, 0]),
    u32(1), // track_ID
    u32(1), // default_sample_description_index
    u32(sampleDuration),
    u32(0),
    u32(0x00010000)
  );
  const mehd = box('mehd', Buffer.from([0, 0, 0, 0]), u32(0));
  const mvex = box('mvex', mehd, trex);

  const moov = box('moov', mvhd, mvex, trak);

  // 片段
  const chunks = [ftyp, moov];
  for (let i = 0; i < fragments; i++) {
    const sampleCount = samplesPerFragment;

    // ★ dataOffset 不能靠"手算 moof 大小"得出 —— 手算很容易漏：
    //   trun 还有 first_sample_flags(4)，traf / moof 各有 8 字节头。
    // 以前手算固定少 20 字节，产出的样本 `trun.data_offset` 全部偏小，
    // 被独立解析器 tools/mp4check.py 抓到（播放器会因此找不到样本数据）。
    // 正确做法：**先组装一次量出真实大小**，再回填。
    const buildMoof = (dataOffset) => {
      const mfhd = box('mfhd', Buffer.from([0, 0, 0, 0]), u32(i + 1));
      const tfhd = box('tfhd', Buffer.from([0x00, 0x02, 0x00, 0x00]), u32(1));
      const tfdt = box('tfdt', Buffer.from([0, 0, 0, 0]), u32(i * sampleCount * sampleDuration));
      const trunParts = [
        Buffer.from([0, 0, 0x0a, 0x05]), // data_offset | first_sample_flags | sample_size | cto
        u32(sampleCount),
        u32(dataOffset),
        u32(0x02000000), // first_sample_flags
      ];
      for (let s = 0; s < sampleCount; s++) {
        trunParts.push(u32(sampleSize));
        trunParts.push(u32(0));
      }
      return box('moof', mfhd, box('traf', tfhd, tfdt, box('trun', ...trunParts)));
    };
    // 用占位值 0 组装一次量大小（data_offset 是定长字段，不影响总长）
    const dataOffset = buildMoof(0).length + 8; // +8 跳过紧随其后 mdat 的头部
    const moof = buildMoof(dataOffset);

    const mdat = box('mdat', Buffer.alloc(sampleCount * sampleSize, fill + i));
    chunks.push(moof, mdat);
  }

  return Buffer.concat(chunks);
}
