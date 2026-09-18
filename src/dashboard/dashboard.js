/**
 * 下载中心：任务队列 + 保存位置选择 + 实时进度。
 *
 * 之所以把重活放在这个页面而不是 Service Worker：MV3 的 Service Worker 会在空闲时被
 * 浏览器回收，长下载任务必然中断。扩展标签页没有这个限制，还能用 File System Access API
 * 直接写入用户选定的文件，天然支持 GB 级文件。
 */

import { DownloadEngine, Task } from '../core/engine.js';
import { BiliApi } from '../core/api.js';
import { loadSettings, saveSettings } from '../core/settings.js';
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

async function startTask(task) {
  if (task.status !== 'pending' && task.status !== 'error' && task.status !== 'canceled') return;
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
    if (task.status === 'done' && settings.notifyOnComplete) {
      showToast(`已完成：${task.filename || task.title}`);
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

async function loadPendingTasks() {
  const { pendingTasks = [] } = await chrome.storage.local.get('pendingTasks');
  if (pendingTasks.length) {
    await chrome.storage.local.remove('pendingTasks');
  }
  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
  const finished = history.filter((r) => ['done', 'error', 'canceled'].includes(r.status));

  const specs = [...pendingTasks];
  for (const spec of specs) {
    const task = engine.addTask(spec, {
      title: spec.title || spec.info?.title || spec.bvid || '视频任务',
      filename: spec.filename || '',
      subtitle: spec.qualityShort || '',
    });
    renderTask(task);
  }
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
  return specs.length;
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
      }
    }
    engine.tasks = engine.tasks.filter((t) => !['done', 'error', 'canceled'].includes(t.status));
    updateCounts();
    persistHistory();
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

  // 扩展弹窗再次派发任务时即时接收
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.pendingTasks) return;
    const list = changes.pendingTasks.newValue || [];
    if (!list.length) return;
    await chrome.storage.local.remove('pendingTasks');
    for (const spec of list) {
      const task = engine.addTask(spec, {
        title: spec.title || spec.info?.title || spec.bvid || '视频任务',
        filename: spec.filename || '',
      });
      renderTask(task);
    }
    updateCounts();
    showToast(`新增 ${list.length} 个任务`);
  });

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
