/**
 * MV3 Service Worker。
 *
 * 职责刻意保持极简：Service Worker 会被浏览器随时回收，不适合跑长任务。
 * 真正的下载/混流在「下载中心」页面（扩展标签页）里执行。
 */

import { DEFAULT_SETTINGS, loadSettings } from '../core/settings.js';
import { extractVideoId } from '../core/util.js';

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/index.html');

/**
 * 把任务追加进 `pendingTasks`，**串行化**执行。
 *
 * 为什么必须串行：`get` 与 `set` 是两步操作，中间有 await。用户快速连点两次
 * 悬浮按钮 → 两个 OPEN_DASHBOARD 并发到达 → 都读到同一个旧值 →
 * 后写的覆盖前写的 → **前一个任务凭空丢失**。
 *
 * MV3 Service Worker 是单线程事件循环，用一条 Promise 链就足以串行化
 * （不需要真正的锁）。链上任何一步失败都会 `.catch` 掉，不会把后续写入卡死。
 */
let pendingTasksWriteChain = Promise.resolve();
function appendPendingTasks(tasks) {
  if (!tasks || !tasks.length) return Promise.resolve();
  pendingTasksWriteChain = pendingTasksWriteChain
    .catch(() => {})
    .then(async () => {
      const { pendingTasks: existing = [] } = await chrome.storage.local.get('pendingTasks');
      await chrome.storage.local.set({ pendingTasks: [...existing, ...tasks] });
    });
  return pendingTasksWriteChain;
}

/** 打开（或聚焦）下载中心，并把待下载任务塞进 storage 交给它。 */
async function openDashboard(pendingTasks = [], { focus = true } = {}) {
  if (pendingTasks.length) {
    await appendPendingTasks(pendingTasks);
  }
  const tabs = await chrome.tabs.query({ url: `${DASHBOARD_URL}*` });
  if (tabs.length) {
    const tab = tabs[0];
    if (focus) await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: focus });
    // 注意：这里曾经无条件 `chrome.tabs.reload(tab.id)`。下载中心已经通过
    // `chrome.storage.onChanged` 即时接收新任务，**不需要重载**；而重载会在
    // 页面刚打开 / 网络抖动 / 离线时把下载中心刷成白屏，还会丢失正在跑的
    // 任务状态（内存态）。已移除——新任务靠 storage 消息驱动。
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
    // 只接受本扩展自己（各页面/内容脚本）发来的消息。未声明 externally_connectable，
    // 网页本来调不到；但同浏览器里的其他扩展可以，故显式校验 sender.id。
    if (!msg || sender?.id !== chrome.runtime.id) return false;
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
  ensureStrictOriginRule();
});

/**
 * 注册一条**只对自己扩展生效**的 Origin 改写规则（动态规则，priority 10）。
 *
 * 为什么需要它：
 * 静态规则 3 的条件是 `api.bilibili.com` + `excludedInitiatorDomains: ["bilibili.com"]`。
 * 那是"**排除**主站页面"，而不是"**限定**只对扩展生效" —— 于是任何**第三方页面**
 * （evil.com 之类）发往 api.bilibili.com 的请求，Origin 也会被改写成
 * `https://www.bilibili.com`。虽然 B 站的操作类接口另有 `bili_jct` CSRF token 兜底
 * （跨源读不到，攻击实际难以成立），但**扩大攻击面本身就不该做**。
 *
 * 静态 JSON 里写不了扩展 ID（打包时未知），所以用动态规则在运行时取
 * `chrome.runtime.id`。它的 host 恰好就是扩展 ID，与 `initiatorDomains` 的
 * 域名匹配逻辑一致（Chromium `DoesHostMatchDomainLists(origin.host(), ...)`）。
 *
 * 与静态规则 3 的关系：两者都命中扩展自身请求、动作相同，priority 10 的这条胜出；
 * 静态规则 3 保留作为**兜底**（万一动态规则注册失败，扩展仍能绕开 WAF 412）。
 * 对第三方页面，这条不匹配（initiator 不是扩展 ID），攻击面被收窄到只剩
 * 静态规则 3 那一层。
 *
 * 失败不致命：catch 掉即可，扩展功能不受影响。
 */
const STRICT_ORIGIN_RULE_ID = 1001;
async function ensureStrictOriginRule() {
  try {
    const extId = chrome.runtime.id;
    if (!extId) return;
    const rule = {
      id: STRICT_ORIGIN_RULE_ID,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' },
          // Referer 也必须由 DNR 补：它是 Fetch 规范里的 forbidden header name，
          // 在 fetch() 的 headers 里设置会被浏览器**静默丢弃**（不报错、不生效）。
          // api.js 的 COMMON_HEADERS 里写了 Referer 但实际从未送达 —— 只有 DNR 能改。
          { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
        ],
      },
      condition: {
        regexFilter: '^https?://api\\.bilibili\\.com/',
        resourceTypes: ['xmlhttprequest'],
        initiatorDomains: [extId],
      },
    };
    // 幂等：先删旧的同 id 规则再添加（updateDynamicRules 对已存在的 id 会报错）
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [STRICT_ORIGIN_RULE_ID],
      addRules: [rule],
    });
  } catch (err) {
    // 动态规则注册失败不影响扩展主流程（静态规则 3 仍在兜底）
    console.warn('[Bdown] 严格 Origin 规则注册失败（不影响功能，静态规则仍在兜底）', err?.message);
  }
}

// 安装 / 更新时也注册一次
chrome.runtime.onInstalled.addListener(() => {
  ensureStrictOriginRule();
});
