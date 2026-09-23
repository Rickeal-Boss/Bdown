/**
 * 弹窗：解析当前视频 → 选清晰度 / 选集 → 交给下载中心执行。
 */

import { BiliApi, pickVideoTrack, pickAudioTrack, pickExactTrack } from '../core/api.js';
import { QUALITIES, qualityShort } from '../core/quality.js';
import { loadSettings, saveSettings, MODE_HINTS, AUDIO_UNAVAILABLE_HINT, estimateSizeBytes } from '../core/settings.js';
import { extractVideoId, formatBytes, formatDuration, parseRangeExpr, sanitizeFilename, applyTemplate, formatNumber, escapeHtml, warn, dateVars } from '../core/util.js';
import { parseUgcSeason, isBatchableSeason, seasonToSpecs } from '../core/season.js';

const $ = (id) => document.getElementById(id);

const api = new BiliApi();
let settings = null;
/** @type {any} */
let videoInfo = null;
/** 当前视频所属的合集（ugc_season）；不是每个视频都有 */
let ugcSeason = null;
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

/**
 * 进入一个**新视频**时清掉上一个视频的选择残留。
 *
 * 为什么需要：`selectedQuality` / `selectedPages` 是模块级状态，弹窗不关闭时
 * （例如用户用「粘贴链接」连续解析两个视频）会带着上一个视频的值。
 * 后果：上一个视频选了 360P，下一个视频（有 1080P）会**静默沿用 360P** ——
 * 用户以为"自动选了最高"，实际下的还是 360P。
 *
 * 只在 parseTab / parseManual（新视频入口）调用；**不在 loadVideo 里调** ——
 * 那是 btnRetry 也会走的路径，重试同一个视频时不该丢掉用户的分P勾选。
 */
function resetSelection() {
  selectedQuality = 0;
  selectedPages = new Set();
}

