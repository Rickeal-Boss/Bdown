/**
 * 页面模块加载冒烟测试（v1.4.31 新增，劣化回归审查 P0 的直接产物）。
 *
 * ★ 为什么需要这个套件：
 *
 *   v1.4.30 在 dashboard.js 里把 `createTaskFinisher({ registry: specRegistry })`
 *   写在了 `const specRegistry` 声明**之前** —— 模块求值时命中 TDZ，抛
 *   `ReferenceError: Cannot access 'specRegistry' before initialization`，
 *   **整个下载中心白屏**。而当时 35 个套件全绿、CI 46 步全绿 —— 因为没有任何
 *   一个套件会 import 这 5 个页面模块（它们顶层依赖 document / chrome）。
 *
 *   「pure 逻辑测试 + 静态 lint」对「模块顶层求值即崩」这一类错误是盲区：
 *   语法检查（node --check）合法、导入图完整、未定义标识符检查通过 ——
 *   只有**真的执行一遍模块求值**才会炸。本套件就是那"真的执行一遍"。
 *
 * 原理：给浏览器全局打上最小桩（chrome.* / document / location / window /
 * MutationObserver / matchMedia / rAF），然后 `await import()` 全部 5 个页面模块。
 * 页面模块的 `init()` 都是 async 且第一个语句就是 await，模块求值的同步部分
 * 只有「顶层常量求值 + 监听器注册」，桩足以覆盖；任何顶层 TDZ /
 * ReferenceError / TypeError 都会让 import 拒绝 → 本套件红。
 *
 * 运行：node tools/test-page-modules.mjs
 */

// ---------------------------------------------------------------- stubs --

/** 万能桩：任何属性访问返回新的万能桩，任何调用返回新的万能桩。 */
function anything(name = 'stub') {
  const cache = new Map();
  const fn = function () {
    return anything(`${name}()`);
  };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === Symbol.toPrimitive) return () => `[${name}]`;
      if (p === 'toString') return () => `[${name}]`;
      if (p === 'then') return undefined; // 关键：不能是 thenable，否则 await 会挂
      if (p === Symbol.iterator) return function* () {};
      if (!cache.has(p)) cache.set(p, anything(`${name}.${String(p)}`));
      return cache.get(p);
    },
    set(_t, p, v) {
      cache.set(p, v);
      return true;
    },
    apply() {
      return anything(`${name}()`);
    },
    construct() {
      return anything(`new ${name}`);
    },
    has() {
      return true;
    },
  });
}

const LOCATION = {
  href: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1',
  origin: 'https://www.bilibili.com',
  protocol: 'https:',
  host: 'www.bilibili.com',
  hostname: 'www.bilibili.com',
  pathname: '/video/BV1xx411c7mD',
  search: '?p=1',
  hash: '',
};

const storageArea = () => {
  const data = new Map();
  return {
    // chrome.storage.local.onChanged（按区域的事件）也要有 —— dashboard 的
    // onSettingsChanged 走的就是这一条
    onChanged: { addListener() {}, removeListener() {} },
    get: async (...keys) => {
      const out = {};
      for (const k of keys.flat()) {
        if (data.has(k)) out[k] = data.get(k);
      }
      return out;
    },
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
    remove: async (...keys) => {
      for (const k of keys.flat()) data.delete(k);
    },
    clear: async () => data.clear(),
  };
};

