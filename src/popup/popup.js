/**
 * 弹窗：解析当前视频 → 选清晰度 / 选集 → 交给下载中心执行。
 */

import { BiliApi, pickVideoTrack, pickAudioTrack } from '../core/api.js';
import { QUALITIES, qualityShort } from '../core/quality.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { extractVideoId, formatBytes, formatDuration, parseRangeExpr, sanitizeFilename, applyTemplate, formatNumber, escapeHtml } from '../core/util.js';

const $ = (id) => document.getElementById(id);

const api = new BiliApi();
let settings = null;
/** @type {any} */
let videoInfo = null;
/** @type {any} */
let playInfo = null;
/** @type {{ bvid?: string, aid?: number, epId?: number, seasonId?: number, pageIndex: number }|null} */
let currentSpec = null;
/** @type {Set<number>} 选中的分P（从 1 开始） */
let selectedPages = new Set();
let selectedQuality = 0;

/* ------------------------------------------------------------------ *
 * 状态渲染
 * ------------------------------------------------------------------ */

function showState(which, text) {
  $('loading').hidden = which !== 'loading';
  $('notVideo').hidden = which !== 'notVideo';
  $('error').hidden = which !== 'error';
  $('content').hidden = which !== 'content';
  if (text) $('errorText').textContent = text;
}

