/**
 * 任务收尾编排自检（v1.4.30）。
 *
 * 为什么需要这个套件：`finishTracked` 原来住在 `dashboard.js` 里，而 dashboard.js
 * 在模块顶层就依赖 `document`，**在 CI 里 import 不了** —— 于是这段编排零行为覆盖。
 * v1.4.30 的变异测试实测：
 *   - 把 `registry.release(task)` 整行删掉 → **33 个套件依旧全绿**
 *   - 把 `await prunePending(task)` 整行删掉 → **33 个套件依旧全绿**
 *   - 把 `abortFetchExit` 里的 `closeSinkQuietly(sink)` 删掉 → **33 个套件依旧全绿**
 * 而这三件事各自的后果都很重（指纹泄漏吞任务 / 取消后任务复活 / 两个 writable 并存坏文件）。
 * 上一轮的 `selftest-core` 源码计数守卫拦不住它们 —— 删掉函数体内的一行调用，
 * `finishTracked(` 的出现次数完全不变。
 *
 * 本套件改为**行为断言**：注入假的副作用，断言它们被调用、以什么顺序、带什么参数。
 *
 * 运行：node tools/test-lifecycle.mjs
 */

import { createTaskFinisher } from '../src/core/lifecycle.js';
import { SpecKeyRegistry, abortFetchExit } from '../src/core/engine.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/** 造一个记录调用顺序的收尾器。 */
function makeFinisher(overrides = {}) {
  const calls = [];
  const registry = new SpecKeyRegistry();
  const finisher = createTaskFinisher({
    onSettled: () => calls.push('settled'),
    persistHistory: async () => { calls.push('persist'); },
    prunePending: async (t) => { calls.push(`prune:${t.id}`); },
    registry,
    notifyDone: async (t) => { calls.push(`notify:${t.id}`); },
    pump: () => calls.push('pump'),
    ...overrides,
  });
  return { finisher, calls, registry };
}

console.log('\n[1] 正常完成：六个收尾动作一个都不能少');
{
  const { finisher, calls, registry } = makeFinisher();
  const task = { id: 't1', status: 'done', spec: { bvid: 'BV1' } };
  registry.claim(task);
  await finisher(task, { notify: true });
  ok('计数回落 onSettled 被调用', calls.includes('settled'));
  ok('持久化被调用', calls.includes('persist'));
  ok('清 pendingTasks 被调用（且带的是本任务）', calls.includes('prune:t1'),
    `实际顺序：${calls.join(' → ')}`);
  ok('指纹被释放', registry.keys.size === 0, `残留 ${registry.keys.size} 个键`);
  ok('done + notify 触发完成通知', calls.includes('notify:t1'));
  ok('队列泵被调用', calls.includes('pump'));

  const order = ['settled', 'persist', 'prune:t1', 'notify:t1', 'pump'];
  const actual = calls.filter((c) => order.includes(c));
  ok('收尾顺序稳定（prune 在 notify/pump 之前）',
    actual.join(',') === order.join(','), `实际：${actual.join(',')}`);
}

console.log('\n[2] ★ paused 任务绝不能被释放指纹（否则「继续」会与重新派发撞同一 .part）');
{
  const { finisher, calls, registry } = makeFinisher();
  const task = { id: 'p2', status: 'paused', spec: { bvid: 'BV1' } };
  registry.claim(task);
  await finisher(task);
  ok('paused：指纹仍然被占住', registry.keys.size === 1, `集合剩 ${registry.keys.size} 个键`);
  ok('paused：其余收尾动作照常执行', calls.includes('prune:p2') && calls.includes('pump'));

  // 对照组：同样一个任务改成 canceled，就必须释放
  const { finisher: f2, registry: r2 } = makeFinisher();
  const t2 = { id: 'c3', status: 'canceled', spec: { bvid: 'BV1' } };
  r2.claim(t2);
  await f2(t2);
  ok('canceled：指纹被释放（对照组）', r2.keys.size === 0, `集合剩 ${r2.keys.size} 个键`);
}

