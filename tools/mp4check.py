#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立 ISO-BMFF / fragmented-MP4 解析器。
完全不引用 Bdown 项目代码 —— 纯 Python 从字节流重建 box 树。
用途：交叉校验 Bdown 混流器产出的 mp4。
"""
import sys, struct, hashlib, json

CONTAINERS = {
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf',
    'mfra', 'edts', 'dinf', 'udta', 'stsd', 'sinf', 'schi', 'meco', 'mere',
}

def parse_boxes(buf, start, end, path=""):
    boxes = []
    p = start
    while p + 8 <= end:
        size = struct.unpack('>I', buf[p:p+4])[0]
        typ = buf[p+4:p+8].decode('latin1')
        header = 8
        if size == 1:
            size = struct.unpack('>Q', buf[p+8:p+16])[0]
            header = 16
        elif size == 0:
            size = end - p
        if size < header or p + size > end:
            # 非法/越界
            boxes.append({'type': typ, 'start': p, 'size': size, 'header': header,
                          'end': p+size, 'error': 'size out of range', 'path': path})
            break
        b = {'type': typ, 'start': p, 'size': size, 'header': header,
             'end': p+size, 'path': path}
        if typ in CONTAINERS and typ != 'stsd':
            b['children'] = parse_boxes(buf, p+header, p+size, path + "/" + typ)
        boxes.append(b)
        p += size
    return boxes

def find(boxes, typ):
    for b in boxes:
        if b['type'] == typ:
            return b
    return None

def findall(boxes, typ):
    return [b for b in boxes if b['type'] == typ]

def fullbox(buf, b):
    ver = buf[b['start']+b['header']]
    flags = struct.unpack('>I', b'\x00' + buf[b['start']+b['header']+1:b['start']+b['header']+4])[0]
    return ver, flags

def read_tkhd(buf, b):
    ver, flags = fullbox(buf, b)
    o = b['start'] + b['header'] + 4
    if ver == 1:
        o += 16  # creation+modification 8+8
        tid = struct.unpack('>I', buf[o:o+4])[0]
    else:
        o += 8   # creation+modification 4+4
        tid = struct.unpack('>I', buf[o:o+4])[0]
    return tid

def read_hdlr(buf, b):
    # FullBox: version/flags(4) + pre_defined(4) + handler_type(4)
    s = b['start'] + b['header'] + 8
    return buf[s:s+4].decode('latin1')

def read_trex(buf, b):
    # FullBox + track_ID(4) + default_sample_description_index(4) + default_sample_duration(4)
    #         + default_sample_size(4) + default_sample_flags(4)
    s = b['start'] + b['header'] + 4
    tid, dsdi, dsd, dss, dsf = struct.unpack('>IIIII', buf[s:s+20])
    return {'track_ID': tid, 'default_sample_duration': dsd, 'default_sample_size': dss}

def read_mehd(buf, b):
    ver, flags = fullbox(buf, b)
    s = b['start'] + b['header'] + 4
    if ver == 1:
        return struct.unpack('>Q', buf[s:s+8])[0]
    return struct.unpack('>I', buf[s:s+4])[0]

def read_mvhd(buf, b):
    ver, flags = fullbox(buf, b)
    s = b['start'] + b['header'] + 4
    if ver == 1:
        ts = struct.unpack('>I', buf[s+16:s+20])[0]
        dur = struct.unpack('>Q', buf[s+20:s+28])[0]
    else:
        ts = struct.unpack('>I', buf[s+8:s+12])[0]
        dur = struct.unpack('>I', buf[s+12:s+16])[0]
    return ts, dur

def read_tfhd(buf, b):
    ver, flags = fullbox(buf, b)
    o = b['start'] + b['header'] + 4
    tid = struct.unpack('>I', buf[o:o+4])[0]; o += 4
    base_data_offset = None
    if flags & 0x000001:
        base_data_offset = struct.unpack('>Q', buf[o:o+8])[0]; o += 8
    if flags & 0x000002:
        o += 4
    dsd = None
    if flags & 0x000008:
        dsd = struct.unpack('>I', buf[o:o+4])[0]; o += 4
    if flags & 0x000010:
        o += 4
    if flags & 0x000020:
        o += 4
    return {'track_ID': tid, 'flags': flags, 'base_data_offset': base_data_offset,
            'default_sample_duration': dsd,
            'default_base_is_moof': bool(flags & 0x020000)}

def read_mfhd(buf, b):
    ver, flags = fullbox(buf, b)
    s = b['start'] + b['header'] + 4
    return struct.unpack('>I', buf[s:s+4])[0]

def read_tfdt(buf, b):
    ver, flags = fullbox(buf, b)
    s = b['start'] + b['header'] + 4
    if ver == 1:
        return struct.unpack('>Q', buf[s:s+8])[0]
    return struct.unpack('>I', buf[s:s+4])[0]

def read_trun(buf, b):
    ver, flags = fullbox(buf, b)
    o = b['start'] + b['header'] + 4
    sample_count = struct.unpack('>I', buf[o:o+4])[0]; o += 4
    data_offset = None
    first_sample_flags = None
    if flags & 0x000001:
        data_offset = struct.unpack('>i', buf[o:o+4])[0]; o += 4
    if flags & 0x000004:
        first_sample_flags = struct.unpack('>I', buf[o:o+4])[0]; o += 4
    samples = []
    for _ in range(sample_count):
        s = {}
        if flags & 0x000100:
            s['duration'] = struct.unpack('>I', buf[o:o+4])[0]; o += 4
        if flags & 0x000200:
            s['size'] = struct.unpack('>I', buf[o:o+4])[0]; o += 4
        if flags & 0x000400:
            s['flags'] = struct.unpack('>I', buf[o:o+4])[0]; o += 4
        if flags & 0x000800:
            s['cto'] = struct.unpack('>i', buf[o:o+4])[0]; o += 4
        samples.append(s)
    return {'version': ver, 'flags': flags, 'sample_count': sample_count,
            'data_offset': data_offset, 'first_sample_flags': first_sample_flags,
            'samples': samples}

def main():
    path = sys.argv[1]
    buf = open(path, 'rb').read()
    print(f"# 文件: {path}  大小: {len(buf)} 字节  SHA-256: {hashlib.sha256(buf).hexdigest()}")
    top = parse_boxes(buf, 0, len(buf))
    print("\n## 顶层 box 序列")
    seq = []
    for b in top:
        print(f"  {b['type']:6s} start={b['start']:>10d} size={b['size']:>10d} end={b['end']}")
        seq.append(b['type'])
    print("  序列:", ",".join(seq))

    fails = []
    def check(cond, msg):
        print(("  \u2713 " if cond else "  \u2717 ") + msg)
        if not cond:
            fails.append(msg)

    print("\n## 顶层序列校验")
    check(top[0]['type'] == 'ftyp', "第一个 box = ftyp")
    check(top[1]['type'] == 'moov', "第二个 box = moov")
    # 期望 ftyp, moov, (moof, mdat)*
    rest = [b['type'] for b in top[2:]]
    ok_alt = len(rest) >= 2 and len(rest) % 2 == 0 and all(
        rest[i] == 'moof' and rest[i+1] == 'mdat' for i in range(0, len(rest), 2))
    check(ok_alt, f"moov 之后严格交替 moof/mdat（{len(rest)} 个 box）")

    moov = top[1]
    moov_children = moov.get('children', [])
    traks = findall(moov_children, 'trak')
    print(f"\n## moov")
    check(len(traks) == 2, f"moov 含且仅含 2 个 trak（实际 {len(traks)}）")

    track_ids = []
    handlers = []
    for t in traks:
        tk = find(t.get('children', []), 'tkhd')
        mdia = find(t.get('children', []), 'mdia')
        hdlr = find(mdia.get('children', []), 'hdlr') if mdia else None
        tid = read_tkhd(buf, tk) if tk else None
        h = read_hdlr(buf, hdlr) if hdlr else None
        track_ids.append(tid); handlers.append(h)
        print(f"  trak: track_ID={tid} handler={h}")
    check(sorted(x for x in track_ids if x) == [1, 2], f"track_ID = 1 和 2（实际 {track_ids}）")

    mvex = find(moov_children, 'mvex')
    check(mvex is not None, "moov 含 mvex")
    mehd = None; trexs = []
    if mvex:
        mvex_kids = mvex.get('children', [])
        mehd = find(mvex_kids, 'mehd')
        trexs = findall(mvex_kids, 'trex')
        check(mehd is not None, "mvex 含 mehd")
        check(len(trexs) == 2, f"mvex 含 2 个 trex（实际 {len(trexs)}）")
        for tr in trexs:
            info = read_trex(buf, tr)
            print(f"  trex: track_ID={info['track_ID']} default_sample_duration={info['default_sample_duration']} default_sample_size={info['default_sample_size']}")
    if mehd:
        print(f"  mehd.fragment_duration = {read_mehd(buf, mehd)}")
    mvhd = find(moov_children, 'mvhd')
    if mvhd:
        ts, dur = read_mvhd(buf, mvhd)
        print(f"  mvhd.timescale={ts} duration={dur}")

    # 预期 default_sample_duration: 视频 640 / 音频 1024
    if len(trexs) == 2:
        dsds = {}
        for tr in trexs:
            info = read_trex(buf, tr)
            dsds[info['track_ID']] = info['default_sample_duration']
        # track 1 = 视频, track 2 = 音频（据 hdlr）
        vid_tid = track_ids[0] if handlers[0] == 'vide' else (track_ids[1] if len(handlers) > 1 and handlers[1] == 'vide' else 1)
        aud_tid = 2 if vid_tid == 1 else 1
        print(f"  视频轨 track_ID={vid_tid} dsd={dsds.get(vid_tid)} ; 音频轨 track_ID={aud_tid} dsd={dsds.get(aud_tid)}")
        check(dsds.get(vid_tid) == 640, f"视频 trex.default_sample_duration = 640（实际 {dsds.get(vid_tid)}）")
        check(dsds.get(aud_tid) == 1024, f"音频 trex.default_sample_duration = 1024（实际 {dsds.get(aud_tid)}）")

    print("\n## moof 序列校验")
    moofs = [b for b in top if b['type'] == 'moof']
    mdats = [b for b in top if b['type'] == 'mdat']
    seqs = []
    track_id_set = set()
    non_dbi = 0
    data_offset_fail = 0
    data_offset_checked = 0
    # 建立 moof -> 紧随其后的 mdat 映射
    top_index = {id(b): i for i, b in enumerate(top)}
    for mi, m in enumerate(moofs):
        kids = m.get('children', [])
        mfhd = find(kids, 'mfhd')
        seqs.append(read_mfhd(buf, mfhd) if mfhd else None)
        trafs = findall(kids, 'traf')
        # 紧随其后的 mdat（顶层顺序中紧邻）
        idx = top_index[id(m)]
        next_mdat = top[idx+1] if idx+1 < len(top) and top[idx+1]['type'] == 'mdat' else None
        mdat_data_start = (next_mdat['start'] + next_mdat['header']) if next_mdat else None
        mdat_data_end = next_mdat['end'] if next_mdat else None
        for tr in trafs:
            tfhd = find(tr.get('children', []), 'tfhd')
            tfhd_info = read_tfhd(buf, tfhd)
            track_id_set.add(tfhd_info['track_ID'])
            if not tfhd_info['default_base_is_moof']:
                non_dbi += 1
            truns = findall(tr.get('children', []), 'trun')
            for tun in truns:
                tr_info = read_trun(buf, tun)
                if tr_info['data_offset'] is None:
                    continue
                # default-base-is-moof => base = moof.start
                base = m['start']
                abs_off = base + tr_info['data_offset']
                total_sample_size = sum(s.get('size', 0) for s in tr_info['samples'])
                data_offset_checked += 1
                if next_mdat is None:
                    data_offset_fail += 1
                    continue
                ok_range = (abs_off >= mdat_data_start and abs_off + total_sample_size <= mdat_data_end)
                if not ok_range:
                    data_offset_fail += 1
                    if data_offset_fail <= 5:
                        print(f"  ! moof#{mi+1} track={tfhd_info['track_ID']} trun.data_offset -> abs {abs_off} "
                              f"(mdat 数据区 {mdat_data_start}..{mdat_data_end}, {total_sample_size} 字节) 越界")
    check(all(s == i+1 for i, s in enumerate(seqs)), f"mfhd.sequence_number 从 1 连续递增（{seqs[:8]}{'...' if len(seqs)>8 else ''}, 共 {len(seqs)}）")
    check(track_id_set <= {1, 2}, f"tfhd.track_ID 仅取 1/2（实际 {sorted(track_id_set)}）")
    check(non_dbi == 0, f"所有 tfhd 带 default-base-is-moof（例外 {non_dbi}）")
    check(data_offset_fail == 0, f"所有 trun.data_offset 落在紧随其后的 mdat 内（检查 {data_offset_checked} 个 trun，越界 {data_offset_fail}）")
    check(len(moofs) == len(mdats), f"moof 数 == mdat 数（{len(moofs)} vs {len(mdats)}）")

    # 片段计数 per track
    from collections import Counter
    per_track = Counter()
    for m in moofs:
        for tr in findall(m.get('children', []), 'traf'):
            tfhd = find(tr.get('children', []), 'tfhd')
            per_track[read_tfhd(buf, tfhd)['track_ID']] += 1
    print(f"  每轨片段数: {dict(per_track)}")

    print(f"\n{'='*50}")
    if fails:
        print(f"❌ 独立校验失败 {len(fails)} 项")
        for f in fails:
            print("   -", f)
        sys.exit(1)
    else:
        print("✅ 独立校验全部通过")
        sys.exit(0)

if __name__ == '__main__':
    main()
