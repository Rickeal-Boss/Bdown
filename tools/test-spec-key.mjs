/**
 * 任务防重指纹自检（v1.4.30）。
 *
 * 锁住的核心不变量（这条不变量以前**没有任何断言**，所以它坏了整整几个版本没人知道）：
 *
 *   **注册指纹用的键，必须与释放指纹用的键相同。**
 *
 *   旧实现里 `specKey()` 把 `cid` 算进键，而：
 *     - 注册发生在 `dashboard.acceptPending()`，用的是 storage 里**原始**的 spec
 *       —— 内容脚本悬浮按钮 / 播放器按钮 / 右键菜单派发的 spec **没有 cid**；
 *     - 释放发生在 `finishTracked → releaseSpecKey()`，用的是 `run()` 里被
 *       `ensureSpecComplete()` **原地补全之后** 的 spec —— **有 cid**。
 *   两个键永远不等 → `Set.delete()` 删一个不存在的键（静默返回 false）→
 *   指纹**永久泄漏** → 同一次会话内该视频再也派发不出去（`acceptPending` 直接
 *   continue，连 toast 都没有）。
 *
 * 下面的 [3] 就是这条场景的端到端复现；[1][2] 是它的最小构成条件。
 *
 * 运行：node tools/test-spec-key.mjs
 */

import { specKey, SpecKeyRegistry, ensureSpecComplete, Task } from '../src/core/engine.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/** 只实现 ensureSpecComplete 会用到的那三个接口。 */
function makeApi({ info = null, season = null, cheese = null } = {}) {
  return {
    async videoInfo() { return info; },
    async seasonInfo() { return season; },
    async cheeseSeason() { return cheese; },
  };
}

console.log('\n[1] specKey 不得把 cid 算进指纹（cid 是派生值，会被 ensureSpecComplete 原地补写）');
{
  const before = { bvid: 'BV1xx411c7mD', aid: 123, pageIndex: 0, quality: 80 };
  const after = { ...before, cid: 39386548303 }; // 引擎运行后原地补上的 cid
  ok('补 cid 前后指纹完全相同', specKey(before) === specKey(after),
    `before=${specKey(before)} / after=${specKey(after)}`);
  ok('同 bvid 不同 cid 视为同一任务（cid 不参与指纹）',
    specKey({ bvid: 'BV1', cid: 1 }) === specKey({ bvid: 'BV1', cid: 2 }),
    'cid 仍在参与指纹 —— 注册键与释放键会再次分叉');

  // 脏数据兜底：一个上游标识都没有时，才允许用 cid 区分，
  // 否则所有脏 spec 会塌缩成同一个空键而互相误杀。
  ok('无任何上游标识时退化用 cid 兜底', specKey({ cid: 111 }) !== specKey({ cid: 222 }),
    '空键塌缩：两条不同的脏 spec 互相误杀');
  ok('指纹区分清晰度', specKey({ bvid: 'BV1', quality: 80 }) !== specKey({ bvid: 'BV1', quality: 64 }),
    '不同清晰度被当成同一任务');
  ok('指纹区分分P', specKey({ bvid: 'BV1', pageIndex: 0 }) !== specKey({ bvid: 'BV1', pageIndex: 1 }),
    '同一视频不同 P 被当成同一任务');
  ok('指纹区分番剧集数', specKey({ epId: 100 }) !== specKey({ epId: 101 }), '不同 epId 撞键');
  ok('seasonId 与 epId 同归一格（同一次派发前后不会变键）',
    specKey({ seasonId: 5 }) === specKey({ epId: 5 }), 'seasonId→epId 收窄会改变指纹');
  ok('指纹区分课程集数', specKey({ cheeseId: 7 }) !== specKey({ cheeseId: 8 }), '不同 cheeseId 撞键');
}

