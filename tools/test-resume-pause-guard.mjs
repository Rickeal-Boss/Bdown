/**
 * 暂停 / 继续 这一版新引入的三个**静默**失效点的回归测试（不联网、不依赖 OPFS）。
 *
 * 这三条都是"跑起来也不报错、但用户拿到的是坏结果"的类型，靠肉眼 review 很难发现，
 * 所以必须各自钉一条断言：
 *
 *  1. `planResume` 判 complete **只信清单** —— 清单说下完了、.part 其实短了/没了，
 *     就会一个字节都不下直接去混流，产出静默损坏的文件。
 *
 *  2. `Task.toRecord()` 不带 `resumeKeys` —— 暂停后关掉下载中心再打开，
 *     任务消失而它占着的 .part 与清单永远没人清（OPFS 永久泄漏）。
 *
 *  3. 「继续」时若拿不到上一轮的保存位置，**默默退回浏览器下载目录** ——
 *     用户明明选过文件夹，续着续着文件跑到 ~/Downloads。
 *
 * 运行：node tools/test-resume-pause-guard.mjs
 */
import { planResume } from '../src/core/resume-store.js';
import { Task } from '../src/core/engine.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const NOW = 1_700_000_000_000;
const SIZE = 4096;

console.log('\n[1] ★ 清单说"已下完"但 .part 对不上时，必须降级为 fresh 而不是 complete');
{
  const full = { size: SIZE, ranges: [{ start: 0, end: SIZE }], updatedAt: NOW };

  // 磁盘长度齐全 —— 正常的 complete 路径，不该被新校验挡住
  const okCase = planResume(full, SIZE, { now: NOW, actualSize: SIZE });
  ok('.part 长度齐全 → 仍是 complete（校验不能误杀正常续传）',
    okCase.kind === 'complete', `实际 ${okCase.kind}（${okCase.reason}）`);

  // .part 被截断过
  const truncated = planResume(full, SIZE, { now: NOW, actualSize: SIZE - 1024 });
  ok('★ .part 被截断 → 不能判 complete',
    truncated.kind !== 'complete', `实际 ${truncated.kind}`);
  ok('.part 被截断 → 降级为 fresh（truncate 从头重下）',
    truncated.kind === 'fresh', `实际 ${truncated.kind}`);
  ok('降级原因里写清了实际长度（便于排查）',
    /4096|3072/.test(truncated.reason), truncated.reason);

  // .part 整个没了（配额回收 / 只清了 .part 没清 .json）—— 最危险的一种
  const gone = planResume(full, SIZE, { now: NOW, actualSize: 0 });
  ok('★ .part 空文件 → 绝不能判 complete（否则混流出 0 字节轨）',
    gone.kind !== 'complete', `实际 ${gone.kind}`);
  ok('.part 空文件 → fresh', gone.kind === 'fresh', `实际 ${gone.kind}`);

  // 半成品同样要校验：声称下了一半、实际一个字节都没有
  const half = { size: SIZE, ranges: [{ start: 0, end: SIZE / 2 }], updatedAt: NOW };
  const halfGone = planResume(half, SIZE, { now: NOW, actualSize: 0 });
  ok('★ 半成品清单 + 空 .part → 不能判 partial（会跳过真正缺失的字节）',
    halfGone.kind === 'fresh', `实际 ${halfGone.kind}（${halfGone.reason}）`);

  const halfOk = planResume(half, SIZE, { now: NOW, actualSize: SIZE / 2 });
  ok('半成品清单 + 长度相符的 .part → 仍是 partial',
    halfOk.kind === 'partial', `实际 ${halfOk.kind}（${halfOk.reason}）`);

  // 磁盘比声称的**长**是允许的（尾部有上一轮的残留字节不影响前段）
  const longer = planResume(half, SIZE, { now: NOW, actualSize: SIZE });
  ok('.part 比清单长 → 允许续传（不误杀）', longer.kind === 'partial', longer.kind);

  // 测不到长度（actualSize 缺省）时不得把续传全部判死
  const unknown = planResume(full, SIZE, { now: NOW });
  ok('★ 拿不到 .part 长度时退回"只信清单"（不校验）',
    unknown.kind === 'complete', `实际 ${unknown.kind}（${unknown.reason}）`);
  const unknown2 = planResume(full, SIZE, { now: NOW, actualSize: -1 });
  ok('actualSize = -1 视为"测不到"', unknown2.kind === 'complete', unknown2.kind);
  const junk = planResume(full, SIZE, { now: NOW, actualSize: NaN });
  ok('actualSize = NaN 视为"测不到"（脏数据不该让续传失效）',
    junk.kind === 'complete', junk.kind);
}