const chromeStub = {
  runtime: {
    id: 'bdown-test-extension-id',
    getURL: (p) => `chrome-extension://bdown-test-extension-id/${p}`,
    onInstalled: { addListener() {}, removeListener() {} },
    onStartup: { addListener() {}, removeListener() {} },
    onMessage: { addListener() {}, removeListener() {} },
    // content.js 的 start() 用的是 **callback 风格** sendMessage —— 桩必须真的调回调，
    // 否则「readyState 非 loading」分支在测试里静默挂起，双状态覆盖形同虚设。
    sendMessage: (msg, cb) => {
      const res = { ok: true, settings: {} };
      if (typeof cb === 'function') {
        try { cb(res); } catch { /* 回调抛错不该炸 import */ }
      }
      return Promise.resolve(res);
    },
    openOptionsPage: async () => {},
  },
  storage: {
    local: storageArea(),
    sync: storageArea(),
    onChanged: { addListener() {}, removeListener() {} },
  },
  tabs: {
    query: async () => [],
    create: async () => ({ id: 1 }),
    update: async () => ({}),
    sendMessage: async () => ({}),
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  contextMenus: {
    removeAll: (cb) => cb && cb(),
    create() {},
    onClicked: { addListener() {} },
  },
  declarativeNetRequest: {
    getEnabledRulesets: async () => [],
    updateEnabledRulesets: async () => {},
    updateDynamicRules: async () => {},
  },
  windows: { update: async () => ({}) },
  downloads: { download: async () => 1 },
};

const documentStub = anything('document');
documentStub.readyState = 'loading'; // 让 content.js 的 start() 走 DOMContentLoaded 延迟分支
documentStub.location = LOCATION;

class MutationObserverStub {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

globalThis.chrome = chromeStub;
globalThis.document = documentStub;
globalThis.location = LOCATION;
globalThis.window = globalThis;
// Node 21+ 的 globalThis.navigator 是 getter-only，已自带 userAgent，不可赋值
if (!globalThis.navigator) {
  try { globalThis.navigator = { userAgent: 'BdownSmokeTest' }; } catch { /* ignore */ }
}
globalThis.MutationObserver = globalThis.MutationObserver || MutationObserverStub;
globalThis.requestAnimationFrame =
  globalThis.requestAnimationFrame || ((cb) => setTimeout(() => cb(0), 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
globalThis.matchMedia =
  globalThis.matchMedia
  || (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));

// ---------------------------------------------------------------- test ----

/** 5 个「页面入口」模块：全部在浏览器上下文里加载，全部曾有顶层求值盲区。 */
const PAGE_MODULES = [
  'src/dashboard/dashboard.js',
  'src/popup/popup.js',
  'src/options/options.js',
  'src/content/content.js',
  'src/background/service-worker.js',
];

let failed = 0;
// ★ v1.4.31（QA 审查 W2）：异步阶段的异常也要算数。
//   页面模块的 init() 是 async，import 成功只证明「同步求值零异常」——
//   init 的异步段（storage 读取后的 DOM 操作）抛的错会变成 unhandledRejection，
//   不接住的话它只进 stderr、进程照样 exit 0，测试就「绿着漏了」。
let asyncRejections = 0;
process.on('unhandledRejection', (err) => {
  asyncRejections += 1;
  console.log(`  ✗ 未处理的 Promise 拒绝（异步段）: ${err?.constructor?.name}: ${err?.message}`);
});

// 变异对照入口：BDOWN_PAGE_ROOT 指向仓库外的一个 src 副本即可对旧版本做
// 「新测试必须能抓旧 bug」验证，全程不碰工作树（HANDOFF §3.5 的教训）。
const ROOT = process.env.BDOWN_PAGE_ROOT || '..';
for (const rel of PAGE_MODULES) {
  const label = `页面模块可加载: ${rel}`;
  try {
    // 断言非空对照（见 HANDOFF §4 纪律 2）：把 dashboard.js 的 specRegistry
    // 声明挪回 finishTracked 之后（即 v1.4.30 的坏形态）本套件必须红 ——
    // 已实测：v1.4.30 的 dashboard.js 在此 import 下抛
    // ReferenceError: Cannot access 'specRegistry' before initialization。
    await import(`${ROOT}/${rel}`);
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`      ${err?.constructor?.name}: ${err?.message}`);
    if (err?.stack) {
      const line = (err.stack.split('\n') || []).find((l) => l.includes(rel));
      if (line) console.log(`      at ${line.trim()}`);
    }
  }
}

// ★ v1.4.31（QA 审查 W1）：content.js 的顶层分两个分支 —— `readyState==='loading'`
//   走 DOMContentLoaded 延迟，**其余值（生产环境 document_idle 注入时是
//   'interactive'/'complete'）同步执行 start()`**。上面一轮只测了延迟分支。
//   这里把 readyState 切成生产真实值，再用 cache-busting query 强制重新求值一次，
//   覆盖同步分支（start → refresh → 注入按钮）。
documentStub.readyState = 'interactive';
{
  const label = '页面模块可加载: src/content/content.js（readyState=interactive，同步 start 分支）';
  try {
    await import(`${ROOT}/src/content/content.js?state=interactive`);
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`      ${err?.constructor?.name}: ${err?.message}`);
  }
}

// 冲掉 init()/start() 留下的微任务，让异步段的异常在统计前浮出
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
failed += asyncRejections;

console.log(failed === 0
  ? `\n全部 ${PAGE_MODULES.length} 个页面模块加载通过（模块求值零异常，异步段零未处理拒绝）`
  : `\n${failed} 项失败（含异步段 ${asyncRejections}）`);
// dashboard 的 init() 里有 setInterval（storageBadge 轮询），不显式退出会挂着进程
process.exit(failed === 0 ? 0 : 1);