async function refreshLoginBadge() {
  try {
    const acc = await api.ensureAccount({ force: true });
    const badge = $('loginBadge');
    if (acc.isLogin) {
      badge.textContent = acc.vip ? `${acc.uname || '已登录'} · 大会员` : acc.uname || '已登录';
      badge.className = 'bd-badge bd-badge--ok';
      badge.title = `已登录：${acc.uname}（UID ${acc.mid}）`;
    } else {
      badge.textContent = '未登录';
      badge.className = 'bd-badge bd-badge--warn';
      badge.title = '未检测到 B 站登录状态，1080P 及以上清晰度可能不可用';
    }
  } catch {
    $('loginBadge').textContent = '状态未知';
  }
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

async function parseTab() {
  showState('loading');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const fromUrl = tab?.url ? extractVideoId(tab.url) : null;
  if (fromUrl) {
    const p = Number(new URL(tab.url).searchParams.get('p')) || 1;
    currentSpec = { ...fromUrl, pageIndex: p - 1 };
    await loadVideo();
    return;
  }
  currentSpec = null;
  showState('notVideo');
}

async function parseManual(text) {
  const id = extractVideoId(text.trim());
  if (!id) {
    $('manualInput').value = '';
    $('manualInput').placeholder = '无法识别的链接或 ID';
    return;
  }
  currentSpec = { ...id, pageIndex: 0 };
  showState('loading');
  await loadVideo();
}

async function loadVideo() {
  try {
    const spec = currentSpec;
    if (spec.epId) {
      const season = await api.seasonInfo(spec.epId);
      const ep = (season.result?.episodes || []).find((e) => e.ep_id === spec.epId) || season.result?.episodes?.[0];
      if (!ep) throw new Error('未找到该番剧剧集');
      videoInfo = {
        bvid: ep.bvid,
        aid: ep.aid,
        cid: ep.cid,
        title: season.result.season_title || ep.title,
        pic: ep.cover,
        pubdate: ep.pub_time || 0,
        owner: { name: season.result?.up_info?.uname || '', mid: season.result?.up_info?.mid || 0 },
        duration: ep.duration ? Math.round(ep.duration / 1000) : 0,
        pages: [{ page: 1, part: ep.title, cid: ep.cid, duration: ep.duration ? Math.round(ep.duration / 1000) : 0 }],
        epId: ep.ep_id,
      };
      currentSpec = { ...spec, bvid: ep.bvid, aid: ep.aid, epId: ep.ep_id };
    } else {
      videoInfo = await api.videoInfo(spec);
    }

    playInfo = await api.playurl({
      bvid: videoInfo.bvid,
      aid: videoInfo.aid,
      cid: videoInfo.pages[spec.pageIndex]?.cid || videoInfo.cid,
      epId: currentSpec.epId,
      qn: 127,
      mode: 'dash',
    });

    render();
    showState('content');
  } catch (err) {
    showState('error', err?.message || String(err));
  }
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function buildQualityOptions() {
  const formats = new Map();
  for (const f of playInfo.supportFormats || []) {
    formats.set(f.quality, f);
  }
  const accept = new Set(playInfo.acceptQuality || []);
  const bestAudio = pickAudioTrack(playInfo.audios, { preferLossless: settings.audioPreference !== 'normal' });

  const list = [];
  // 先放 B 站声明支持的清晰度（含未解锁的，用于提示需要大会员/登录）
  const declared = [...formats.keys()].sort((a, b) => b - a);
  for (const q of declared) {
    const f = formats.get(q);
    const available = accept.has(q);
    const video = pickVideoTrack(playInfo.videos, q, settings.preferCodec);
    const size = (video?.size || 0) + (bestAudio?.size || 0);
    list.push({
      quality: q,
      label: QUALITIES[q]?.label || f.new_description || f.display_desc || `清晰度 ${q}`,
      short: qualityShort(q),
      size: video ? size : 0,
      available: available && !!video,
      needVip: !!f.need_vip || !!QUALITIES[q]?.vip,
      needLogin: !!f.need_login || !!QUALITIES[q]?.login,
      codec: video?.codec || '',
    });
  }
  // 补上接口返回但 support_formats 里没有的
  for (const q of accept) {
    if (!list.some((x) => x.quality === q)) {
      const video = pickVideoTrack(playInfo.videos, q, settings.preferCodec);
      list.push({
        quality: q,
        label: QUALITIES[q]?.label || `清晰度 ${q}`,
        short: qualityShort(q),
        size: (video?.size || 0) + (bestAudio?.size || 0),
        available: !!video,
        needVip: !!QUALITIES[q]?.vip,
        needLogin: !!QUALITIES[q]?.login,
        codec: video?.codec || '',
      });
    }
  }
  return list;
}

function render() {
  const info = videoInfo;
  $('cover').src = info.pic || '';
  $('title').textContent = info.title || '';
  const owner = info.owner?.name ? `UP：${info.owner.name}` : '';
  const dur = formatDuration(info.pages?.[currentSpec.pageIndex]?.duration || info.duration || 0);
  $('subTitle').textContent = [owner, `${info.pages?.length || 1} 个分P`, dur].filter(Boolean).join(' · ');
  $('stats').textContent = `${info.bvid || ''}${info.aid ? ` · av${info.aid}` : ''}`;

  // 清晰度
  const options = buildQualityOptions();
  selectedQuality = selectedQuality || options.find((o) => o.available)?.quality || options[0]?.quality || 0;
  if (!options.some((o) => o.quality === selectedQuality && o.available)) {
    selectedQuality = options.find((o) => o.available)?.quality || options[0]?.quality || 0;
  }
  const listEl = $('qualityList');
  listEl.innerHTML = '';
  for (const opt of options) {
    const el = document.createElement('div');
    el.className = `quality-item${opt.available ? '' : ' is-disabled'}${opt.quality === selectedQuality ? ' is-active' : ''}`;
    const badges = [];
    if (!opt.available && opt.needVip) badges.push('<span class="bd-badge bd-badge--warn">大会员</span>');
    else if (!opt.available && opt.needLogin) badges.push('<span class="bd-badge bd-badge--warn">需登录</span>');
    if (opt.codec) badges.push(`<span class="bd-badge">${escapeHtml(opt.codec)}</span>`);
    el.innerHTML = `
      <span class="q-name">${escapeHtml(opt.label)}</span>
      ${badges.join('')}
      <span class="q-size">${opt.available ? formatBytes(opt.size) : '不可用'}</span>`;
    if (opt.available) {
      el.addEventListener('click', () => {
        selectedQuality = opt.quality;
        render();
      });
    }
    listEl.appendChild(el);
  }

  const missing = options.filter((o) => !o.available && o.needVip).map((o) => o.label);
  $('qualityHint').textContent = missing.length ? `需大会员：${missing.join('、')}` : '';

  // 下载方式
  const mode = settings.downloadMode;
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === mode;
  });
  $('modeHint').textContent = {
    merge: '下载 DASH 音视频后无损合并为单个 MP4（推荐，支持全部清晰度）',
    separate: '分别保存 video.mp4 与 audio.m4a，自行用播放器/ffmpeg 处理',
    audio: '只下载音轨并保存为 .m4a（B 站音轨本身是 fMP4，直接可播，无需转码）',
    durl: '直接下载单文件 MP4，无需合并；但清晰度上限较低（通常 720P/1080P）',
  }[mode];

  // 分P
  const pages = info.pages || [];
  const pagesSection = $('pagesSection');
  if (pages.length > 1) {
    pagesSection.hidden = false;
    if (!selectedPages.size) selectedPages.add(currentSpec.pageIndex + 1);
    const listEl2 = $('pagesList');
    listEl2.innerHTML = '';
    pages.forEach((p, i) => {
      const label = document.createElement('label');
      label.className = 'page-item';
      label.innerHTML = `
        <input type="checkbox" ${selectedPages.has(i + 1) ? 'checked' : ''} />
        <span class="p-name">P${escapeHtml(p.page)} ${escapeHtml(p.part || '')}</span>
        <span class="p-dur">${formatDuration(p.duration || 0)}</span>`;
      label.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) selectedPages.add(i + 1);
        else selectedPages.delete(i + 1);
        updateSummary();
      });
      listEl2.appendChild(label);
    });
  } else {
    pagesSection.hidden = true;
    selectedPages = new Set([1]);
  }

  // 附加内容
  $('optDanmaku').checked = !!settings.saveDanmaku;
  $('optSubtitle').checked = !!settings.saveSubtitle;
  $('optCover').checked = !!settings.saveCover;

  updateSummary();
}

