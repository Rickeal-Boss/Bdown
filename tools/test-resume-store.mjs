/**
 * 断点续传持久化层的**纯逻辑**自检（不联网、不依赖 OPFS）。
 *
 * 只测不碰浏览器的部分：key 派生、清单校验。
 * 真正读写 OPFS 的 `ResumeStore` 方法需要在浏览器里验证。
 *
 * 运行：node tools/test-resume-store.mjs
 */
import { resumeKey, canResume, planResume, RESUME_TTL_MS } from '../src/core/resume-store.js';

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

const NOW = 1_700_000_000_000;

console.log('\n[1] resumeKey — 由内容身份派生');
{
  const k = resumeKey({ bvid: 'BV1xx411c7mD', cid: 62131, quality: 80, codec: 'AVC', track: 'v' });
  ok('基本派生非空', !!k, String(k));
  ok('**不含 URL**（CDN 地址每次都换，不能当身份）', !/https?|:\/\//.test(k), k);
  ok('同一内容派生出同一个 key',
    k === resumeKey({ bvid: 'BV1xx411c7mD', cid: 62131, quality: 80, codec: 'AVC', track: 'v' }));
  ok('不同清晰度 → 不同 key',
    k !== resumeKey({ bvid: 'BV1xx411c7mD', cid: 62131, quality: 64, codec: 'AVC', track: 'v' }));
  ok('视轨与音轨 → 不同 key',
    resumeKey({ bvid: 'BV1xx411c7mD', cid: 62131, quality: 80, codec: 'AVC', track: 'v' })
    !== resumeKey({ bvid: 'BV1xx411c7mD', cid: 62131, quality: 80, codec: 'AVC', track: 'a' }));
  ok('不同 cid → 不同 key',
    k !== resumeKey({ bvid: 'BV1xx411c7mD', cid: 99999, quality: 80, codec: 'AVC', track: 'v' }));
  ok('aid 与 bvid 都能派生',
    !!resumeKey({ aid: 2, cid: 62131 }) && !!resumeKey({ bvid: 'BV1xx411c7mD', cid: 62131 }));
  ok('epId 也能派生', !!resumeKey({ epId: 123, cid: 62131 }));
  ok('缺 cid → 空串（无法定位内容）', resumeKey({ bvid: 'BV1xx411c7mD' }) === '');
  ok('什么都没有 → 空串', resumeKey({}) === '' && resumeKey() === '');
  ok('codec 里的特殊字符被清掉（避免非法文件名）',
    !/[^A-Za-z0-9_]/.test(resumeKey({ bvid: 'BV1xx411c7mD', cid: 1, codec: 'H.264/AVC!' }) || 'x'));
}

console.log('\n[1b] resumeKey — cheeseId 与 trackId（v1.4.29 数据一致性 F4/F5）');
{
  ok('cheeseId 能派生（课程任务此前 key 为空 → 静默无续传）',
    resumeKey({ cheeseId: 12345, cid: 99 }).startsWith('ch12345_'));
  ok('cheeseId 与 aid 派生的 key 不碰撞',
    resumeKey({ cheeseId: 1, cid: 99 }) !== resumeKey({ aid: 1, cid: 99 }));
  const base = { bvid: 'BV1xx411c7mD', cid: 62131, quality: 80, codec: 'AVC', track: 'a' };
  ok('音轨 id 并入 key：不同音轨不同 key（防 size 恰好相等时跨轨续写）',
    resumeKey({ ...base, trackId: 30280 }) !== resumeKey({ ...base, trackId: 30251 }));
  ok('trackId 缺省或 0 时不进 key（向后兼容旧清单）',
    resumeKey(base) === resumeKey({ ...base, trackId: 0 }) && resumeKey(base) === resumeKey({ ...base }));
}

console.log('\n[2] canResume — 清单校验');
{
  const size = 1000;
  const fresh = { size, ranges: [{ start: 0, end: 500 }], updatedAt: NOW };

  ok('正常的半成品 → 可续传',
    canResume(fresh, size, { now: NOW }).ok, JSON.stringify(canResume(fresh, size, { now: NOW })));

  ok('meta 为 null → 不可', canResume(null, size, { now: NOW }).ok === false);
  ok('meta 是字符串 → 不可', canResume('x', size, { now: NOW }).ok === false);
  ok('size 为 0 → 不可', canResume({ ...fresh, size: 0 }, size, { now: NOW }).ok === false);
  ok('size 是 NaN → 不可', canResume({ ...fresh, size: NaN }, size, { now: NOW }).ok === false);

  const mismatch = canResume(fresh, 2000, { now: NOW });
  ok('**大小不匹配 → 不可**（换了清晰度/CDN 内容变了）',
    mismatch.ok === false && /大小不匹配/.test(mismatch.reason), mismatch.reason);

  ok('expectedSize 非法 → 不可', canResume(fresh, 0, { now: NOW }).ok === false);

  const stale = canResume({ ...fresh, updatedAt: NOW - RESUME_TTL_MS - 1 }, size, { now: NOW });
  ok('过期 → 不可', stale.ok === false && /过期/.test(stale.reason), stale.reason);
  ok('刚好没过期 → 可',
    canResume({ ...fresh, updatedAt: NOW - RESUME_TTL_MS + 1 }, size, { now: NOW }).ok);
  ok('缺少 updatedAt → 不可', canResume({ ...fresh, updatedAt: 0 }, size, { now: NOW }).ok === false);

  ok('ranges 为空 → 不可', canResume({ ...fresh, ranges: [] }, size, { now: NOW }).ok === false);
  ok('ranges 是垃圾 → 不可',
    canResume({ ...fresh, ranges: [{ start: 5, end: 1 }] }, size, { now: NOW }).ok === false);

  const done = canResume({ size, ranges: [{ start: 0, end: size }], updatedAt: NOW }, size, { now: NOW });
  ok('**已下完 → 不可续**（没必要，也不该再走续传路径）',
    done.ok === false && /已经下完/.test(done.reason), done.reason);

  // 多段已完成也能续
  const multi = {
    size,
    ranges: [{ start: 0, end: 200 }, { start: 400, end: 600 }, { start: 800, end: 900 }],
    updatedAt: NOW,
  };
  ok('多段已完成区间 → 可续传', canResume(multi, size, { now: NOW }).ok);

  // 重叠区间会被 mergeRanges 归一，不应误判
  const overlap = { size, ranges: [{ start: 0, end: 300 }, { start: 200, end: 500 }], updatedAt: NOW };
  ok('重叠区间归一化后仍可续传', canResume(overlap, size, { now: NOW }).ok);
}

console.log('\n[3] planResume — ★ 已下完的轨必须判 complete，不能判 fresh');
{
  const size = 1000;
  // 这是「合并模式 + 暂停/继续」的必现场景：
  // 视频轨已下完（fetchTo 写了全量区间清单），音频轨下到一半时暂停。
  // 继续时视频轨必须被认成 complete —— 判成 fresh 的话 openPartial 会
  // truncate(0) 把整份 .part 抹掉重下，续传等于完全没生效。
  const full = planResume({ size, ranges: [{ start: 0, end: size }], updatedAt: NOW }, size, { now: NOW });
  ok('全量清单 → complete', full.kind === 'complete', `实际 ${full.kind}（${full.reason}）`);
  ok('complete 给出全量区间', full.ranges.length === 1 && full.ranges[0].start === 0 && full.ranges[0].end === size,
    JSON.stringify(full.ranges));
  ok('★ complete 绝不能是 fresh（fresh 会 truncate 掉已下完的数据）', full.kind !== 'fresh', full.reason);

  // 多段拼起来正好下完，也算 complete
  const fullMulti = planResume(
    { size, ranges: [{ start: 0, end: 600 }, { start: 600, end: size }], updatedAt: NOW }, size, { now: NOW });
  ok('多段拼满 → complete', fullMulti.kind === 'complete', fullMulti.kind);

  // 半成品 → partial
  const half = planResume({ size, ranges: [{ start: 0, end: 500 }], updatedAt: NOW }, size, { now: NOW });
  ok('半成品 → partial', half.kind === 'partial', half.kind);
  ok('partial 返回已完成区间', half.ranges.length === 1 && half.ranges[0].end === 500, JSON.stringify(half.ranges));

  // 各种"不能续"
  ok('无清单 → fresh', planResume(null, size, { now: NOW }).kind === 'fresh');
  ok('大小不匹配 → fresh',
    planResume({ size: 999, ranges: [{ start: 0, end: 999 }], updatedAt: NOW }, size, { now: NOW }).kind === 'fresh');
  ok('已过期 → fresh',
    planResume({ size, ranges: [{ start: 0, end: 500 }], updatedAt: NOW - RESUME_TTL_MS - 1 }, size, { now: NOW }).kind === 'fresh');
  ok('realSize 非法 → fresh', planResume({ size, ranges: [], updatedAt: NOW }, 0, { now: NOW }).kind === 'fresh');
  ok('realSize 为 NaN → fresh', planResume({ size, ranges: [], updatedAt: NOW }, NaN, { now: NOW }).kind === 'fresh');

  // ★ complete 分支**刻意不校验 TTL**（partial 分支走 canResume 有 7 天 TTL）。
  //   这里锁住这个决策，防止有人"顺手补上 TTL" —— 那会让暂停超过 7 天的任务
  //   在字节完整的情况下被整轨重下。理由见 resume-store.js 里的注释。
  const oldFull = planResume(
    { size, ranges: [{ start: 0, end: size }], updatedAt: NOW - RESUME_TTL_MS - 1 }, size, { now: NOW });
  ok('★ 超期的 complete 清单仍判 complete（不按时间挡，只按字节挡）',
    oldFull.kind === 'complete', `实际 ${oldFull.kind}（${oldFull.reason}）`);
  ok('缺 updatedAt 的 complete 清单仍判 complete（同理）',
    planResume({ size, ranges: [{ start: 0, end: size }], updatedAt: 0 }, size, { now: NOW }).kind === 'complete');
  // 但 partial 分支的 TTL 必须照常生效 —— 两种判定各自成立，不要互相"统一"
  ok('★ partial 分支的 TTL 仍然生效（超期 → fresh）',
    planResume({ size, ranges: [{ start: 0, end: 500 }], updatedAt: NOW - RESUME_TTL_MS - 1 }, size, { now: NOW })
      .kind === 'fresh');
  ok('只有空区间 → fresh',
    planResume({ size, ranges: [], updatedAt: NOW }, size, { now: NOW }).kind === 'fresh');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 续传持久化纯逻辑自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
