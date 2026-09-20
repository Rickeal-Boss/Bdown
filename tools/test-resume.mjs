/**
 * 断点续传纯逻辑自检（不联网）。
 *
 * 运行：node tools/test-resume.mjs
 */
import {
  mergeRanges,
  missingRanges,
  completedBytes,
  toChunks,
  addRange,
  isComplete,
  serialise,
  deserialise,
  normalizeRange,
} from '../src/core/resume.js';

let pass = 0;
let fail = 0;

function ok(name, cond, msg = '') {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name} — ${msg}`);
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n[1] normalizeRange — 非法输入');
ok('null 返回 null', normalizeRange(null) === null);
ok('乱七八糟对象返回 null', normalizeRange({ start: 'x', end: 'y' }) === null);
ok('end < start 返回 null', normalizeRange({ start: 10, end: 5 }) === null);
ok('负数 start 返回 null', normalizeRange({ start: -1, end: 5 }) === null);
ok('正常区间通过', eq(normalizeRange({ start: 0, end: 10 }), { start: 0, end: 10 }));

console.log('\n[2] mergeRanges — 重叠与相邻合并');
ok('空列表', eq(mergeRanges([]), []));
ok('单个区间不变', eq(mergeRanges([{ start: 0, end: 10 }]), [{ start: 0, end: 10 }]));
ok('重叠合并', eq(mergeRanges([{ start: 0, end: 10 }, { start: 5, end: 20 }]), [{ start: 0, end: 20 }]));
ok('**相邻也合并**（否则会产生 1 字节碎片）',
  eq(mergeRanges([{ start: 0, end: 10 }, { start: 10, end: 20 }]), [{ start: 0, end: 20 }]));
ok('不相邻保持分离',
  eq(mergeRanges([{ start: 0, end: 10 }, { start: 15, end: 20 }]), [{ start: 0, end: 10 }, { start: 15, end: 20 }]));
ok('无序输入先排序',
  eq(mergeRanges([{ start: 30, end: 40 }, { start: 0, end: 10 }, { start: 10, end: 20 }]),
    [{ start: 0, end: 20 }, { start: 30, end: 40 }]));
ok('完全包含的区间被吞并',
  eq(mergeRanges([{ start: 0, end: 100 }, { start: 20, end: 30 }]), [{ start: 0, end: 100 }]));
ok('非法区间被过滤掉',
  eq(mergeRanges([{ start: 0, end: 10 }, null, { start: 5, end: 1 }]), [{ start: 0, end: 10 }]));

console.log('\n[3] completedBytes');
ok('空为 0', completedBytes([]) === 0);
ok('单个区间', completedBytes([{ start: 0, end: 100 }]) === 100);
ok('不重叠相加', completedBytes([{ start: 0, end: 100 }, { start: 200, end: 300 }]) === 200);
ok('重叠不重复计算', completedBytes([{ start: 0, end: 100 }, { start: 50, end: 150 }]) === 150);

console.log('\n[4] missingRanges — 核心');
ok('全空 → 整个文件都缺', eq(missingRanges(100, []), [{ start: 0, end: 100 }]));
ok('全满 → 无缺失', eq(missingRanges(100, [{ start: 0, end: 100 }]), []));
ok('缺开头', eq(missingRanges(100, [{ start: 50, end: 100 }]), [{ start: 0, end: 50 }]));
ok('缺结尾', eq(missingRanges(100, [{ start: 0, end: 50 }]), [{ start: 50, end: 100 }]));
ok('缺中间（两个洞）',
  eq(missingRanges(100, [{ start: 0, end: 20 }, { start: 80, end: 100 }]), [{ start: 20, end: 80 }]));
ok('缺中间（真的两洞）',
  eq(missingRanges(100, [{ start: 0, end: 20 }, { start: 40, end: 60 }, { start: 80, end: 100 }]),
    [{ start: 20, end: 40 }, { start: 60, end: 80 }]));
ok('已下载超出总长 → 截断，不产生负区间',
  eq(missingRanges(50, [{ start: 0, end: 100 }]), []));
ok('total 非法（0/负/NaN）→ 返回空（避免误判成「全缺」）',
  eq(missingRanges(0, []), []) && eq(missingRanges(-1, []), []) && eq(missingRanges(NaN, []), []));

console.log('\n[5] toChunks — 切分');
ok('按目标大小切分',
  eq(toChunks([{ start: 0, end: 250 }], 100),
    [{ start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 250 }]));
ok('不足一片时只出一片', eq(toChunks([{ start: 0, end: 50 }], 100), [{ start: 0, end: 50 }]));
ok('多个 gap 分别切分',
  eq(toChunks([{ start: 0, end: 150 }, { start: 200, end: 250 }], 100),
    [{ start: 0, end: 100 }, { start: 100, end: 150 }, { start: 200, end: 250 }]));
ok('空 gap → 空分片', eq(toChunks([], 100), []));
{
  let threw = false;
  try { toChunks([{ start: 0, end: 10 }], 0); } catch { threw = true; }
  ok('分片大小为 0 → 抛错', threw);
}
{
  let threw = false;
  try { toChunks([{ start: 0, end: 10 }], -5); } catch { threw = true; }
  ok('分片大小为负 → 抛错', threw);
}

console.log('\n[6] addRange / isComplete');
{
  let done = [];
  done = addRange(done, { start: 0, end: 10 });
  ok('累加第一个区间', eq(done, [{ start: 0, end: 10 }]));
  done = addRange(done, { start: 10, end: 20 });
  ok('累加相邻区间会合并', eq(done, [{ start: 0, end: 20 }]));
  done = addRange(done, { start: 50, end: 60 });
  ok('累加不相邻区间保持分离', eq(done, [{ start: 0, end: 20 }, { start: 50, end: 60 }]));
  ok('未完成判定', isComplete(100, done) === false);
  done = addRange(done, { start: 0, end: 100 });
  ok('补完后判定完成', isComplete(100, done) === true);
  ok('非法区间不会影响状态', eq(addRange(done, null), done));
}

console.log('\n[7] serialise / deserialise');
ok('往返一致', eq(deserialise(serialise([{ start: 0, end: 10 }, { start: 5, end: 20 }])), [{ start: 0, end: 20 }]));
ok('空串 → 空数组', eq(deserialise(''), []));
ok('null → 空数组', eq(deserialise(null), []));
ok('脏 JSON 不抛异常', eq(deserialise('{not json'), []));
ok('JSON 但不是数组 → 空数组', eq(deserialise('{"a":1}'), []));

console.log('\n[8] 端到端：模拟真实下载场景');
{
  // 10MB 文件，分 1MB 片，先下完 0-1M、3-4M、9-10M
  const total = 10 * 1024 * 1024;
  const done = mergeRanges([
    { start: 0, end: 1024 * 1024 },
    { start: 3 * 1024 * 1024, end: 4 * 1024 * 1024 },
    { start: 9 * 1024 * 1024, end: 10 * 1024 * 1024 },
  ]);
  const gaps = missingRanges(total, done);
  ok('已下载 3MB', completedBytes(done) === 3 * 1024 * 1024, String(completedBytes(done)));
  ok('缺失区间为 2 段', gaps.length === 2, JSON.stringify(gaps));
  ok('第一段是 1M-3M', eq(gaps[0], { start: 1024 * 1024, end: 3 * 1024 * 1024 }));
  ok('第二段是 4M-9M', eq(gaps[1], { start: 4 * 1024 * 1024, end: 9 * 1024 * 1024 }));

  const chunks = toChunks(gaps, 1024 * 1024);
  ok('切成 2+5=7 个分片', chunks.length === 7, String(chunks.length));
  const chunkBytes = chunks.reduce((n, c) => n + (c.end - c.start), 0);
  ok('分片总字节 = 缺失总量', chunkBytes === completedBytes(gaps), `${chunkBytes}`);

  // 全部下完
  const all = addRange(done, { start: 0, end: total });
  ok('补完后无缺失', missingRanges(total, all).length === 0);
  ok('补完后完成', isComplete(total, all));
}

console.log('\n[9] 集成：downloadRanged 真的跳过已完成区间');
{
  const { MemorySink } = await import('../src/core/sink.js');
  const { downloadRanged, setFetchImpl } = await import('../src/core/downloader.js');

  const TOTAL = 1024;
  // 内容：第 i 字节 = i & 0xff，方便校验
  const content = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) content[i] = i & 0xff;

  const requested = [];
  const fetchImpl = async (url, init) => {
    const range = init?.headers?.Range || init?.headers?.range || '';
    const m = String(range).match(/bytes=(\d+)-(\d+)/);
    if (!m) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const start = Number(m[1]);
    const end = Number(m[2]);
    requested.push({ start, end });
    const slice = content.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${TOTAL}`,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      },
    });
  };

  // 假装前 512 字节已经下过
  const resumeRanges = [{ start: 0, end: 512 }];
  const sink = new MemorySink();
  // 先把已有部分写进 sink（模拟上一次的落盘结果）
  await sink.writeAt(0, content.slice(0, 512));

  setFetchImpl(fetchImpl);
  await downloadRanged({
    urls: ['https://example.com/seg.m4s'],
    size: TOTAL,
    sink,
    concurrency: 4,
    
    probe: false,
    resumeRanges,
  });

  const totalRequested = requested.reduce((n, r) => n + (r.end - r.start + 1), 0);
  ok('只请求了缺失的 512 字节（不是 1024）', totalRequested === 512, 'requested=' + totalRequested);
  const minStart = Math.min(...requested.map((r) => r.start));
  const maxEnd = Math.max(...requested.map((r) => r.end));
  ok('请求区间不越过已完成部分', minStart >= 512, 'minStart=' + minStart);
  ok('请求区间覆盖到文件末尾', maxEnd === TOTAL - 1, 'maxEnd=' + maxEnd);

  const blob = await sink.blob();
  ok('最终产物长度正确', blob.size === TOTAL, 'size=' + blob.size);
  const out = new Uint8Array(await blob.arrayBuffer());
  let same = out.length === content.length;
  for (let i = 0; i < content.length && same; i++) if (out[i] !== content[i]) same = false;
  ok('最终产物字节与源完全一致（续传没串位）', same);
}

