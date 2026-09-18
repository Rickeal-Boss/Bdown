/**
 * 断点续传持久化层的**纯逻辑**自检（不联网、不依赖 OPFS）。
 *
 * 只测不碰浏览器的部分：key 派生、清单校验。
 * 真正读写 OPFS 的 `ResumeStore` 方法需要在浏览器里验证。
 *
 * 运行：node tools/test-resume-store.mjs
 */
import { resumeKey, canResume, RESUME_TTL_MS } from '../src/core/resume-store.js';

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

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 续传持久化纯逻辑自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
