/**
 * MV3 Service Worker。
 *
 * 职责刻意保持极简：Service Worker 会被浏览器随时回收，不适合跑长任务。
 * 真正的下载/混流在「下载中心」页面（扩展标签页）里执行。
 */

import { DEFAULT_SETTINGS, loadSettings } from '../core/settings.js';
import { extractVideoId } from '../core/util.js';

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/index.html');

/** 打开（或聚焦）下载中心，并把待下载任务塞进 storage 交给它。 */
async function openDashboard(pendingTasks = [], { focus = true } = {}) {
  if (pendingTasks.length) {
    const { pendingTasks: existing = [] } = await chrome.storage.local.get('pendingTasks');
    await chrome.storage.local.set({ pendingTasks: [...existing, ...pendingTasks] });
  }
  const tabs = await chrome.tabs.query({ url: `${DASHBOARD_URL}*` });
  if (tabs.length) {
    const tab = tabs[0];
    if (focus) await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: focus });
    if (focus) await chrome.tabs.reload(tab.id);
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url: DASHBOARD_URL, active: focus });
  return tab.id;
}

/** 从标签页 URL / 页面里解析出视频标识。 */
function resolveTabVideoId(tab) {
  if (!tab?.url) return null;
  const direct = extractVideoId(tab.url);
  if (direct) return direct;
  return null;
}

/** 组装一个「下载当前页视频」的任务规格。 */
function buildSpecFromTab(tab) {
  const id = resolveTabVideoId(tab);
  if (!id) return null;
  const url = new URL(tab.url);
  const p = Number(url.searchParams.get('p')) || 1;
  return {
    ...id,
    pageIndex: p - 1,
    sourceUrl: tab.url,
    isBatch: false,
  };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  // 首次安装时写入默认设置，方便用户在设置页看到完整项
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[k] === undefined) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'bdown-download-page',
      title: '用 Bdown 下载此页视频',
      contexts: ['page', 'video'],
      documentUrlPatterns: ['*://*.bilibili.com/*'],
    });
    chrome.contextMenus.create({
      id: 'bdown-download-link',
      title: '用 Bdown 下载该视频',
      contexts: ['link'],
      targetUrlPatterns: ['*://*.bilibili.com/video/*', '*://*.bilibili.com/bangumi/play/*'],
    });
    chrome.contextMenus.create({
      id: 'bdown-open-dashboard',
      title: '打开 Bdown 下载中心',
      contexts: ['action'],
    });
  });

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'bdown-open-dashboard') {
    await openDashboard();
    return;
  }
  const target = info.menuItemId === 'bdown-download-link' ? info.linkUrl : tab?.url;
  if (!target) return;
  const id = extractVideoId(target);
  if (!id) {
    await openDashboard();
    return;
  }
  const url = new URL(target);
  const p = Number(url.searchParams.get('p')) || 1;
  await openDashboard([
    {
      ...id,
      pageIndex: p - 1,
      sourceUrl: target,
      isBatch: false,
    },
  ]);
});

/** 消息路由。 */
const handlers = {
  async OPEN_DASHBOARD(msg) {
    await openDashboard(msg.payload?.tasks || [], { focus: msg.payload?.focus !== false });
    return { ok: true };
  },

  async PARSE_TAB() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const spec = buildSpecFromTab(tab);
    return { ok: true, spec, tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null };
  },

  async GET_SETTINGS() {
    return { ok: true, settings: await loadSettings() };
  },

  async SAVE_SETTINGS(msg) {
    await chrome.storage.local.set(msg.payload || {});
    return { ok: true };
  },

  async PING() {
    return { ok: true, pong: Date.now() };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // 异步响应
});

// 首次安装/更新后确保 DNR 规则已启用
chrome.runtime.onStartup?.addListener(() => {
  chrome.declarativeNetRequest.getEnabledRulesets().then((ids) => {
    if (!ids.includes('bdown_referer')) {
      chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['bdown_referer'] });
    }
  });
});