console.log('\n[10] 集成：不传 resumeRanges 时行为不变（零回归）');
{
  const { MemorySink } = await import('../src/core/sink.js');
  const { downloadRanged, setFetchImpl } = await import('../src/core/downloader.js');

  const TOTAL = 512;
  const content = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) content[i] = (i * 7) & 0xff;

  const requested = [];
  const fetchImpl = async (url, init) => {
    const range = init?.headers?.Range || init?.headers?.range || '';
    const m = String(range).match(/bytes=(\d+)-(\d+)/);
    if (!m) return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const start = Number(m[1]);
    const end = Number(m[2]);
    requested.push({ start, end });
    return new Response(content.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${TOTAL}`, 'Accept-Ranges': 'bytes' },
    });
  };

  const sink = new MemorySink();
  setFetchImpl(fetchImpl);
  await downloadRanged({
    urls: ['https://example.com/seg.m4s'], size: TOTAL, sink,
    concurrency: 4, fetchImpl, probe: false,
  });
  const totalRequested = requested.reduce((n, r) => n + (r.end - r.start + 1), 0);
  ok('不传 resumeRanges → 全量下载', totalRequested === TOTAL, 'requested=' + totalRequested);
}

console.log('\n[11] MemorySink 的空洞 / 重叠 / 乱序（续传正确性依赖）');
{
  const { MemorySink } = await import('../src/core/sink.js');
  const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer());

  // 空洞：只写 0-3 与 8-11，中间 4-7 应为 0
  {
    const sink = new MemorySink();
    await sink.writeAt(0, new Uint8Array([1, 2, 3, 4]));
    await sink.writeAt(8, new Uint8Array([9, 10, 11, 12]));
    const out = await bytesOf(await sink.blob());
    ok('空洞处补 0，总长按最远偏移', out.length === 12 && out[4] === 0 && out[7] === 0,
      Array.from(out).join(','));
    ok('空洞两侧数据正确', out[0] === 1 && out[3] === 4 && out[8] === 9 && out[11] === 12);
  }

  // 乱序写入
  {
    const sink = new MemorySink();
    await sink.writeAt(4, new Uint8Array([5, 6]));
    await sink.writeAt(0, new Uint8Array([1, 2]));
    await sink.writeAt(2, new Uint8Array([3, 4]));
    const out = await bytesOf(await sink.blob());
    ok('乱序写入按 offset 归位', Array.from(out).join(',') === '1,2,3,4,5,6', Array.from(out).join(','));
  }

  // 重叠：后写覆盖先写
  {
    const sink = new MemorySink();
    await sink.writeAt(0, new Uint8Array([1, 1, 1, 1]));
    await sink.writeAt(0, new Uint8Array([2, 2]));
    const out = await bytesOf(await sink.blob());
    ok('重叠时后写覆盖', Array.from(out).join(',') === '2,2,1,1', Array.from(out).join(','));
  }

  // 入参防御
  {
    const sink = new MemorySink();
    await sink.writeAt(0, 0);          // 传成数字
    await sink.writeAt(1, undefined);  // 传成 undefined
    await sink.writeAt(2, new Uint8Array([7]));
    const out = await bytesOf(await sink.blob());
    ok('非法 bytes 被当成空，不产生 NaN / 多余字节',
      Number.isFinite(sink.size) && out.length === 3, `size=${sink.size} len=${out.length}`);
    ok('合法写入仍然生效', out[2] === 7);
  }

  // 空 sink
  {
    const sink = new MemorySink();
    ok('空 sink 产出空 blob', (await sink.blob()).size === 0);
  }
}

console.log('\n[6] ★ 暂停 vs 取消：唯一区别是"清不清续传清单"');
{
  const { Task } = await import('../src/core/engine.js');

  // 暂停：置意图标记 + 中断，清单由 engine 保留
  {
    const t = new Task({ bvid: 'BV1', cid: 1 });
    ok('初始 paused=false', t.paused === false);
    ok('初始未取消', t.canceled === false);
    t.pause();
    ok('pause() 置起 paused 标记', t.paused === true);
    ok('pause() 确实中断了任务', t.canceled === true);
  }

  // 取消：必须把 paused 打回 false，否则"先暂停再取消"会被当成暂停、清单被留下
  {
    const t = new Task({ bvid: 'BV1', cid: 1 });
    t.pause();
    ok('先暂停过', t.paused === true);
    t.cancel();
    ok('★ 取消会把 paused 打回 false（否则取消变成暂停，清单被误留）', t.paused === false);
    ok('取消同样中断了任务', t.canceled === true);
  }

  // 反向：先取消再暂停
  {
    const t = new Task({ bvid: 'BV1', cid: 1 });
    t.cancel();
    t.pause();
    ok('先取消再暂停 → 以暂停为准', t.paused === true);
  }

  // 每个任务都要有自己的续传 key 容器，不能共用同一个数组
  {
    const a = new Task({ bvid: 'BV1', cid: 1 });
    const b = new Task({ bvid: 'BV2', cid: 2 });
    a.resumeKeys.push('k-a');
    ok('★ 两个任务的 resumeKeys 互相独立', b.resumeKeys.length === 0,
      `b 里混进了 ${JSON.stringify(b.resumeKeys)}`);
  }
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 断点续传逻辑自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