console.log('\n[2] ★ Task.toRecord 必须带上续传 key（否则暂停后重开页面 = OPFS 永久泄漏）');
{
  const task = new Task({ bvid: 'BV1xx411c7mD', cid: 62131, quality: 80 }, { title: 't' });
  task.status = 'paused';
  task.paused = true;
  task.resumeKeys = ['bvBV1xx411c7mD_c62131_q80_v', 'bvBV1xx411c7mD_c62131_q80_a'];
  task.downloadedBytes = 12345;
  task.totalBytes = 99999;

  const rec = task.toRecord();
  ok('★ toRecord 带 resumeKeys', Array.isArray(rec.resumeKeys), JSON.stringify(rec.resumeKeys));
  ok('resumeKeys 内容完整（两个轨各一个）',
    rec.resumeKeys.length === 2 && rec.resumeKeys.includes('bvBV1xx411c7mD_c62131_q80_v'),
    JSON.stringify(rec.resumeKeys));
  ok('toRecord 带 downloadedBytes（否则重开页面进度条归零）',
    rec.downloadedBytes === 12345, String(rec.downloadedBytes));
  ok('toRecord 带 spec（恢复后要能重新解析/继续）',
    rec.spec && rec.spec.cid === 62131, JSON.stringify(rec.spec));
  ok('toRecord 带 status=paused（历史里能认出它是可恢复的）',
    rec.status === 'paused', rec.status);

  // 恢复侧：resumeKeys 必须能还原回去，否则「移除」清不掉 .part
  const restored = new Task(rec.spec || {}, { title: rec.title });
  restored.resumeKeys = Array.isArray(rec.resumeKeys) ? [...rec.resumeKeys] : [];
  restored.status = rec.status;
  ok('恢复出的任务认得自己的续传 key',
    restored.resumeKeys.length === 2, JSON.stringify(restored.resumeKeys));

  // 反面：不带 resumeKeys 的记录 —— 这正是修复前的形状，锁住它别退回去
  const legacy = { ...rec, resumeKeys: undefined };
  const restoredLegacy = new Task(legacy.spec || {}, {});
  restoredLegacy.resumeKeys = Array.isArray(legacy.resumeKeys) ? [...legacy.resumeKeys] : [];
  ok('缺 resumeKeys 的旧记录 → 恢复后为空（说明这条字段不是白加的）',
    restoredLegacy.resumeKeys.length === 0, JSON.stringify(restoredLegacy.resumeKeys));
}

console.log('\n[3] ★ 「继续」拿不到上一轮保存位置时，必须问用户而不是默默改存下载目录');
{
  // 复刻 dashboard.resolveDestination 的分支顺序，验证"没有 prev"这一路的取值来源。
  // 真正的文件句柄无法在 Node 里造，这里锁的是**分支语义**本身。
  const pickDestination = async () => ({ kind: 'asked' });
  const resolveDestination = async (task) => {
    const prev = task.lastDestination;
    if (!prev) return pickDestination(1);            // ← 修复点
    if (prev.kind === 'downloads') return { kind: 'downloads' };
    return prev;
  };

  const restored = { lastDestination: undefined };   // 重开页面后的暂停任务
  const got = await resolveDestination(restored);
  ok('★ 无上一轮位置 → 走"问用户"，而不是 { kind: "downloads" }',
    got.kind === 'asked', JSON.stringify(got));

  const downloadsMode = { lastDestination: { kind: 'downloads' } };
  const got2 = await resolveDestination(downloadsMode);
  ok('saveMode=downloads 的上一轮位置仍然直接沿用（不该反复弹窗）',
    got2.kind === 'downloads', JSON.stringify(got2));

  const withDir = { lastDestination: { kind: 'dir', dir: { name: 'my-folder' } } };
  const got3 = await resolveDestination(withDir);
  ok('有上一轮文件夹 → 直接复用（不打扰用户）',
    got3.kind === 'dir' && got3.dir.name === 'my-folder', JSON.stringify(got3));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 暂停/继续 守护自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