async function parseTab() {
  showState('loading');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const fromUrl = tab?.url ? extractVideoId(tab.url) : null;
  if (fromUrl) {
    const p = Number(new URL(tab.url).searchParams.get('p')) || 1;
    currentSpec = { ...fromUrl, pageIndex: p - 1 };
    resetSelection();
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
  resetSelection();
  showState('loading');
  await loadVideo();
}

async function loadVideo() {
  try {
    const spec = currentSpec;
    // 番剧：seasonId（/bangumi/play/ss<id>）与 epId（ep<id>）都要能进。
    // B 站的 /pgc/view/web/season 同时接受 season_id 与 ep_id，
    // seasonInfo() 已按入参分流，这里把两个 id 都传下去。
    if (spec.epId || spec.seasonId) {
      const season = await api.seasonInfo(spec.seasonId, { epId: spec.epId });
      const eps = season.result?.episodes || [];
      // 有 epId 就精确匹配，只有 ss<id> 时取第一集
      const ep = (spec.epId ? eps.find((e) => e.ep_id === spec.epId) : null) || eps[0];
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
      currentSpec = { ...spec, bvid: ep.bvid, aid: ep.aid, epId: ep.ep_id, seasonId: spec.seasonId };
    } else {
      videoInfo = await api.videoInfo(spec);
    }

    // 合集（ugc_season）批量入口：走 view/detail，**不碰 space 接口**
    // （space 实测 -352 风控）。不是每个视频都有合集，失败绝不能影响单视频下载。
    ugcSeason = null;
    try {
      if (videoInfo?.bvid && !spec.epId && !spec.seasonId) {
        const detail = await api.videoDetail({ bvid: videoInfo.bvid });
        const parsed = parseUgcSeason(detail);
        ugcSeason = isBatchableSeason(parsed) ? parsed : null;
      }
    } catch (err) {
      warn('合集信息获取失败（不影响单视频下载）', err?.message);
      ugcSeason = null;
    }

    playInfo = await api.playurl({
      bvid: videoInfo.bvid,
      aid: videoInfo.aid,
      cid: videoInfo.pages[spec.pageIndex]?.cid || videoInfo.cid,
      epId: currentSpec.epId,
      cheeseId: currentSpec.cheeseId, // 课程必需，缺了 playurl 走不到 /pugv 分支
      qn: 0, // 0 = 自动：让 api.playurl 按账号（大会员/非会员）挑上限
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

  /**
   * 取**恰好等于** q 档的轨道（同档多编码时按编码偏好挑一条）。
   *
   * ★ 这里绝不能退化成 `pickVideoTrack(videos, q)` —— 它的语义是"不超过 q 的
   * 最高档"，在缺少高画质轨道时会**回退到低档并返回一条非空轨道**，于是
   * `!!video` 恒为真，UI 会把 1080P60 标成"可用"而实际只有 480P。
   * 这正是「弹窗显示 1080P、下到 360P」的直接成因（v1.4.20 修复）。
   *
   * 实现放在 api.js 的 `pickExactTrack`，与 `pickVideoTrack` 同源，
   * 这样 tools/test-quality-pick.mjs 能直接对**生产代码**做断言，而不是抄一份逻辑。
   */
  const exactTrack = (q) => pickExactTrack(playInfo.videos, q, settings.preferCodec);

  /** 构造一个选项对象。available 以「该档位真实存在轨道」为唯一依据。 */
  const makeOption = (q, extra = {}) => {
    const video = exactTrack(q);
    return {
      quality: q,
      label: extra.label || QUALITIES[q]?.label || `清晰度 ${q}`,
      short: qualityShort(q),
      // ★ 体积口径随下载方式变化（仅音频只算音轨），实现见 settings.js 的
      //   estimateSizeBytes —— 抽成纯函数才能被单测锁定。切换下载方式后必须重算，
      //   否则这里算出的数字不会被刷新（重算点在 bindEvents 的 mode change 处理里）。
      size: estimateSizeBytes(currentMode(), video?.size, bestAudio?.size),
      // ★ 只认"精确存在"。accept_quality 会虚报（实测未登录时宣称
      // [116,80,64,32,16] 而 dash.video 只有 [32,16]），不能作为可用性依据。
      available: !!video,
      needVip: extra.needVip ?? !!QUALITIES[q]?.vip,
      needLogin: extra.needLogin ?? !!QUALITIES[q]?.login,
      codec: video?.codec || '',
    };
  };

  const list = [];
  // 先放 B 站声明支持的清晰度（含未解锁的，用于提示需要大会员/登录）
  for (const q of [...formats.keys()].sort((a, b) => b - a)) {
    const f = formats.get(q);
    list.push(makeOption(q, {
      label: QUALITIES[q]?.label || f.new_description || f.display_desc,
      needVip: !!f.need_vip || !!QUALITIES[q]?.vip,
      needLogin: !!f.need_login || !!QUALITIES[q]?.login,
    }));
  }
  // 补上接口返回但 support_formats 里没有的
  //
  // 注意：这里**必须排序**。若 support_formats 为空（部分 pgc/pugv 响应会缺），
  // 整个列表就只剩这一轮的结果，而 `accept` 是 Set、迭代顺序 = 原始 accept_quality
  // 顺序。虽然实测 4 个视频的 accept_quality 都是降序，但这不是接口契约 ——
  // 一旦顺序变了，render() 里 `options.find(o => o.available)` 就会取到**非最高档**，
  // 表现正是"自动却下到低画质"。
  const extra = [...accept].filter((q) => !list.some((x) => x.quality === q)).sort((a, b) => b - a);
  for (const q of extra) list.push(makeOption(q));

  // 最终按清晰度降序，保证：① 展示顺序稳定 ② `options.find(o => o.available)`
  // 取到的就是**最高可用档**（"自动"语义的落点）
  return list.sort((a, b) => b.quality - a.quality);
}

/**
 * 按当前下载方式同步弹窗 UI：模式说明文案 + 清晰度区视觉弱化。
 *
 * 文案取自 settings.js 的 MODE_HINTS（**单一来源**）—— 此前这段文案在本文件里
 * 抄了两份（render() 与 radio 的 change 事件），改一处忘另一处必然漂移。
 */
function syncModeUi(mode) {
  $('modeHint').textContent = MODE_HINTS[mode] || '';
  // 仅音频模式与清晰度无关，弱化清晰度区提醒用户它不参与本次下载。
  // ⚠️ 只降透明度，**不能 disabled** —— 清晰度仍参与文件名模板 {qualityShort}，
  //    禁用会让该变量丢失，文件名与用户预期不符。
  $('qualitySection').classList.toggle('is-muted', mode === 'audio');
}

/**
 * 渲染清晰度列表（含选中档位的决定与兜底）—— render() 与「切换下载方式」共用。
 *
 * ★ 为什么必须能单独调用：每档的「预计 X MB」口径**随下载方式变化**
 *   （仅音频只算音轨，见 settings.js 的 estimateSizeBytes）。切换下载方式后若不重跑
 *   本函数，列表里的体积会停留在切换前的口径（merge 含视频），比实际产物大一个数量级，
 *   用户会以为要下整个视频。
 *
 * ⚠️ 本函数**不重置** selectedQuality：切换模式时用户已选的档位必须保留
 *   （仅音频下清晰度不参与下载，但仍参与文件名模板 {qualityShort}）。
 *   只有选中档位确实不可用时才回落到最高可用档。
 */
function renderQualityList() {
  const options = buildQualityOptions();
  const highestAvailable = options.find((o) => o.available)?.quality || 0;
  if (!selectedQuality) {
    // 用户还没在本弹窗里点过 → 按设置页的「默认清晰度」决定初值。
    //
    // ★ 旧实现直接取 `options.find(o => o.available)`（= 最高可用档），
    //   完全**无视** settings.defaultQuality —— 用户在设置页选了 720P，
    //   弹窗照样按 1080P 下。现在设置真正生效：
    //   设了具体档且该档可用 → 用它；否则（含"自动"=0）→ 最高可用档。
    const pref = Number(settings.defaultQuality) || 0;
    const prefOpt = pref > 0 ? options.find((o) => o.quality === pref && o.available) : null;
    selectedQuality = prefOpt?.quality || highestAvailable || options[0]?.quality || 0;
  }
  // 兜底：选中的档位在本次响应里不可用（换视频 / 该档未解锁）→ 回落到最高可用档。
  if (!options.some((o) => o.quality === selectedQuality && o.available)) {
    selectedQuality = highestAvailable || options[0]?.quality || 0;
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
}

function render() {
  const info = videoInfo;
  $('cover').src = info.pic || '';
  $('title').textContent = info.title || '';
  const owner = info.owner?.name ? `UP：${info.owner.name}` : '';
  const dur = formatDuration(info.pages?.[currentSpec.pageIndex]?.duration || info.duration || 0);
  $('subTitle').textContent = [owner, `${info.pages?.length || 1} 个分P`, dur].filter(Boolean).join(' · ');
  $('stats').textContent = `${info.bvid || ''}${info.aid ? ` · av${info.aid}` : ''}`;

  // 清晰度（体积口径随下载方式变化，渲染逻辑见 renderQualityList）
  renderQualityList();

  // 下载方式
  const mode = settings.downloadMode;
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === mode;
  });
  syncModeUi(mode);

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

  // 所属合集
  const seasonSection = $('seasonSection');
  const seasonCb = $('optWholeSeason');
  if (ugcSeason) {
    seasonSection.hidden = false;
    $('seasonLabel').textContent = `下载整个合集（${ugcSeason.episodes.length} 集）`;
    $('seasonHint').textContent = `《${ugcSeason.title}》—— 勾选后按合集逐集建任务`;
    seasonCb.onchange = () => updateSummary();
  } else {
    seasonSection.hidden = true;
    seasonCb.checked = false;
    seasonCb.onchange = null;
  }

  // 附加内容
  $('optDanmaku').checked = !!settings.saveDanmaku;
  $('optSubtitle').checked = !!settings.saveSubtitle;
  $('optCover').checked = !!settings.saveCover;

  updateSummary();
}

function collectSpecs() {
  const info = videoInfo;

  // 合集批量：勾选后忽略分P选择，把合集每一集展开成一个任务
  if (ugcSeason && $('optWholeSeason')?.checked) {
    const qOpt = buildQualityOptions().find((o) => o.quality === selectedQuality);
    const total = ugcSeason.episodes.length;
    return seasonToSpecs(ugcSeason).map((s) => {
      const vars = {
        title: ugcSeason.title || info?.title || '',
        part: s.title || '',
        n: formatNumber(s.index + 1, total),
        p: s.index + 1,
        bvid: s.bvid || '',
        aid: s.aid || '',
        cid: s.cid || '',
        user: info?.owner?.name || '',
        userID: info?.owner?.mid || '',
        duration: s.duration || 0,
        ...dateVars(info?.pubdate || Math.floor(Date.now() / 1000)),
        qualityShort: qOpt?.short || '',
      };
      let filename = applyTemplate(settings.batchNameTemplate, vars);
      if (settings.nameWithQuality && qOpt?.short) {
        filename += applyTemplate(settings.qualitySuffix, vars);
      }
      return {
        bvid: s.bvid,
        aid: s.aid,
        cid: s.cid,
        pageIndex: 0,
        totalPages: 1,
        isBatch: true,
        quality: selectedQuality,
        qualityShort: qOpt?.short || '',
        title: s.title || ugcSeason.title || '',
        filename: sanitizeFilename(filename),
        cover: s.cover || info?.pic || '',
        info: {
          title: s.title || ugcSeason.title,
          bvid: s.bvid,
          aid: s.aid,
          pubdate: info?.pubdate || 0,
          owner: info?.owner,
          duration: s.duration || 0,
          pages: [{ page: 1, part: s.title, cid: s.cid, duration: s.duration || 0 }],
        },
        page: null,
        sourceUrl: `https://www.bilibili.com/video/${s.bvid || `av${s.aid}`}`,
      };
    });
  }

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
      duration: page?.duration || info.duration || '',
      // v1.4.27 审查（产品官 P1-2）：弹窗此前自建 vars 漏了日期组，
      // 模板 {year}/{month}/{day} 在弹窗路径下恒为空串。dateVars 与
      // 设置页 buildVars 同源（util.dateVars），单一真源。
      ...dateVars(info.pubdate || Math.floor(Date.now() / 1000)),
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
      // ★ 本次下载的「下载方式」随任务走，而不是去改全局设置。
      //
      // 旧实现在点「开始下载」时把 downloadMode 一起 saveSettings 写回全局，
      // 于是用户为**一次**需求选了「仅音频」，之后所有下载都静默变成仅音频、
      // 设置页也被改掉 —— 用户会以为设置自己跑了。
      // （这段上方关于 defaultQuality 的注释说的正是同一件事，那次只修了清晰度，
      //   downloadMode 是漏网的同类问题。）
      downloadMode: currentMode(),
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

/** 弹窗里当前选中的下载方式（本次生效用）。 */
function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || settings.downloadMode;
}

/**
 * 选了「仅音频」但这个视频**没有独立音轨**。
 *
 * 典型是老视频 / 单文件直下（durl）资源：只有一条含音视频的整轨，拿不出纯音频。
 * ⚠️ 此时 engine 的 buildPlan 会**直接抛错**（`if (!audio) throw`），任务转 error、
 *    没有任何产物 —— 并不会退回去下完整视频。所以这里只能提示用户自己改模式，
 *    绝不能承诺「将下载完整视频」（详见 settings.js 的 AUDIO_UNAVAILABLE_HINT）。
 */
function audioUnavailable() {
  return currentMode() === 'audio' && !(playInfo?.audios?.length);
}

function updateSummary() {
  const specs = collectSpecs();
  const qualityOpt = buildQualityOptions().find((o) => o.quality === selectedQuality);
  const totalSize = (qualityOpt?.size || 0) * specs.length;
  $('summary').innerHTML = `
    共 <b>${specs.length}</b> 个任务 · 清晰度 <b>${escapeHtml(qualityOpt?.label || '—')}</b>
    · 预计 <b>${formatBytes(totalSize)}</b>
    ${currentMode() === 'durl' ? '<br><span class="bd-hint">单文件直下模式的实际清晰度以接口返回为准</span>' : ''}
    ${currentMode() === 'audio' ? '<br><span class="bd-hint">仅音频模式只下载音轨，与上方清晰度无关</span>' : ''}
    ${audioUnavailable()
      ? `<br><span class="bd-hint">${escapeHtml(AUDIO_UNAVAILABLE_HINT)}</span>`
      : ''}`;
  $('btnStart').disabled = specs.length === 0;
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

async function startDownload() {
  const specs = collectSpecs();
  if (!specs.length) return;
  // 注意：**不要**在这里写 defaultQuality，也**不要**写 downloadMode。
  //
  // 旧实现写了 `defaultQuality: 0`，等于每次点「开始下载」都把用户在设置页
  // 选的默认清晰度**静默重置成"自动"**。用户改了设置、下次打开设置页又变回自动，
  // 会以为设置没保存。本次下载的清晰度已经通过 specs[].quality 显式传递，
  // 不需要也不应该回头改全局默认值。
  //
  // downloadMode 是**同一个坑**：为一次需求选了「仅音频」，会从此把所有下载
  // 都变成仅音频、连设置页也被改掉。现在它改由 specs[].downloadMode 随任务传递。
  await saveSettings({
    saveDanmaku: $('optDanmaku').checked,
    saveSubtitle: $('optSubtitle').checked,
    saveCover: $('optCover').checked,
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
      syncModeUi(r.value);
      // ★ 每档的「预计 X MB」口径随下载方式变化（仅音频只算音轨），必须重算，
      //   否则列表里的体积停留在切换前的 merge 口径、比实际产物大一个数量级。
      //   重渲染不会重置 selectedQuality（仅音频下清晰度仍参与文件名 {qualityShort}）。
      renderQualityList();
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
