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

// BV 的合法字符集（与 src/core/avbv.js 的 TABLE 一致）。
// 这里重复一份以避免 content.js 依赖 ES Module 的循环引入问题。
const BV_BASE58 = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';
const BV_URL_RE = new RegExp(`/video/(BV1[${BV_BASE58}]{9}|av\\d+)`, 'i');

function parseVideoFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const pageIndex = Math.max(0, (Number(url.searchParams.get('p')) || 1) - 1);
    const video = url.pathname.match(BV_URL_RE);
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
    // 课程（pugv）：/cheese/play/ep<id> 与 /cheese/play/ss<id>
    const cep = url.pathname.match(/\/cheese\/play\/ep(\d+)/i);
    if (cep) return { cheeseId: Number(cep[1]), pageIndex: 0 };
    const css = url.pathname.match(/\/cheese\/play\/ss(\d+)/i);
    // ★ v1.4.30：这里以前返回 `{ cheeseSeasonId }` —— 全库**只有这一处**产出该字段，
    //   而 util.extractVideoId、engine.ensureSpecComplete、api.playurl 全都不认它，
    //   于是 /cheese/play/ss<id> 页面上点下载必定报「任务缺少 cid」。
    //   统一归一成 cheeseId（与 util.js 的 cheeseSs 分支一致），
    //   具体取哪一集由 ensureSpecComplete 兜底取第一集。
    if (css) return { cheeseId: Number(css[1]), pageIndex: 0 };
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

  // v1.4.30 无障碍：原为 <div onclick>，无法被 Tab 聚焦、也不响应 Enter/Space。
  // 改成 <button type="button"> —— 键盘 Enter/Space 会原生派发 click，
  // 无需再手写 keydown；可见焦点环见 content.css 的 :focus-visible。
  floatButton = document.createElement('button');
  floatButton.type = 'button';
  floatButton.className = 'bdown-float';
  floatButton.title = 'Bdown：解析并下载此视频';
  floatButton.setAttribute('aria-label', 'Bdown：解析并下载此视频');
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

  // v1.4.30 无障碍：同样由 <div> 改为 <button type="button">（键盘可达）。
  // 该按钮被塞进 B 站播放器控制栏，故仍保留 bpx-* 类名以沿用其布局；
  // content.css 里已补 border/padding/background 复位，避免 UA 按钮样式干扰。
  playerButton = document.createElement('button');
  playerButton.type = 'button';
  playerButton.className = 'bdown-player-btn bpx-player-ctrl-btn';
  playerButton.title = 'Bdown：下载此视频';
  playerButton.setAttribute('aria-label', 'Bdown：下载此视频');
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

/**
 * 播放器按钮检查是否已在下一帧排队。
 *
 * 为什么要节流：`observer` 监听的是 `document.body` 的 `childList + subtree`，
 * 在 B 站首页、动态流这类页面每秒可触发**上百次** DOM 变更。此前每次变更都同步
 * 跑一遍 `new URL()` + 多条正则 + DOM 查询 —— 纯浪费，且在低端机上可感卡顿。
 * 改为用 rAF 合并到**每帧最多一次**（约 16ms 一次），效果等价但开销降一个量级。
 */
let playerCheckScheduled = false;

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(refresh, 400);
    return;
  }
  if (playerCheckScheduled) return;
  playerCheckScheduled = true;
  requestAnimationFrame(() => {
    playerCheckScheduled = false;
    ensurePlayerButton();
  });
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
