/**
 * 下载中心：任务队列 + 保存位置选择 + 实时进度。
 *
 * 之所以把重活放在这个页面而不是 Service Worker：MV3 的 Service Worker 会在空闲时被
 * 浏览器回收，长下载任务必然中断。扩展标签页没有这个限制，还能用 File System Access API
 * 直接写入用户选定的文件，天然支持 GB 级文件。
 */

import { DownloadEngine, Task } from '../core/engine.js';
import { BiliApi } from '../core/api.js';
import { loadSettings, saveSettings, onSettingsChanged, savePickerHint } from '../core/settings.js';
import { OpfsWorkspace } from '../core/sink.js';
import { qualityShort } from '../core/quality.js';
import { formatBytes, formatSpeed, formatEta, log } from '../core/util.js';

const $ = (id) => document.getElementById(id);

const api = new BiliApi();
let settings = null;
let engine = null;
/** @type {Map<string, HTMLElement>} */
const nodes = new Map();
/** 会话内记住的目录句柄（批量任务复用） */
let rememberedDir = null;
let runningCount = 0;

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function showToast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function ensureNode(task) {
  let el = nodes.get(task.id);
  if (el) return el;
  const frag = $('taskTemplate').content.cloneNode(true);
  el = frag.querySelector('.task');
  el.dataset.id = task.id;
  nodes.set(task.id, el);
  $('taskList').appendChild(el);

  el.querySelector('.act-start').addEventListener('click', () => startTask(task));
  // 暂停：中断但**保留**续传清单，任务停在 paused，可原地「继续」。
  el.querySelector('.act-pause').addEventListener('click', () => pauseTask(task));
  // 继续：从断点接着下（续传清单还在时）或从头下（清单已失效时）
  el.querySelector('.act-resume').addEventListener('click', () => {
    resumeTask(task).catch((e) => showToast(e?.message || String(e)));
  });
  el.querySelector('.act-cancel').addEventListener('click', () => {
    task.cancel();
    showToast('已请求取消');
  });
  el.querySelector('.act-retry').addEventListener('click', () => {
    // 重新入队：保留 spec，重置状态
    task.controller = new AbortController();
    task.status = 'pending';
    task.error = '';
    task.progress = 0;
    task.downloadedBytes = 0;
    task.outputs = [];
    // 这些也必须清：留着会让 UI 显示上一轮的进度/速率/完成时间/输出名
    task.errorMessage = '';
    task.phaseText = '';
    task.totalBytes = 0;
    task.speed = 0;
    task.eta = 0;
    task.finishedAt = 0;
    renderTask(task);
    startTask(task);
  });
  el.querySelector('.act-open').addEventListener('click', async () => {
    const out = task.outputs.find((o) => o.downloadId);
    if (out?.downloadId) {
      chrome.downloads.show(out.downloadId);
      return;
    }
    const dir = task.lastDestination;
    if (dir?.kind === 'dir') {
      showToast(`文件已保存到：${task.filename}`);
      return;
    }
    showToast(task.outputs.map((o) => o.path).join('、') || '无输出文件');
  });
  el.querySelector('.act-remove').addEventListener('click', () => {
    // ★ 移除任何状态的任务前先 cancel（幂等）。
    //
    //   旧实现只对 paused 清清单，downloading 时直接从 tasks 里删掉 ——
    //   但下载 worker 还在跑（signal 没 abort），runTracked 的 finally 会把
    //   带 resumeKeys 的任务写回 taskHistory（用户以为删了，重启后复活）；
    //   用户若随即重新下载同一视频，旧 straggler 还会与新任务并发写同一 .part。
    //   审查轮 R3（运行时排障手）。
    task.cancel();
    // 移除一个「已暂停」的任务 = 用户放弃这次续传 → 必须把清单和 .part 一起删掉，
    // 否则它会永久占着 OPFS，且下次同一视频可能续到这份残缺数据上。
    // （downloading 中途取消的清单由 run() 的 catch 分支清；paused 到这里的清单只能在这里清。）
    if (task.status === 'paused') {
      task.paused = false;
      engine.discardResume(task).catch(() => {});
    }
    el.remove();
    nodes.delete(task.id);
    engine.tasks = engine.tasks.filter((t) => t.id !== task.id);
    // 清掉任务时也要释放指纹，否则这个视频在本会话内再也下不了
    releaseSpecKey(task);
    updateCounts();
    persistHistory();
  });

  return el;
}