function collectSpecs() {
  const info = videoInfo;
  const pages = info.pages || [];
  const total = pages.length;
  const chosen = [...selectedPages].sort((a, b) => a - b);
  const targets = pages.length > 1 ? chosen : [currentSpec.pageIndex + 1];
  const qualityOpt = buildQualityOptions().find((o) => o.quality === selectedQuality);

  return targets.map((p) => {
    const page = pages[p - 1] || pages[0];
    const vars = {
      title: info.title,
      part: page?.part || '',
      n: formatNumber(p, total),
      p,
      bvid: info.bvid || '',
      aid: info.aid || '',
      cid: page?.cid || '',
      user: info.owner?.name || '',
      userID: info.owner?.mid || '',
      qualityShort: qualityOpt?.short || '',
    };
    const template = total > 1 ? settings.batchNameTemplate : settings.singleNameTemplate;
    let filename = applyTemplate(template, vars);
    if (settings.nameWithQuality && qualityOpt?.short) {
      filename += applyTemplate(settings.qualitySuffix, vars);
    }
    return {
      bvid: info.bvid,
      aid: info.aid,
      epId: currentSpec.epId,
      cid: page?.cid,
      pageIndex: p - 1,
      totalPages: total,
      isBatch: total > 1,
      quality: selectedQuality,
      qualityShort: qualityOpt?.short || '',
      title: info.title,
      filename: sanitizeFilename(filename),
      cover: info.pic,
      info: {
        title: info.title,
        bvid: info.bvid,
        aid: info.aid,
        pubdate: info.pubdate,
        owner: info.owner,
        duration: info.duration,
        pages: info.pages,
      },
      page: page ? { page: page.page, part: page.part, cid: page.cid, duration: page.duration } : null,
      sourceUrl: `https://www.bilibili.com/video/${info.bvid || `av${info.aid}`}${total > 1 ? `?p=${p}` : ''}`,
    };
  });
}

function updateSummary() {
  const specs = collectSpecs();
  const qualityOpt = buildQualityOptions().find((o) => o.quality === selectedQuality);
  const totalSize = (qualityOpt?.size || 0) * specs.length;
  $('summary').innerHTML = `
    共 <b>${specs.length}</b> 个任务 · 清晰度 <b>${qualityOpt?.label || '—'}</b>
    · 预计 <b>${formatBytes(totalSize)}</b>
    ${settings.downloadMode === 'durl' ? '<br><span class="bd-hint">单文件直下模式的实际清晰度以接口返回为准</span>' : ''}`;
  $('btnStart').disabled = specs.length === 0;
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

async function startDownload() {
  const specs = collectSpecs();
  if (!specs.length) return;
  await saveSettings({
    downloadMode: document.querySelector('input[name="mode"]:checked')?.value || settings.downloadMode,
    saveDanmaku: $('optDanmaku').checked,
    saveSubtitle: $('optSubtitle').checked,
    saveCover: $('optCover').checked,
    defaultQuality: 0,
  });
  const res = await chrome.runtime.sendMessage({
    type: 'OPEN_DASHBOARD',
    payload: { tasks: specs, focus: true },
  });
  if (res?.ok) window.close();
}

function bindEvents() {
  $('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btnDashboard').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', payload: { tasks: [] } });
    window.close();
  });
  $('btnStart').addEventListener('click', startDownload);
  $('btnRetry').addEventListener('click', () => (currentSpec ? loadVideo() : parseTab()));
  $('btnManual').addEventListener('click', () => parseManual($('manualInput').value));
  $('manualInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') parseManual($('manualInput').value);
  });

  $('btnAllPages').addEventListener('click', () => {
    selectedPages = new Set((videoInfo?.pages || []).map((_, i) => i + 1));
    render();
  });
  $('btnNoPages').addEventListener('click', () => {
    selectedPages = new Set();
    render();
  });
  $('btnApplyRange').addEventListener('click', () => {
    const total = videoInfo?.pages?.length || 1;
    selectedPages = new Set(parseRangeExpr($('rangeInput').value, total));
    render();
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async () => {
      settings.downloadMode = r.value;
      $('modeHint').textContent = {
        merge: '下载 DASH 音视频后无损合并为单个 MP4（推荐，支持全部清晰度）',
        separate: '分别保存 video.mp4 与 audio.m4a，自行用播放器/ffmpeg 处理',
        audio: '只下载音轨并保存为 .m4a（B 站音轨本身是 fMP4，直接可播，无需转码）',
        durl: '直接下载单文件 MP4，无需合并；但清晰度上限较低（通常 720P/1080P）',
      }[r.value];
      updateSummary();
    });
  });

  ['optDanmaku', 'optSubtitle', 'optCover'].forEach((id) => {
    $(id).addEventListener('change', () => {
      settings.saveDanmaku = $('optDanmaku').checked;
      settings.saveSubtitle = $('optSubtitle').checked;
      settings.saveCover = $('optCover').checked;
    });
  });
}

async function init() {
  settings = await loadSettings();
  bindEvents();
  refreshLoginBadge();
  await parseTab();
}

init().catch((err) => showState('error', err?.message || String(err)));
