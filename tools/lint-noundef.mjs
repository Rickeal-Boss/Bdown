/**
 * 轻量「未定义标识符」静态检查（零依赖）。
 *
 * 为什么需要它：`node --check` 只做**语法**检查，抓不到「读取未声明变量」。
 * 本项目真的踩过：engine.js 的 merge 分支里 `vStage` / `aStage` 在重构（改名成
 * vPrep / aPrep）时漏改两行 —— 语法完全合法，`node --check` 通过、CI 全绿，
 * 但 ES Module 是严格模式，运行时直接 `ReferenceError`，默认 merge 模式 100%
 * 失败，一路溜过了 v1.3.1 与 v1.4.0 两个发布版本。
 *
 * 设计原则是**宁可漏报也不误报**：误报会让 CI 红在无关提交上，这种工具很快
 * 就会被关掉；漏报至多是多一层侥幸。所以凡是「看不准是不是声明」的构造，
 * 一律按「已声明」处理。
 *
 * 流程：
 *   1. 去掉注释 / 字符串 / 模板串（含嵌套 `${}`）/ 正则字面量
 *      —— 替换成等长空白，保证行号与列号不漂移
 *   2. 收集本文件声明的名字：import、const/let/var（含对象与数组解构）、
 *      function、class、catch 参数、函数参数列表（含解构与默认值）、
 *      箭头函数单参数、对象方法简写、for-of/in
 *   3. 收集「裸标识符」引用，减去：属性访问（`obj.name` / `a?.b`）、
 *      对象字面量的 `key:` 形式、数字字面量里的片段（`0xff` 的 `xff`、
 *      `1_000` 的 `_000`）、转义序列（`\u202a` 的 `u202a`）、
 *      关键字、全局白名单
 *   4. 剩下的报出来
 *
 * 运行：node tools/lint-noundef.mjs
 * 退出码：0 = 通过；1 = 发现可能未定义的标识符
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 扫描范围：扩展源码 + 本项目自带脚本。dist/ 是构建产物，跳过。 */
const SCAN_DIRS = ['src', 'tools'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'docs', 'samples', '.research']);

/** 浏览器 + Node + 本项目用得到的全局名，放宽一些以免误报。 */
const GLOBALS = new Set([
  // 语言内置
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity', 'this', 'arguments',
  'globalThis', 'global', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'TextEncoder', 'TextDecoder', 'Blob', 'File', 'FileReader', 'FormData',
  'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'fetch',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget',
  'ReadableStream', 'WritableStream', 'TransformStream',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
  'performance', 'crypto', 'btoa', 'atob', 'escape', 'unescape', 'Intl',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  // 浏览器 / 扩展
  'window', 'self', 'top', 'parent', 'document', 'console', 'navigator',
  'location', 'history', 'alert', 'confirm', 'prompt',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'DOMParser', 'XMLSerializer', 'XMLHttpRequest', 'WebSocket',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'AudioContext', 'OfflineAudioContext', 'Image', 'ImageBitmap',
  'OffscreenCanvas', 'Worker', 'chrome', 'browser',
  // Node（tools/ 脚本用得到）
  'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename',
]);

/** JS 关键字与保留字。 */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'new', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
  'throw', 'try', 'catch', 'finally', 'function', 'const', 'let', 'var',
  'class', 'extends', 'super', 'import', 'export', 'from', 'as', 'async',
  'await', 'yield', 'static', 'get', 'set', 'default', 'with', 'debugger',
]);

/**
 * 出现在 `(` 前面的这些关键字意味着这不是形参列表，而是控制结构 / 调用。
 * 例如 `if (x) {`、`for (...)`、`catch (e)`、`await foo(...)`。
 */
const NOT_PARAM_BEFORE = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'return',
  'typeof', 'instanceof', 'in', 'of', 'new', 'throw', 'delete', 'void',
  'await', 'yield', 'super', 'with', 'import', 'export',
]);

const ID_RE = /[A-Za-z_$][\w$]*/g;

/* ------------------------------------------------------------------ *
 * 1. 去掉非代码部分
 * ------------------------------------------------------------------ */

/** 判断此处的 `/` 是正则起始还是除号：看前一个非空白字符。 */
const REGEX_OK_AFTER = new Set([
  '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '<', '>', '~', '^', '\n', '',
]);

const blank = (s) => s.replace(/[^\n]/g, ' ');

function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const prevMeaningful = (pos) => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(src[j])) j -= 1;
    return j >= 0 ? src[j] : '';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // 行注释
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    // 块注释
    if (c === '/' && d === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += blank(src.slice(start, i));
      continue;
    }
    // 正则字面量
    if (c === '/' && REGEX_OK_AFTER.has(prevMeaningful(i))) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') { inClass = true; i += 1; continue; }
        if (src[i] === ']') { inClass = false; i += 1; continue; }
        if (src[i] === '/' && !inClass) { i += 1; break; }
        if (src[i] === '\n') break;
        i += 1;
      }
      while (i < n && /[gimsuyd]/.test(src[i])) i += 1;
      out += blank(src.slice(start, i));
      continue;
    }
    // 单双引号字符串
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += blank(src.slice(start, i));
      continue;
    }
    // 模板串（含嵌套 `${ ... }`）
    if (c === '`') {
      const start = i;
      i += 1;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { depth += 1; i += 2; continue; }
        if (src[i] === '}' && depth > 0) { depth -= 1; i += 1; continue; }
        if (src[i] === '`' && depth === 0) { i += 1; break; }
        i += 1;
      }
      out += blank(src.slice(start, i));
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. 收集声明
 * ------------------------------------------------------------------ */

