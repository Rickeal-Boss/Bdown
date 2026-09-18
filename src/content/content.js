/**
 * 内容脚本：在 B 站视频页注入「下载」入口。
 *
 * 只做两件事：
 *  1. 右下角悬浮按钮（可关闭）
 *  2. 尽量往播放器控制栏里塞一个按钮（播放器 DOM 变动时静默失败）
 *
 * 视频标识直接从 URL 解析，不依赖页面内部变量，避免被 B 站前端重构影响。
 */

const LOG_PREFIX = '%c[Bdown]';
const STYLE = 'color:#00a1d6;font-weight:bold';

/** @type {{bvid?: string, aid?: number, epId?: number, seasonId?: number, pageIndex: number}|null} */
let current = null;
let floatButton = null;
let playerButton = null;
let settings = { showFloatingButton: true, showPlayerButton: true };

function parseVideoFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const pageIndex = Math.max(0, (Number(url.searchParams.get('p')) || 1) - 1);
    const video = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    if (video) {
      const token = video[1];
      return token.toLowerCase().startsWith('bv')
        ? { bvid: token, pageIndex }
        : { aid: Number(token.slice(2)), pageIndex };
    }
    const ep = url.pathname.match(/\/bangumi\/play\/ep(\d+)/i);
    if (ep) return { epId: Number(ep[1]), pageIndex: 0 };
    const ss = url.pathname.match(/\/bangumi\/play\/ss(\d+)/i);
    if (ss) return { seasonId: Number(ss[1]), pageIndex: 0 };
    if (url.pathname.startsWith('/list/')) {
      const mid = url.searchParams.get('mid');
      if (mid) return { mid: Number(mid), pageIndex: 0, isSpace: true };
    }
    return null;
  } catch {
    return null;
  }
}

function isVideoPage() {
  const v = parseVideoFromUrl(location.href);
  return !!(v && !v.isSpace);
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

function ensureFloatButton() {
  if (!settings.showFloatingButton || !isVideoPage()) {
    floatButton?.remove();
    floatButton = null;
    return;
  }
  if (floatButton && document.body.contains(floatButton)) return;

  floatButton = document.createElement('div');
  floatButton.className = 'bdown-float';
  floatButton.title = 'Bdown：解析并下载此视频';
  floatButton.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1ZM5 18a1 1 0 0 1 1 1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"/>
    </svg>
    <span>下载</span>`;
  floatButton.addEventListener('click', () => {
    const spec = parseVideoFromUrl(location.href);
    if (!spec) return;
    chrome.runtime.sendMessage({
      type: 'OPEN_DASHBOARD',
      payload: { tasks: [{ ...spec, sourceUrl: location.href, isBatch: false }] },
    });
  });
  document.body.appendChild(floatButton);
}

function ensurePlayerButton() {
  if (!settings.showPlayerButton || !isVideoPage()) {
    playerButton?.remove();
    playerButton = null;
    return;
  }
  if (playerButton && document.body.contains(playerButton)) return;

  // B 站播放器控制栏的容器类名随版本变化，这里按优先级依次尝试
  const containers = [
    '.bpx-player-ctrl-btn[data-role="bpx-player-ctrl-right"]',
    '.bpx-player-control-bottom-right',
    '.bpx-player-ctrl-right',
    '.squirtle-controller .squirtle-right',
  ];
  const container = containers.map((s) => document.querySelector(s)).find(Boolean);
  if (!container) return;

  playerButton = document.createElement('div');
  playerButton.className = 'bdown-player-btn bpx-player-ctrl-btn';
  playerButton.title = 'Bdown：下载此视频';
  playerButton.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1ZM5 18a1 1 0 0 1 1 1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"/>
    </svg>`;
  playerButton.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const spec = parseVideoFromUrl(location.href);
    if (!spec) return;
    chrome.runtime.sendMessage({
      type: 'OPEN_DASHBOARD',
      payload: { tasks: [{ ...spec, sourceUrl: location.href, isBatch: false }] },
    });
  });
  container.appendChild(playerButton);
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

let lastUrl = location.href;

function refresh() {
  const spec = parseVideoFromUrl(location.href);
  const changed = JSON.stringify(spec) !== JSON.stringify(current);
  current = spec;
  if (!spec) {
    floatButton?.remove();
    playerButton?.remove();
    floatButton = null;
    playerButton = null;
    return;
  }
  if (changed) console.log(LOG_PREFIX, '检测到视频', spec, STYLE);
  ensureFloatButton();
  ensurePlayerButton();
}

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(refresh, 400);
    return;
  }
  ensurePlayerButton();
});

function start() {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
    if (res?.ok && res.settings) {
      settings = { ...settings, ...res.settings };
    }
    refresh();
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

// 设置变更时即时生效
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of ['showFloatingButton', 'showPlayerButton']) {
    if (changes[key]) settings[key] = changes[key].newValue;
  }
  floatButton?.remove();
  playerButton?.remove();
  floatButton = null;
  playerButton = null;
  refresh();
});