console.log('\n[3] 完成通知只在 notify 且终态为 done 时触发');
{
  for (const [status, notify, expected] of [
    ['done', true, true], ['done', false, false],
    ['error', true, false], ['canceled', true, false], ['paused', true, false],
  ]) {
    const { finisher, calls } = makeFinisher();
    const task = { id: 'n', status, spec: { bvid: 'BV1' } };
    await finisher(task, { notify });
    const got = calls.some((c) => c.startsWith('notify:'));
    ok(`${status} + notify=${notify} → 通知=${expected ? '发' : '不发'}`,
      got === expected, `实际 ${got ? '发了' : '没发'}`);
  }
}

console.log('\n[4] ★ 收尾链容错：单步失败不得让「释放指纹」被跳过');
{
  // prune 抛错（storage 配额满 / 并发写冲突都会）
  const errors = [];
  const { finisher, registry, calls } = makeFinisher({
    prunePending: async () => { throw new Error('storage 挂了'); },
    onError: (step) => errors.push(step),
  });
  const task = { id: 'e1', status: 'error', spec: { bvid: 'BV1' } };
  registry.claim(task);
  let threw = false;
  try { await finisher(task); } catch { threw = true; }
  ok('prune 抛错不会向外抛（收尾失败不该影响调用方）', !threw);
  ok('prune 抛错被 onError 上报', errors.includes('prunePending'), `上报了 ${JSON.stringify(errors)}`);
  ok('★ prune 抛错时指纹**仍然被释放**（不然会静默吞掉后续派发）',
    registry.keys.size === 0, `残留 ${registry.keys.size} 个键`);
  ok('prune 抛错后队列泵仍然执行', calls.includes('pump'));

  // persistHistory 抛错同理
  const errors2 = [];
  const r2 = makeFinisher({
    persistHistory: async () => { throw new Error('quota 满'); },
    onError: (step) => errors2.push(step),
  });
  const t2 = { id: 'e2', status: 'done', spec: { bvid: 'BV1' } };
  r2.registry.claim(t2);
  await r2.finisher(t2, { notify: true });
  ok('persistHistory 抛错被上报', errors2.includes('persistHistory'));
  ok('persistHistory 抛错时指纹仍被释放', r2.registry.keys.size === 0);
  ok('persistHistory 抛错后 prune/notify 照常执行',
    r2.calls.includes('prune:e2') && r2.calls.includes('notify:e2'), `实际：${r2.calls.join(' → ')}`);

  // onError 自己抛错也不能炸
  let okOnErrorThrows = true;
  try {
    const r3 = makeFinisher({
      prunePending: async () => { throw new Error('boom'); },
      onError: () => { throw new Error('上报也挂了'); },
    });
    await r3.finisher({ id: 'e3', status: 'done', spec: { bvid: 'BV1' } });
  } catch { okOnErrorThrows = false; }
  ok('onError 自身抛错被吞掉', okOnErrorThrows);
}

console.log('\n[5] ★ abortFetchExit：取消时必须先关 sink、再落清单（顺序不能颠倒）');
{
  const order = [];
  const sink = { async close() { order.push('close'); } };
  await abortFetchExit({ sink, persist: async () => { order.push('persist'); } });
  ok('sink.close() 被调用', order.includes('close'), `实际：${order.join(' → ')}`);
  ok('persist 被调用', order.includes('persist'));
  ok('顺序是 close → persist（先落盘再记账）', order.join(',') === 'close,persist',
    `实际：${order.join(' → ')}`);

  // 没有 close 方法的 sink 不能炸（MemorySink 就没有 close 的语义要求）
  let okNoClose = true;
  try { await abortFetchExit({ sink: {}, persist: async () => {} }); } catch { okNoClose = false; }
  ok('无 close() 的 sink 不会抛错', okNoClose);

  // persist 抛错必须被吞掉 —— 收尾路径不能因为"记账失败"而把真正的 abort 错误顶掉
  let okPersistFail = true;
  try {
    await abortFetchExit({ sink: { async close() {} }, persist: async () => { throw new Error('写清单失败'); } });
  } catch { okPersistFail = false; }
  ok('persist 抛错被吞掉（不掩盖真正的 abort 原因）', okPersistFail);

  // close 抛错也要被吞掉（closeSinkQuietly 语义）
  let okCloseFail = true;
  try {
    await abortFetchExit({ sink: { async close() { throw new Error('writable 已关'); } }, persist: async () => {} });
  } catch { okCloseFail = false; }
  ok('close 抛错被吞掉（幂等关闭）', okCloseFail);
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 收尾编排自检${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
