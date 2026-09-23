import { shouldHoldSpecKey } from './engine.js';

/**
 * 任务收尾编排（与 DOM / chrome API 解耦）。
 *
 * ★ 为什么单独成模块（v1.4.30）。
 *
 *   这段编排（计数 → 持久化 → 清 pendingTasks → 释放防重指纹 → 完成通知 → 队列泵）
 *   原来住在 `dashboard.js` 里，而 `dashboard.js` 在模块顶层就依赖 `document`，
 *   **在 CI 里 import 不了**。于是它长期处于「零行为覆盖」状态。
 *
 *   这不是推测 —— v1.4.30 的变异测试实测：把 `registry.release(task)` 整行删掉、
 *   或把 `await prunePending(task)` 整行删掉，**33 个套件依旧全绿**。
 *   而这段代码恰恰是 v1.4.29 刚修过的「复制三份必漏一份」（startAll / pump /
 *   runTracked 各自复制收尾，漏掉 prune 与 release）。也就是说：
 *   上一轮加的 `selftest-core` 源码计数守卫（数 `finishTracked(` 出现几次）
 *   **拦不住这类回归** —— 删掉函数体内的一行调用，计数完全不变。
 *
 *   把全部副作用改成依赖注入之后，编排逻辑本身就可以在 Node 里被直接断言
 *   （见 `tools/test-lifecycle.mjs`）：注入什么就断言什么，不靠 grep 计数。
 *
 * @param {object} deps
 * @param {() => void} deps.onSettled           运行计数 -1 并刷新计数栏
 * @param {() => Promise<void>} deps.persistHistory         把任务列表写回 storage
 * @param {(task: object) => Promise<void>} deps.prunePending 清掉 storage 里对应的待办条目
 * @param {import('./engine.js').SpecKeyRegistry} deps.registry 防重指纹表
 * @param {(task: object) => void|Promise<void>} deps.notifyDone 完成通知（仅在 notify 且终态为 done 时调用）
 * @param {() => void} deps.pump                队列泵
 * @param {(step: string, err: unknown) => void} [deps.onError] 单步失败的上报钩子
 * @returns {(task: object, opts?: { notify?: boolean }) => Promise<void>}
 */
export function createTaskFinisher({ onSettled, persistHistory, prunePending, registry, notifyDone, pump, onError = () => {} }) {
  /**
   * 跑一步收尾动作，失败只上报不抛出。
   *
   * ★ 为什么每一步都要独立兜错：收尾链上任何一步抛错，都会让**后面的步骤被整体跳过**。
   *   最要命的是「清 pendingTasks 失败 → 指纹没释放」—— 指纹泄漏是**静默**的
   *   （同一会话内该视频再也派发不出去，连 toast 都没有），而 `chrome.storage` 在
   *   配额满 / 并发写冲突时确实会抛。收尾步骤之间没有依赖，一步失败不该拖累其余。
   */
  const guard = async (step, fn) => {
    try {
      await fn();
    } catch (err) {
      try { onError(step, err); } catch { /* 上报本身失败不能反过来影响收尾 */ }
    }
  };

  /**
   * @param {object} task 已到终态的任务
   * @param {{ notify?: boolean }} [opts] runTracked 路径需要完成通知（toast + 徽章）
   */
  return async function finishTracked(task, { notify = false } = {}) {
    onSettled();
    // 任务已到终态（done / error / canceled）：把 chrome.storage 里对应的
    // pendingTasks 条目清掉。否则用户取消后关掉下载中心再打开，
    // 那个已取消的任务会被重新入队（用户以为自己取消成功了）。
    await guard('persistHistory', () => persistHistory());
    await guard('prunePending', () => prunePending(task));
    // 释放指纹：允许同一会话内再次下载这个视频（例如换个清晰度重下）。
    // ★ v1.4.31：哪些终态**不释放**由 `shouldHoldSpecKey()` 单独定义（engine.js），
    //   与 dashboard.loadPendingTasks 的恢复 claim 共用同一份判断 ——
    //   第一笔修复里这两处各写各的，收尾漏了「error 且带 resumeKeys」（.part/.json
    //   刻意留给「重试」）而恢复侧包含它：任务失败 → 释放 → 同视频重新派发放行
    //   → 点「重试」= 两任务并发写同一 .part。策略必须只有一处定义。
    // ★ 这一句**必须**在 guard 之外：它是收尾里唯一"少做就静默坏掉"的步骤。
    if (!shouldHoldSpecKey(task)) registry.release(task);
    if (notify && task.status === 'done') await guard('notifyDone', () => notifyDone(task));
    pump();
  };
}