function addAll(names, text) {
  if (!text) return;
  for (const m of text.matchAll(ID_RE)) names.add(m[0]);
}

/** 找到与 code[i] === '(' 配对的 ')' 的下标；找不到返回 -1。 */
function matchParen(code, i) {
  let depth = 0;
  for (let j = i; j < code.length; j += 1) {
    const ch = code[j];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * 找出所有「形参列表」的括号区间。
 *
 * 判定为形参列表的条件（任一）：
 *   - 紧跟 `=>`（箭头函数）
 *   - 紧跟 `{`，且前面不是控制结构关键字（函数声明 / 方法定义）
 *   - 前面是 `function` / `async`
 */
function findParamLists(code) {
  const out = [];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] !== '(') continue;
    const close = matchParen(code, i);
    if (close < 0) break;

    const after = /^\s*(=>|\{)/.test(code.slice(close + 1));
    const beforeId = /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(0, i));
    const before = beforeId ? beforeId[1] : '';

    let isParams = false;
    if (/^\s*=>/.test(code.slice(close + 1))) isParams = true;
    else if (/^\s*\{/.test(code.slice(close + 1)) && !NOT_PARAM_BEFORE.has(before)) isParams = true;
    else if (/^\s*async\s*$/.test(code.slice(0, i))) isParams = true;

    // 只有确认是形参列表时才跳过整段；否则继续逐字符扫描，
    // 否则 `.sort((a, b) => …)` 里的内层箭头形参会被外层调用括号吞掉。
    if (isParams) {
      out.push([i, close]);
      i = close;
    }
  }
  return out;
}

function collectDeclared(code) {
  const names = new Set();

  // 匹配形如 import 花括号列表 或 默认导入 或 命名空间导入 的写法
  for (const m of code.matchAll(/\bimport\s+([^;]+?)\s+from\b/g)) {
    const clause = m[1];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const t = part.trim();
        if (t) names.add(t.split(/\s+as\s+/).pop().trim());
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, ' ');
    const ns = rest.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) names.add(ns[1]);
    else addAll(names, rest.replace(/\*/g, ' '));
  }

  // const / let / var —— 简单名、对象解构、数组解构
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) addAll(names, m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) addAll(names, m[1]);

  // function / class
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // catch (e)
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) names.add(m[1]);

  // 形参列表：把整段（含解构与默认值）里的标识符都算作已声明。
  // 形参列表内部不会出现「引用未声明变量」这种我们想抓的 bug，
  // 所以这里宁可多声明也不放过。
  for (const [open, close] of findParamLists(code)) addAll(names, code.slice(open + 1, close));

  // 箭头函数单参数（无括号）
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);

  // 对象方法简写与方法名：foo(...) { }
  for (const m of code.matchAll(/(?:^|[\s,{;])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    names.add(m[1]);
  }

  return names;
}

/* ------------------------------------------------------------------ *
 * 3. 收集引用
 * ------------------------------------------------------------------ */

function collectUsed(code) {
  const used = new Map(); // name -> 首次出现的下标
  for (const m of code.matchAll(ID_RE)) {
    const idx = m.index;

    // 跳过数字字面量里的片段：0xff 的 `xff`、1_000 的 `_000`
    const prev = idx > 0 ? code[idx - 1] : '';
    if (prev >= '0' && prev <= '9') continue;
    // 跳过转义序列里的片段：\u202a 的 `u202a`、\d 的 `d`
    if (prev === '\\') continue;

    // 跳过属性访问：obj.name / a?.b / obj . name
    const before = /[.\s?]*$/.exec(code.slice(Math.max(0, idx - 4), idx))[0];
    if (before.includes('.')) continue;

    // 跳过对象字面量的 `key:` 形式（三元 `x : y` 的左侧也一并放过，漏报可接受）
    const after = code.slice(idx + m[0].length).match(/^\s*(.)/);
    if (after && after[1] === ':') continue;

    if (!used.has(m[0])) used.set(m[0], idx);
  }
  return used;
}

/* ------------------------------------------------------------------ *
 * 4. 主流程
 * ------------------------------------------------------------------ */

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, acc);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
files.sort();

let problems = 0;
for (const file of files) {
  const code = stripNonCode(readFileSync(file, 'utf8'));
  const declared = collectDeclared(code);
  const used = collectUsed(code);

  for (const [name, idx] of used) {
    if (declared.has(name)) continue;
    if (GLOBALS.has(name)) continue;
    if (KEYWORDS.has(name)) continue;
    problems += 1;
    console.log(
      `  ✗ ${relative(ROOT, file).replace(/\\/g, '/')}:${lineOf(code, idx)}` +
      ` — 可能未定义的标识符 \`${name}\``,
    );
  }
}

if (problems === 0) {
  console.log(`\n✅ 未定义标识符检查通过（扫描 ${files.length} 个文件，0 处问题）\n`);
  process.exit(0);
}
console.log(`\n❌ 未定义标识符检查发现 ${problems} 处问题（扫描 ${files.length} 个文件）\n`);
process.exit(1);