console.log('\n[2] SpecKeyRegistry.claim / release 作用于同一把键');
{
  const reg = new SpecKeyRegistry();
  const spec = { bvid: 'BV1', pageIndex: 0 };
  const task = { spec };
  reg.claim(task);
  ok('claim 后 has() 为真', reg.has(spec));
  ok('claim 把键记在 task 上', typeof task.specKey === 'string' && task.specKey.length > 0);
  reg.release(task);
  ok('release 后集合回到空', reg.keys.size === 0, `残留 ${reg.keys.size} 个键`);
  ok('release 后 has() 为假（允许再次派发）', !reg.has(spec));

  // 重试场景：spec 已被改写，必须占回**同一把**键
  const reg2 = new SpecKeyRegistry();
  const spec2 = { bvid: 'BV1', pageIndex: 0 };
  const task2 = { spec: spec2 };
  const k0 = reg2.claim(task2);
  spec2.cid = 999;            // 模拟 ensureSpecComplete 原地补全
  reg2.release(task2);
  const k1 = reg2.claim(task2); // 「重试」
  ok('重试时占回同一把键（否则重试期间可被重复派发）', k0 === k1, `${k0} vs ${k1}`);
  ok('重试后集合里只有一把键', reg2.keys.size === 1, `实际 ${reg2.keys.size}`);
}

console.log('\n[3] ★ 端到端复现：内容脚本入口（无 cid）→ 引擎补全 → 释放，集合必须回到空');
{
  const reg = new SpecKeyRegistry();
  // content.js 悬浮按钮派发的 spec：只能从 URL 解析出 bvid，没有 cid
  const spec = { bvid: 'BV1xx411c7mD', pageIndex: 0, isBatch: false };
  const task = { spec };
  reg.claim(task);
  ok('派发后指纹被占住', reg.has(spec));

  // engine.run() 的第一步会原地补全 spec（补 cid 等）
  const api = makeApi({
    info: {
      title: '测试视频', bvid: 'BV1xx411c7mD', aid: 123, pic: '', pubdate: 0,
      owner: { name: 'UP', mid: 1 }, duration: 60, desc: '', tname: '', tid: 1,
      pages: [{ page: 1, cid: 39386548303, part: 'P1', duration: 60 }],
      rights: {},
    },
  });
  await ensureSpecComplete(spec, api);
  ok('ensureSpecComplete 反向填充了 cid（前置条件成立）', Number(spec.cid) > 0, `spec.cid=${spec.cid}`);
  ok('补全后指纹与补全前仍然相同', specKey(spec) === task.specKey,
    `补全后 ${specKey(spec)} ≠ 注册时 ${task.specKey}`);

  reg.release(task);
  ok('任务结束后集合回到空（旧实现此处会残留 1 个键）', reg.keys.size === 0,
    `残留 ${reg.keys.size} 个键 —— 指纹泄漏，同会话内该视频再也派发不出去`);
  ok('同一视频可以再次派发', !reg.has(spec));
}

console.log('\n[4] 番剧入口（epId / seasonId，无 cid）—— v1.4.30 新增的分支');
{
  const api = makeApi({
    season: {
      result: {
        season_title: '某番剧',
        episodes: [{ ep_id: 101, cid: 555, bvid: 'BV1bangumi1', aid: 9, title: '第1话', cover: '' }],
      },
    },
  });
  // ep 链接：content.js / 右键菜单只给得出 epId
  const s1 = { epId: 101, pageIndex: 0 };
  await ensureSpecComplete(s1, api);
  ok('番剧 epId：补出了 cid', Number(s1.cid) === 555, `cid=${s1.cid}`);
  ok('番剧 epId：补出了 bvid/aid（playurl 需要）', s1.bvid === 'BV1bangumi1' && s1.aid === 9);
  ok('番剧 epId：epId 落定（playurl 靠它走 pgc 分支）', Number(s1.epId) === 101);

  // ss 链接：只有 seasonId，需要收窄到具体一集
  const s2 = { seasonId: 88, pageIndex: 0 };
  await ensureSpecComplete(s2, api);
  ok('番剧 seasonId：收窄到第一集并补出 cid', Number(s2.cid) === 555, `cid=${s2.cid}`);
  ok('番剧 seasonId：补出了 epId', Number(s2.epId) === 101, `epId=${s2.epId}`);

  // 反向用例：接口拿不到剧集时必须**原样返回**（不塞假 cid），让下游报明确错误
  const s3 = { epId: 999, pageIndex: 0 };
  await ensureSpecComplete(s3, makeApi({ season: { result: { episodes: [] } } }));
  ok('番剧拿不到剧集时不伪造 cid', s3.cid === undefined, `被写入了 cid=${s3.cid}`);
}