const STATUS_TEXT = {
  pending: '等待中',
  resolving: '解析中',
  downloading: '下载中',
  paused: '已暂停',
  muxing: '合并中',
  saving: '保存中',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
};

const STATUS_CLASS = {
  pending: 'bd-badge',
  resolving: 'bd-badge bd-badge--blue',
  downloading: 'bd-badge bd-badge--blue',
  paused: 'bd-badge bd-badge--warn',
  muxing: 'bd-badge bd-badge--pink',
  saving: 'bd-badge bd-badge--pink',
  done: 'bd-badge bd-badge--ok',
  error: 'bd-badge bd-badge--err',
  canceled: 'bd-badge',
};

function renderTask(task) {
  const el = ensureNode(task);
  el.dataset.status = task.status;
  // ★ 「暂停」按钮只在开启断点续传时才有意义。
  //
  // 续传关闭时暂停 = 中断即丢弃（没有清单可留），点了「继续」就是从 0 重下，
  // 那是在骗用户。所以这里把开关状态写进 data-resume，由 CSS 决定按钮显隐：
  //   [data-status='downloading'][data-resume='1'] .act-pause { display: inline-flex }
  // 不用 el.querySelector(...).hidden —— 作者样式表里的 display:inline-flex
  // 优先级高于 UA 的 [hidden]{display:none}，设 hidden 是无效的。
  el.dataset.resume = settings?.resumeEnabled ? '1' : '0';
  const pauseBtn = el.querySelector('.act-pause');
  if (pauseBtn) {
    pauseBtn.title = settings?.resumeEnabled
      ? '暂停（保留已下载部分，可稍后继续）'
      : '需先在设置中开启「断点续传」才能暂停';
  }
  el.className = `task${['resolving', 'downloading', 'muxing', 'saving'].includes(task.status) ? ' is-running' : ''}${
    task.status === 'paused' ? ' is-paused' : ''
  }${task.status === 'done' ? ' is-done' : ''}${task.status === 'error' ? ' is-error' : ''}`;

  el.querySelector('.t-name').textContent = task.title || task.filename || '未命名任务';
  el.querySelector('.t-sub').textContent = [
    task.filename,
    task.quality ? `${task.quality} · ${qualityShort(task.quality)}` : '',
    task.codec,
    task.spec?.isBatch ? '批量' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const badge = el.querySelector('.t-status');
  badge.textContent = STATUS_TEXT[task.status] || task.status;
  badge.className = `t-status ${STATUS_CLASS[task.status] || 'bd-badge'}`;

  const pct = Math.round((task.progress || 0) * 100);
  el.querySelector('.bd-progress > i').style.width = `${pct}%`;

  const phase = task.status === 'error' ? task.error : task.phaseText || STATUS_TEXT[task.status];
  el.querySelector('.t-phase').textContent = phase || '';

  const parts = [];
  if (task.totalBytes) {
    parts.push(`${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}（${pct}%）`);
  }
  if (task.status === 'downloading' && task.speed) {
    parts.push(formatSpeed(task.speed));
    if (Number.isFinite(task.eta)) parts.push(`剩余 ${formatEta(task.eta)}`);
  }
  el.querySelector('.t-bytes').textContent = parts.join('  ·  ');

  el.querySelector('.task-outputs').textContent = (task.outputs || [])
    .map((o) => `${o.path}${o.bytes ? `（${formatBytes(o.bytes)}）` : ''}`)
    .join('　');
}

function updateCounts() {
  const total = engine?.tasks.length || 0;
  const byStatus = {};
  for (const t of engine?.tasks || []) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const parts = Object.entries(byStatus).map(([k, v]) => `${STATUS_TEXT[k] || k} ${v}`);
  $('counts').textContent = total ? `共 ${total} 个 · ${parts.join(' · ')}` : '';
  $('empty').hidden = total > 0;
}

/* ------------------------------------------------------------------ *
 * 任务调度
 * ------------------------------------------------------------------ */

async function pickDestination(taskCount) {
  if (settings.saveMode === 'downloads') return { kind: 'downloads' };

  try {
    if (taskCount > 1) {
      if (rememberedDir && $('rememberDir').checked) return { kind: 'dir', dir: rememberedDir };
      const dir = await window.showDirectoryPicker({ id: 'bdown-dir', mode: 'readwrite', startIn: 'downloads' });
      if ($('rememberDir').checked) rememberedDir = dir;
      return { kind: 'dir', dir };
    }
    const task = engine.tasks.find((t) => t.status === 'pending');
    // ★ 扩展名要跟着「下载方式」走。
    //
    // 原来一律建议 `.mp4`、类型也只给 `video/mp4`。而「仅音频」模式是
    // `singleOutput`，engine 会直接写进用户选的这个句柄 —— 于是磁盘上是
    // `xxx.mp4` 却只有音频，面板里显示的却是 `xxx.m4a`，两边对不上。
    // 无损轨是否建议 `.flac` 无法在此判定（plan 与音轨 mimeType 都还没有），
    // 由 savePickerHint 在 description 里提示用户按实际音质手动改。
    const mode = task?.spec?.downloadMode || settings.downloadMode;
    const name = task?.filename || 'bilibili';
    const { suggested, types } = savePickerHint(mode, name);
    const handle = await window.showSaveFilePicker({
      id: 'bdown-file',
      suggestedName: suggested,
      types,
    });
    return { kind: 'file', handle };
  } catch (err) {
    if (err?.name === 'AbortError') return null; // 用户取消
    log('保存位置选择失败，回退到浏览器下载目录', err);
    showToast('无法使用文件选择器，已回退到浏览器下载目录');
    return { kind: 'downloads' };
  }
}

/**
 * 从 chrome.storage 的 pendingTasks 里移除与 task 对应的条目。
 * 匹配依据：cid + pageIndex（同一视频的同一 P）。
 */
async function prunePendingTask(task) {
  try {
    const { pendingTasks = [] } = await chrome.storage.local.get('pendingTasks');
    if (!pendingTasks.length) return;
    const spec = task.spec || task;
    const cid = Number(spec.cid || 0);
    const page = Number(spec.pageIndex || 0);
    const next = pendingTasks.filter((s) => {
      if (!s || typeof s !== 'object') return false;
      const sameCid = cid > 0 && Number(s.cid || 0) === cid;
      const sameBvid = spec.bvid && s.bvid === spec.bvid;
      if (!sameCid && !sameBvid) return true;      // 不相关，保留
      return Number(s.pageIndex || 0) !== page;    // 相关且同 P -> 移除
    });
    if (next.length !== pendingTasks.length) {
      await chrome.storage.local.set({ pendingTasks: next });
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 运行一个任务并维护全局计数 / 持久化 / 队列泵。
 *
 * 「开始」「继续」「重试」三条路径共用它，避免把 finally 里的收尾逻辑复制三份
 * （复制三份的下场就是其中一份漏改 —— 本项目已经因此踩过好几次）。
 */
async function runTracked(task, destination) {
  task.lastDestination = destination;
  runningCount += 1;
  updateCounts();
  try {
    await engine.run(task, destination);
  } finally {
    runningCount -= 1;
    updateCounts();
    persistHistory();
    // 任务已到终态（done / error / canceled）：把 chrome.storage 里对应的
    // pendingTasks 条目清掉。否则用户取消后关掉下载中心再打开，
    // 那个已取消的任务会被重新入队（用户以为自己取消成功了）。
    await prunePendingTask(task);
    // 释放指纹：允许同一会话内再次下载这个视频（例如换个清晰度重下）。
    // ★ paused **不释放** —— 它还留在列表里等着被「继续」，此时若放行同名派发
    //   会建出第二个同内容任务，继续时两路写同一个 .part，文件必坏。
    if (task.status !== 'paused') releaseSpecKey(task);
    if (task.status === 'done' && settings.notifyOnComplete) {
      showToast(`已完成：${task.filename || task.title}`);
      // 下载中心在**后台标签页**时，页面内的 toast 用户根本看不到。
      //
      // 这里用扩展图标徽章补上：chrome.action.setBadgeText **不需要 notifications 权限**
      // （声明了 action 即可用），因此不会给安装流程增加权限警告 ——
      // 项目此前刻意移除过 notifications 权限（见 PRIVACY.md）。
      // 页面重新可见时徽章会被清掉（见下方 visibilitychange）。
      if (document.hidden) {
        // 注意 `a?.b?.().catch?.()` 这种写法**并不安全**：若方法存在但返回 undefined
        // （MV2 风格回调式 API 就是这样），`undefined.catch` 会直接抛 TypeError。
        // 可选链只短路 `?.` 左侧，保护不了后面的属性访问。改用 try/catch。
        try {
          const p = chrome.action?.setBadgeBackgroundColor?.({ color: '#2ecc71' });
          if (p && typeof p.catch === 'function') p.catch(() => {});
          const q = chrome.action?.setBadgeText?.({ text: '✓' });
          if (q && typeof q.catch === 'function') q.catch(() => {});
        } catch { /* 徽章不可用不影响下载本身 */ }
      }
    }
    pump();
  }
}

/** 并发槽位是否已满。满则返回提示文案，否则返回 ''。 */
function slotBusyMessage() {
  const maxParallel = Math.max(1, settings.maxParallelTasks || 2);
  // ★ 尊重「同时下载的任务数」设置。
  //
  // 旧实现这里**完全没有检查** runningCount —— 于是逐个点「开始」时想跑几个跑几个，
  // 而 maxParallelTasks 只对「全部开始」生效。用户设了 2 却同时跑 5 个，
  // 会以为这个设置坏了。
  //
  // 这里不能像 pump() 那样自动排队：ask 模式下每个任务都要用户选保存位置，
  // 没有 destination 就没法自动启动。所以给出明确提示，让用户等槽位空出来。
  if (runningCount >= maxParallel) {
    return `已有 ${runningCount} 个任务在进行中（上限 ${maxParallel}），请等其中一个完成后再试`;
  }
  return '';
}

async function startTask(task) {
  if (task.status !== 'pending' && task.status !== 'error' && task.status !== 'canceled') return;
  const busy = slotBusyMessage();
  if (busy) {
    showToast(busy);
    return;
  }
  const destination = await pickDestination(1);
  if (!destination) return;
  await runTracked(task, destination);
}

/**
 * 暂停一个正在下载的任务。
 *
 * 与「取消」的区别只有一句：暂停保留续传清单，取消丢弃它（见 engine.discardResume）。
 * 因此这里只置意图标记并 abort，真正的状态落定在 engine.run 的 catch 里。
 *
 * 只有 `downloading` 阶段提供暂停（按钮由 CSS 按 data-status 控制）：
 *  - resolving：还没产生任何字节，暂停没有意义
 *  - muxing / saving：中断会产出半截文件，只能取消
 */
function pauseTask(task) {
  if (task.status !== 'downloading') {
    showToast('只有下载中阶段可以暂停');
    return;
  }

  // ★ 未开启断点续传时**不能真的暂停**：那时中断即丢弃，没有清单可留，
  //   「继续」也只能从 0 重下 —— 那是在骗用户。
  //
  //   但也不能像早期那样把按钮**隐藏**掉：用户最初反馈的就是"没有暂停按钮"，
  //   功能上线了却看不见，需求等于原地打转。所以这里给出明确引导 ——
  //   点了就说明原因并直接打开设置页，让用户知道开关在哪。
  if (!settings?.resumeEnabled) {
    showToast('暂停需要开启「断点续传」，已为你打开设置页');
    try {
      chrome.runtime.openOptionsPage?.();
    } catch { /* 打不开不影响下载 */ }
    return;
  }

  task.pause();
  showToast('正在暂停…（等待在途分片收尾）');
}

/**
 * 校验（必要时重新申请）一个目录/文件句柄的写权限。
 *
 * 为什么必须查：File System Access API 的句柄**跨会话不自动恢复授权** ——
 * 页面刷新或浏览器重启后，`queryPermission` 会返回 'prompt'，
 * 此时直接 createWritable() 会抛 NotAllowedError。
 * 而 requestPermission 必须在**用户手势**里调用，所以只能放在按钮点击链路上。
 */
async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  try {
    const opts = { mode };
    let state = await handle.queryPermission(opts);
    if (state === 'granted') return true;
    if (state === 'prompt' && typeof handle.requestPermission === 'function') {
      state = await handle.requestPermission(opts);
    }
    return state === 'granted';
  } catch {
    return false;
  }
}

/**
 * 决定「继续」时要往哪里写。
 *
 * 优先复用上一轮的保存位置：暂停后每次都重新弹文件选择器会让「继续」变得
 * 比「取消重下」还麻烦，用户就不会用这个功能了。
 * 句柄失效（最常见是跨会话未授权）时才退回让用户重选，并说明原因。
 */
async function resolveDestination(task) {
  const prev = task.lastDestination;
  // ★ 没有上一轮位置（最常见的是"暂停 → 关掉页面 → 重开 → 继续"：
  //   lastDestination 是内存里的句柄，不会随历史一起存下来）时必须**问用户**，
  //   不能默默退回浏览器下载目录 —— 用户当初明明选了文件夹，续着续着文件跑到了
  //   ~/Downloads，还以为是扩展丢了设置。
  if (!prev) return pickDestination(1);
  if (prev.kind === 'downloads') return { kind: 'downloads' };
  const handle = prev.kind === 'dir' ? prev.dir : prev.handle;
  if (!handle) return pickDestination(1);
  if (await ensurePermission(handle, 'readwrite')) return prev;
  showToast('保存位置的授权已失效，请重新选择');
  return pickDestination(1);
}

/** 继续一个已暂停的任务。 */
async function resumeTask(task) {
  if (task.status !== 'paused') return;
  const busy = slotBusyMessage();
  if (busy) {
    showToast(busy);
    return;
  }

  const destination = await resolveDestination(task);
  // null = 用户在保存位置选择器里点了取消。此时**保持 paused**，
  // 不能把状态改成 canceled —— 用户只是还没决定存哪，不是要放弃。
  if (!destination) return;

  // 重置运行态字段，但**保留** downloadedBytes / totalBytes / progress：
  // 保留它们，进度条才会从断点接着走，而不是先跳回 0 吓用户一跳。
  task.paused = false;
  task.controller = new AbortController();
  task.status = 'pending';
  task.error = '';
  task.errorMessage = '';
  task.phaseText = '';
  task.speed = 0;
  task.eta = Infinity;
  task.finishedAt = 0;
  task.outputs = [];
  renderTask(task);
  await runTracked(task, destination);
}

async function startAll() {
  const pending = engine.tasks.filter((t) => t.status === 'pending');
  if (!pending.length) {
    showToast('没有等待中的任务');
    return;
  }
  let destination;
  if (settings.saveMode === 'downloads') {
    destination = { kind: 'downloads' };
  } else if (pending.length > 1 || $('rememberDir').checked) {
    destination = await pickDestination(2);
    if (!destination) return;
  } else {
    destination = await pickDestination(1);
    if (!destination) return;
  }

  for (const task of pending) {
    if (task.status !== 'pending') continue;
    task.lastDestination = destination;
    runningCount += 1;
    engine
      .run(task, destination)
      .catch((err) => log('任务异常', err))
      .finally(() => {
        runningCount -= 1;
        updateCounts();
        persistHistory();
        pump();
      });
    // 简单限流：达到并发上限时等待
    while (runningCount >= Math.max(1, settings.maxParallelTasks || 2)) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  updateCounts();
}

/** 队列泵：有空闲槽位就启动下一个等待任务（仅用于「浏览器下载目录」模式）。 */
function pump() {
  if (settings.saveMode !== 'downloads') return;
  const max = Math.max(1, settings.maxParallelTasks || 2);
  if (runningCount >= max) return;
  const next = engine.tasks.find((t) => t.status === 'pending');
  if (!next) return;
  next.lastDestination = { kind: 'downloads' };
  runningCount += 1;
  engine
    .run(next, { kind: 'downloads' })
    .catch((err) => log('任务异常', err))
    .finally(() => {
      runningCount -= 1;
      updateCounts();
      persistHistory();
      pump();
    });
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

const HISTORY_KEY = 'taskHistory';

async function persistHistory() {
  const records = engine.tasks.slice(-200).map((t) => t.toRecord());
  await chrome.storage.local.set({ [HISTORY_KEY]: records });
}

/**
 * 本会话已消费过的任务指纹集合。
 *
 * 为什么需要：`storage.onChanged` 的每个事件都携带**该次写入瞬间**的 `newValue` 快照。
 * 两次快速派发时（write1=[A]、write2=[A,B]）会触发两个事件，各自按自己的
 * newValue 建任务 → **任务 A 被创建两次 → 同一个视频重复下载两份**。
 */
const consumedSpecKeys = new Set();

/** 任务的稳定指纹：同一视频 + 同一分P + 同一清晰度视为同一个任务。 */
function specKey(spec) {
  return [
    spec?.bvid || '',
    spec?.aid || '',
    spec?.cid || '',
    spec?.epId || '',
    spec?.cheeseId || '',
    spec?.pageIndex ?? 0,
    spec?.quality ?? 0,
  ].join('|');
}

/**
 * 原子地「读 → 删 → 去重 → 建任务」一批待处理任务。
 *
 * 关键点：**不直接采用 onChanged 事件里的 newValue**。那个值是某次写入瞬间的快照，
 * 并发写入时会读到过期快照。这里改为每次都重新读 storage 的当前值并立即删除，
 * 再用指纹去重，保证同一任务只被建一次。
 */
async function acceptPending(isIncremental = false) {
  const { pendingTasks = [] } = await chrome.storage.local.get('pendingTasks');
  if (!pendingTasks.length) return 0;
  await chrome.storage.local.remove('pendingTasks');

  let added = 0;
  for (const spec of pendingTasks) {
    const key = specKey(spec);
    if (consumedSpecKeys.has(key)) continue;
    consumedSpecKeys.add(key);
    const task = engine.addTask(spec, {
      title: spec.title || spec.info?.title || spec.bvid || '视频任务',
      filename: spec.filename || '',
      subtitle: spec.qualityShort || '',
    });
    renderTask(task);
    added += 1;
  }
  if (added) {
    updateCounts();
    if (isIncremental) showToast(`新增 ${added} 个任务`);
  }
  return added;
}

/**
 * 释放一个任务占用的指纹，允许它**再次**被派发。
 *
 * 为什么必须释放：`consumedSpecKeys` 若只增不减，同一会话内第二次下载同一个视频
 * （比如下完发现选错清晰度、想换个档重下）会被**静默丢弃** —— UI 上什么都不出现，
 * 用户以为扩展坏了（v1.4.22 引入该去重时遗漏，随即修复）。
 * 任务进入终态（done / error / canceled）或被清除时调用。
 */
function releaseSpecKey(task) {
  try { consumedSpecKeys.delete(specKey(task?.spec || {})); } catch { /* ignore */ }
}

async function loadPendingTasks() {
  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
  // ★ `paused` 必须一并恢复。
  //
  // 它是**可恢复终态而非终态**：只恢复 done/error/canceled 的话，用户暂停后关掉
  // 下载中心再打开，那个任务会凭空消失 —— 而它留在 OPFS 里的 .part 与清单没人再管
  // （task 对象没了，resumeKeys 也没了，discardResume 无从调用），永久占着空间。
  const finished = history.filter((r) => ['done', 'error', 'canceled', 'paused'].includes(r.status));

    // 消费并建任务（去重逻辑在 acceptPending 里统一处理）
    const addedCount = await acceptPending(false);
    for (const rec of finished) {
    const task = new Task(rec.spec || {}, { title: rec.title, filename: rec.filename });
    task.id = rec.id;
    task.status = rec.status;
    task.quality = rec.quality;
    task.codec = rec.codec;
    task.totalBytes = rec.totalBytes;
    task.downloadedBytes = Number(rec.downloadedBytes) || 0;
    task.progress = rec.progress || (rec.status === 'done' ? 1 : 0);
    task.error = rec.error;
    task.createdAt = rec.createdAt;
    task.finishedAt = rec.finishedAt;
    // 恢复「已暂停」任务的续传归属：不还原就再也清不掉它的 .part（见上方说明）
    task.resumeKeys = Array.isArray(rec.resumeKeys) ? [...rec.resumeKeys] : [];
    if (task.status === 'paused') task.paused = true;
      engine.tasks.push(task);
      renderTask(task);
    }
    updateCounts();
    return addedCount;
  }

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

async function refreshStorageBadge() {
  const est = await OpfsWorkspace.estimate();
  $('storageBadge').textContent = est.quota
    ? `临时空间 ${formatBytes(est.usage)} / ${formatBytes(est.quota)}`
    : `临时空间 ${formatBytes(est.usage)}`;
}

async function init() {
  settings = await loadSettings();
  engine = new DownloadEngine({ api, settings, onUpdate: (task) => renderTask(task) });

  // ★ 设置页改动要**即时生效**，不能等用户重开下载中心。
  //
  // 下载中心是个长驻标签页，而设置页在另一个标签页。此前只在**本页**的
  // saveMode 下拉变化时才调 engine.updateSettings()，于是用户在设置页改了
  // 并发数 / 重试次数 / 附加内容开关后，回到下载中心**完全没生效** ——
  // 引擎还在用启动时那份旧 settings，用户以为设置坏了。
  //
  // onSettingsChanged（settings.js）本来就是为这个场景写的，但一直没被接上。
  onSettingsChanged((patch) => {
    settings = { ...settings, ...patch };
    engine.updateSettings(settings);
    // 「断点续传」开关直接决定「暂停」按钮显隐（写在 data-resume 上），
    // 所以设置一变就要把所有任务卡重渲染一遍，否则按钮状态是旧的。
    for (const t of engine.tasks) renderTask(t);
  });

  $('saveMode').value = settings.saveMode;
  $('saveMode').addEventListener('change', async () => {
    settings.saveMode = $('saveMode').value;
    await saveSettings({ saveMode: settings.saveMode });
    engine.updateSettings(settings);
    if (settings.saveMode === 'downloads') pump();
  });

  $('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btnClean').addEventListener('click', async () => {
    await engine.cleanupAll();
    await refreshStorageBadge();
    showToast('临时文件已清理');
  });
  $('btnStartAll').addEventListener('click', () => startAll().catch((e) => showToast(e.message)));
  $('btnPauseAll').addEventListener('click', () => {
    // ★ 必须与**单个任务**的「暂停」按钮行为一致（见 pauseTask）：
    //   没开断点续传时**不能真的暂停** —— 那时中断即丢弃，没有清单可留，
    //   「继续」也只能从 0 重下，toast 上写"保留断点，可继续"就是在骗用户。
    //   这里若不做同样的判断，用户关掉续传后照样能一键暂停 —— 于是任务停在 paused、
    //   清单却没留下，点「继续」只能从 0 重下；更糟的是 paused 不释放指纹，
    //   这些任务不点「移除」的话，本会话内这个视频再也派发不出去。
    //
    //   两个入口现在都是「可见但引导」而不是「隐藏」：早期把按钮藏起来过，
    //   结果用户最初反馈的"没有暂停按钮"体感一点没变，功能上线了却看不见。
    //   所以这里同样给 toast + 直接打开设置页，让用户知道开关在哪。
    if (!settings?.resumeEnabled) {
      showToast('「全部暂停」需要开启断点续传，已为你打开设置页');
      try {
        chrome.runtime.openOptionsPage?.();
      } catch { /* 打不开不影响下载 */ }
      return;
    }
    let n = 0;
    for (const t of engine.tasks) {
      if (t.status === 'downloading') {
        t.pause();
        n += 1;
      }
    }
    showToast(n ? `已暂停 ${n} 个任务（保留断点，可逐个点「继续」）` : '没有正在下载的任务');
  });
  $('btnCancelAll').addEventListener('click', () => {
    let n = 0;
    for (const t of engine.tasks) {
      if (['pending', 'resolving', 'downloading', 'muxing', 'saving'].includes(t.status)) {
        t.cancel();
        n += 1;
      }
    }
    showToast(n ? `已取消 ${n} 个任务` : '没有进行中的任务');
  });
  $('btnClearDone').addEventListener('click', () => {
    for (const t of [...engine.tasks]) {
      if (['done', 'error', 'canceled'].includes(t.status)) {
        nodes.get(t.id)?.remove();
        nodes.delete(t.id);
        // 清掉任务时也要释放指纹，否则这个视频在本会话内再也下不了
        releaseSpecKey(t);
      }
    }
    engine.tasks = engine.tasks.filter((t) => !['done', 'error', 'canceled'].includes(t.status));
    updateCounts();
    persistHistory();
  });

  // ★ 必须先注册监听，**再**消费 pendingTasks。
  //
  // 旧顺序是：loadPendingTasks() → await ensureAccount()（网络往返，可达数秒）
  // → 才 addListener。中间这个窗口里派发的任务被写进 pendingTasks 后
  // **没有任何监听者**，UI 不显示；而 service-worker 已刻意移除 tabs.reload()
  // （不会重刷页面补偿）→ 任务凭空消失，只有重开下载中心才恢复。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.pendingTasks) return;
    // 注意：handler 里不直接信 changes.pendingTasks.newValue —— 见 acceptPending 的说明
    acceptPending(true).catch((e) => showToast(e.message));
  });

  // 重新看到下载中心时清掉"已完成"徽章（避免用户已经看过了还一直挂着）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    try {
      const p = chrome.action?.setBadgeText?.({ text: '' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* 忽略 */ }
  });

  const added = await loadPendingTasks();
  refreshStorageBadge();
  setInterval(refreshStorageBadge, 8000);

  // 账号状态
  try {
    const acc = await api.ensureAccount({ force: true });
    $('accountLine').textContent = acc.isLogin
      ? `已登录：${acc.uname}${acc.vip ? '（大会员）' : ''}`
      : '未登录 — 1080P 及以上清晰度需要先在浏览器登录 B 站';
  } catch {
    $('accountLine').textContent = '账号状态读取失败';
  }

  if (added) {
    showToast(`已接收 ${added} 个任务，点击「全部开始」或单个任务的「开始」`);
    if (settings.saveMode === 'downloads') pump();
  }

  // （监听器的注册已上移到 loadPendingTasks() 之前，避免初始化窗口漏接任务）

  // 离开页面前提醒仍在进行的任务
  window.addEventListener('beforeunload', (e) => {
    const active = engine.tasks.some((t) => ['downloading', 'muxing', 'saving', 'resolving'].includes(t.status));
    if (active) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

init().catch((err) => {
  console.error(err);
  showToast(`初始化失败：${err.message}`);
});
