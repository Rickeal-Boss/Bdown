/**
 * 下载中心：任务队列 + 保存位置选择 + 实时进度。
 *
 * 之所以把重活放在这个页面而不是 Service Worker：MV3 的 Service Worker 会在空闲时被
 * 浏览器回收，长下载任务必然中断。扩展标签页没有这个限制，还能用 File System Access API
 * 直接写入用户选定的文件，天然支持 GB 级文件。
 */

import { DownloadEngine, Task } from '../core/engine.js';
import { BiliApi } from '../core/api.js';
import { loadSettings, saveSettings, onSettingsChanged } from '../core/settings.js';
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
    el.remove();
    nodes.delete(task.id);
    engine.tasks = engine.tasks.filter((t) => t.id !== task.id);
    updateCounts();
    persistHistory();
  });

  return el;
}

const STATUS_TEXT = {
  pending: '等待中',
  resolving: '解析中',
  downloading: '下载中',
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
  muxing: 'bd-badge bd-badge--pink',
  saving: 'bd-badge bd-badge--pink',
  done: 'bd-badge bd-badge--ok',
  error: 'bd-badge bd-badge--err',
  canceled: 'bd-badge',
};

function renderTask(task) {
  const el = ensureNode(task);
  el.dataset.status = task.status;
  el.className = `task${['resolving', 'downloading', 'muxing', 'saving'].includes(task.status) ? ' is-running' : ''}${
    task.status === 'done' ? ' is-done' : ''
  }${task.status === 'error' ? ' is-error' : ''}`;

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
    const suggested = `${task?.filename || 'bilibili'}.mp4`;
    const handle = await window.showSaveFilePicker({
      id: 'bdown-file',
      suggestedName: suggested,
      types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
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

async function startTask(task) {
  if (task.status !== 'pending' && task.status !== 'error' && task.status !== 'canceled') return;

  // ★ 尊重「同时下载的任务数」设置。
  //
  // 旧实现这里**完全没有检查** runningCount —— 于是逐个点「开始」时想跑几个跑几个，
  // 而 maxParallelTasks 只对「全部开始」生效。用户设了 2 却同时跑 5 个，
  // 会以为这个设置坏了。
  //
  // 这里不能像 pump() 那样自动排队：ask 模式下每个任务都要用户选保存位置，
  // 没有 destination 就没法自动启动。所以给出明确提示，让用户等槽位空出来。
  const maxParallel = Math.max(1, settings.maxParallelTasks || 2);
  if (runningCount >= maxParallel) {
    showToast(`已有 ${runningCount} 个任务在进行中（上限 ${maxParallel}），请等其中一个完成后再开始`);
    return;
  }

  const destination = await pickDestination(1);
  if (!destination) return;

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
    // 释放指纹：允许同一会话内再次下载这个视频（例如换个清晰度重下）
    releaseSpecKey(task);
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
  const finished = history.filter((r) => ['done', 'error', 'canceled'].includes(r.status));

    // 消费并建任务（去重逻辑在 acceptPending 里统一处理）
    const addedCount = await acceptPending(false);
    for (const rec of finished) {
    const task = new Task(rec.spec || {}, { title: rec.title, filename: rec.filename });
    task.id = rec.id;
    task.status = rec.status;
    task.quality = rec.quality;
    task.codec = rec.codec;
    task.totalBytes = rec.totalBytes;
    task.progress = rec.progress || (rec.status === 'done' ? 1 : 0);
    task.error = rec.error;
    task.createdAt = rec.createdAt;
    task.finishedAt = rec.finishedAt;
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