console.log('\n[5] 课程入口（cheeseId）—— 回归守卫：v1.4.29 的 F4 不能被改回去');
{
  const api = makeApi({
    cheese: { title: '某课程', episodes: [{ id: 42, cid: 777, title: '第1节' }] },
  });
  const s = { cheeseId: 42, pageIndex: 0 };
  await ensureSpecComplete(s, api);
  ok('课程：补出了 cid', Number(s.cid) === 777, `cid=${s.cid}`);

  // 已经带 cid 的 spec 必须**原样短路返回**，不得再打接口
  let called = 0;
  const spy = {
    async videoInfo() { called += 1; return null; },
    async seasonInfo() { called += 1; return null; },
    async cheeseSeason() { called += 1; return null; },
  };
  const done = { bvid: 'BV1', cid: 123 };
  await ensureSpecComplete(done, spy);
  ok('已有 cid 时短路、不发任何请求', called === 0, `发了 ${called} 次请求`);

  // 完全没有上游标识的脏 spec 也必须原样放行（由 playurl 报明确错误）
  const junk = { pageIndex: 0 };
  await ensureSpecComplete(junk, spy);
  ok('无上游标识时短路、不发任何请求', called === 0, `发了 ${called} 次请求`);
}

console.log('\n[6] 番剧「恢复 ↔ 重新派发」指纹同形（v1.4.31 数据一致性 F2 的回归守卫）');
{
  const reg = new SpecKeyRegistry();
  // 番剧页派发：spec 只有 epId（无 bvid / aid / cid）
  const task = new Task({ epId: 101, pageIndex: 0 }, { title: '第1话' });
  reg.claim(task);
  ok('fresh 派发后指纹被占住', reg.has({ epId: 101, pageIndex: 0 }));

  const api = makeApi({
    season: {
      result: {
        season_title: '某番剧',
        episodes: [{ ep_id: 101, cid: 555, bvid: 'BV1bangumi1', aid: 9, title: '第1话', cover: '' }],
      },
    },
  });
  await ensureSpecComplete(task.spec, api);
  ok('运行中 spec 被原地补全（bvid/aid/cid 齐了，前置条件成立）',
    !!task.spec.bvid && !!task.spec.aid && Number(task.spec.cid) > 0);

  // ★ 关键前提：番剧补全会写回 bvid/aid —— 按**补全后**的 spec 重算出的键
  //   与 claim 时的键不同。这正是「恢复时重算不可靠」的根据。
  ok('番剧补全后按 spec 重算的键已与 claim 键不同（证明重算不可靠）',
    specKey(task.spec) !== task.specKey,
    '重算键竟与 claim 键相同 —— 本断言失去意义，请检查 specKey 是否又变了口径');

  // toRecord → 恢复（loadPendingTasks 的恢复路径）
  const rec = task.toRecord();
  ok('toRecord 持久化了 specKey', rec.specKey === task.specKey,
    `rec.specKey=${JSON.stringify(rec.specKey)} ≠ task.specKey=${JSON.stringify(task.specKey)}`);
  const restored = new Task(rec.spec || {}, {});
  restored.id = rec.id;
  if (rec.specKey) restored.specKey = rec.specKey;
  reg.claim(restored); // 恢复的 paused / pending / error 任务占位
  ok('恢复的任务占的是**同一把**键（重算的话就是另一把）',
    restored.specKey === task.specKey,
    `${JSON.stringify(restored.specKey)} vs ${JSON.stringify(task.specKey)}`);
  ok('集合里始终只有一把键', reg.keys.size === 1, `实际 ${reg.keys.size}`);
  // ★ 最终防线：恢复后同视频 fresh 重新派发（原始形态，只有 epId）必须被拦下 ——
  //   旧形态下这里放行 → 两个任务并发写同一个 resumeKey 的 .part → 坏文件。
  ok('恢复后同视频重新派发被拦截（不再建第二个任务）', reg.has({ epId: 101, pageIndex: 0 }),
    '重新派发被放行 —— 恢复键与派发键不同形，两个任务会并发写同一 .part');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 指纹自检${fail === 0 ? '通过' : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
