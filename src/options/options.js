/**
 * 设置页：所有字段通过 `data-key` 与 DEFAULT_SETTINGS 自动绑定，无需逐个写事件。
 */

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../core/settings.js';
import { BiliApi } from '../core/api.js';
import { QUALITIES } from '../core/quality.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const api = new BiliApi();

function showToast(text, ms = 2000) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/** 填充「默认清晰度」下拉框。 */
function fillQualitySelect() {
  const select = $('[data-key="defaultQuality"]');
  select.innerHTML = '<option value="0">自动（选择可用的最高清晰度）</option>';
  const ids = Object.keys(QUALITIES)
    .map(Number)
    .sort((a, b) => b - a);
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = String(id);
    opt.textContent = `${id} · ${QUALITIES[id].label}${QUALITIES[id].vip ? '（需大会员）' : QUALITIES[id].login ? '（需登录）' : ''}`;
    select.appendChild(opt);
  }
}

function applyToForm(settings) {
  for (const el of $$('[data-key]')) {
    const key = el.dataset.key;
    const value = settings[key];
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else if (el.dataset.type === 'number') {
      el.value = value === undefined || value === null ? '' : String(value);
    } else {
      el.value = value ?? '';
    }
  }
}

function collectFromForm() {
  const patch = {};
  for (const el of $$('[data-key]')) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') {
      patch[key] = el.checked;
    } else if (typeof DEFAULT_SETTINGS[key] === 'number') {
      // ★ 关键：**所有**在 DEFAULT_SETTINGS 里声明为 number 的字段都要转数字，
      // 不能只看 `data-type="number"` 属性。`<select>` 的 .value 永远是**字符串**，
      // 而 defaultQuality 是一个 select —— 如果按字符串存进 storage，
      // 下游 `if (!quality)` 判断会踩坑：JS 里 `!"0" === false`
      // （非空字符串是 truthy），"自动(0)" 会被当成"用户明确要求 0 档"，
      // 一路降级到 accept 最小档 360P。这正是 v1.4.20 修的那个 bug 的源头。
      const raw = el.value;
      if (raw === '' || raw === null || raw === undefined) {
        patch[key] = DEFAULT_SETTINGS[key];
      } else {
        const n = Number(raw);
        patch[key] = Number.isFinite(n) ? n : DEFAULT_SETTINGS[key];
      }
    } else {
      patch[key] = el.value;
    }
  }
  return patch;
}

/** 输入即时保存（防抖）。 */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = collectFromForm();
    // 数值字段做一次范围修正
    patch.concurrency = Math.min(16, Math.max(1, patch.concurrency || 8));
    patch.maxParallelTasks = Math.min(8, Math.max(1, patch.maxParallelTasks || 2));
    patch.danmakuOpacity = Math.min(1, Math.max(0.1, patch.danmakuOpacity || 0.85));
    patch.danmakuFontScale = Math.min(2, Math.max(0.5, patch.danmakuFontScale || 1));
    await saveSettings(patch);
    showToast('已保存');
  }, 350);
}

async function refreshAccount() {
  try {
    const acc = await api.ensureAccount({ force: true });
    const badge = $('#accountBadge');
    if (acc.isLogin) {
      badge.textContent = `${acc.uname}${acc.vip ? ' · 大会员' : ''}`;
      badge.className = 'bd-badge bd-badge--ok';
    } else {
      badge.textContent = '未登录 B 站';
      badge.className = 'bd-badge bd-badge--warn';
    }
  } catch {
    $('#accountBadge').textContent = '账号状态未知';
  }
}

async function init() {
  fillQualitySelect();
  const settings = await loadSettings();
  applyToForm(settings);

  for (const el of $$('[data-key]')) {
    el.addEventListener('change', scheduleSave);
    if (el.tagName === 'INPUT' && ['text', 'number'].includes(el.type)) {
      el.addEventListener('input', scheduleSave);
    }
  }

  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('确定要把所有设置恢复为默认值吗？')) return;
    await saveSettings(DEFAULT_SETTINGS);
    applyToForm(DEFAULT_SETTINGS);
    showToast('已恢复默认设置');
  });

  refreshAccount();
}

init();
