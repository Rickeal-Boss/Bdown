/**
 * 下载流水线引擎。
 *
 * 一个任务的完整生命周期：
 *
 *   pending → resolving → downloading → (muxing) → saving → done
 *                ↓            ↓            ↓          ↓
 *              error       canceled     error      error
 *
 * 关键设计
 *  - 中间产物统一放在 OPFS（Origin Private File System），避免大文件把内存撑爆；
 *  - 若用户通过 File System Access API 选定了保存位置，则直接把结果写进目标文件，
 *    跳过「先落 OPFS 再导出」的一步；
 *  - 下载与混流都是流式的，内存占用与文件大小基本无关。
 */

import { BiliApi, pickVideoTrack, pickAudioTrack } from './api.js';
import { downloadRanged, downloadSequential, probeSize, DownloadAborted } from './downloader.js';
import { MemorySink, FileHandleSink, OpfsWorkspace, shouldUseMemory } from './sink.js';
import { blobSource, memorySource, mergeDashStream } from './mp4.js';
import { parseDanmakuXml, danmakuToAss, danmakuToSrt, danmakuToText, filterDanmaku } from './danmaku.js';
import { parseSubtitleJson, subtitleToSrt, subtitleToAss, subtitleToText, pickSubtitle } from './subtitle.js';
import { buildFilename, buildVars } from './settings.js';
import { qualityShort } from './quality.js';
import { sanitizeFilename, log, warn } from './util.js';

/** @typedef {'pending'|'resolving'|'downloading'|'muxing'|'saving'|'done'|'error'|'canceled'} TaskStatus */

let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export class Task {
  constructor(spec, meta = {}) {
    this.id = spec.id || nextId();
    this.spec = spec;
    /** @type {TaskStatus} */
    this.status = 'pending';
    this.title = meta.title || spec.title || '';
    this.subtitle = meta.subtitle || '';
    this.filename = meta.filename || spec.filename || '';
    this.quality = 0;
    this.codec = '';
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.speed = 0;
    this.eta = Infinity;
    this.phaseText = '';
    this.progress = 0;
    this.error = '';
    this.createdAt = Date.now();
    this.finishedAt = 0;
    this.outputs = [];
    this.controller = new AbortController();
  }

  get canceled() {
    return this.controller.signal.aborted;
  }

  cancel() {
    this.controller.abort();
  }

  toRecord() {
    return {
      id: this.id,
      status: this.status,
      title: this.title,
      subtitle: this.subtitle,
      filename: this.filename,
      quality: this.quality,
      codec: this.codec,
      totalBytes: this.totalBytes,
      progress: this.progress,
      error: this.error,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      spec: this.spec,
    };
  }
}

/**
 * @typedef {object} Destination
 * @property {'file'|'dir'|'downloads'} kind
 * @property {FileSystemFileHandle} [handle]
 * @property {FileSystemDirectoryHandle} [dir]
 */

export class DownloadEngine {
  /**
   * @param {{ api?: BiliApi, settings: object, onUpdate?: (task: Task) => void }} o
   */
  constructor({ api, settings, onUpdate = () => {} }) {
    this.api = api || new BiliApi();
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.workspace = new OpfsWorkspace('bdown-tmp');
    /** @type {Task[]} */
    this.tasks = [];
    /** @type {Set<string>} */
    this.running = new Set();
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  addTask(spec, meta) {
    const task = new Task(spec, meta);
    this.tasks.push(task);
    this.emit(task);
    return task;
  }

  emit(task) {
    this.onUpdate(task);
  }

  find(id) {
    return this.tasks.find((t) => t.id === id);
  }

  /**
   * 执行任务。
   * @param {Task} task
   * @param {Destination} destination
   */
  async run(task, destination) {
    const { settings, api } = this;
    const signal = task.controller.signal;
    const setStatus = (status, phaseText = '') => {
      task.status = status;
      if (phaseText) task.phaseText = phaseText;
      this.emit(task);
    };
    /** 记录需要清理的中间文件 */
    const tempNames = [];

    try {
      if (task.canceled) throw new DownloadAborted();

      /* ---------------- 0. 补齐任务规格 ---------------- */
      // content script 的悬浮按钮 / 播放器按钮只做 URL 解析，给出的 spec 是
      // `{ bvid, pageIndex }`，**没有 cid**。而 /x/player/wbi/playurl 缺 cid
      // 时返回 code=-400「请求错误」（实测：有 bvid 无 cid → -400；cid 为空
      // 或 "undefined" 同样 -400）。所以运行前必须先用 view 接口把 cid 补上。
      const spec = task.spec;
      await ensureSpecComplete(spec, api, () => task.canceled);
      if (!task.title || task.title === spec.bvid) {
        task.title = spec.title || spec.info?.title || spec.bvid || '视频任务';
        this.emit(task);
      }

      /* ---------------- 1. 解析播放地址 ---------------- */
      setStatus('resolving', '解析播放地址…');
      const playInfo = await api.playurl({
        bvid: spec.bvid,
        aid: spec.aid,
        cid: spec.cid,
        epId: spec.epId,
        qn: spec.quality || settings.defaultQuality || 127,
        mode: settings.downloadMode === 'durl' ? 'durl' : 'dash',
      });
      if (task.canceled) throw new DownloadAborted();

      const plan = buildPlan(playInfo, settings, spec);
      task.quality = plan.quality;
      task.codec = plan.codec;
      task.totalBytes = plan.totalBytes;
      if (!task.filename) {
        task.filename = resolveFilename({ spec, settings, plan });
      }
      this.emit(task);

      // playurl 不返回 DASH 轨的真实大小（只有按码率估算的值），
      // 这里补一次轻量探测，让进度与预计体积准确。
      setStatus('resolving', '探测文件大小…');
      await refinePlanSizes(plan, signal, settings);
      task.totalBytes = plan.totalBytes;
      this.emit(task);

      log('任务计划', {
        id: task.id,
        mode: plan.mode,
        quality: plan.quality,
        codec: plan.codec,
        totalBytes: plan.totalBytes,
        merge: settings.downloadMode,
      });

      const separate = plan.mode === 'dash' && settings.downloadMode === 'separate';
      const audioOnly = plan.mode === 'dash' && settings.downloadMode === 'audio';

      /* ---------------- 2. 下载 ---------------- */
      setStatus('downloading', '下载中…');

      const refreshProgress = () => {
        task.downloadedBytes = staging.video?.size || 0;
        if (staging.audio) task.downloadedBytes += staging.audio.size || 0;
        task.progress = task.totalBytes ? Math.min(0.98, task.downloadedBytes / task.totalBytes) : 0;
        this.emit(task);
      };

      /** @type {{ video?: MemorySink|FileHandleSink, audio?: MemorySink|FileHandleSink }} */
      const staging = {};

      if (plan.mode === 'durl') {
        const item = plan.durl[0];
        task.totalBytes = item.size || 0;
        const out = await this.createOutput({
          task,
          destination,
          name: `${task.filename}.mp4`,
          singleOutput: true,
          sizeHint: item.size || 0,
          tempNames,
        });
        staging.video = out.sink;
        await this.fetchTo({
          urls: [item.url, ...item.backupUrls],
          size: item.size,
          sink: out.sink,
          signal,
          onProgress: (p) => {
            task.speed = p.speed;
            task.eta = p.eta;
            refreshProgress();
          },
        });
        await this.finishOutput(out, task, destination, `${task.filename}.mp4`, 'video/mp4');
      } else if (audioOnly) {
        // 仅音频：单路下载，音轨原样落盘为 .m4a
        const out = await this.createOutput({
          task,
          destination,
          name: `${task.filename}.m4a`,
          singleOutput: true,
          sizeHint: plan.audio.size,
          tempNames,
        });
        staging.audio = out.sink;
        await this.fetchTo({
          urls: [plan.audio.url, ...plan.audio.backupUrls],
          size: plan.audio.size,
          sink: out.sink,
          signal,
          onProgress: (p) => {
            task.speed = p.speed;
            task.eta = p.eta;
            refreshProgress();
          },
        });
        if (task.canceled) throw new DownloadAborted();

        setStatus('saving', '保存音频文件…');
        await this.finishOutput(out, task, destination, `${task.filename}.m4a`, 'audio/mp4');
      } else if (separate) {
        // 音视频分离输出：两路各自落盘
        const vOut = await this.createOutput({
          task,
          destination,
          name: `${task.filename}.video.mp4`,
          singleOutput: false,
          sizeHint: plan.video.size,
          tempNames,
        });
        staging.video = vOut.sink;
        await this.fetchTo({
          urls: [plan.video.url, ...plan.video.backupUrls],
          size: plan.video.size,
          sink: vOut.sink,
          signal,
          onProgress: (p) => {
            task.speed = p.speed;
            task.eta = p.eta;
            refreshProgress();
          },
        });
        if (task.canceled) throw new DownloadAborted();

        const aOut = await this.createOutput({
          task,
          destination,
          name: `${task.filename}.audio.m4a`,
          singleOutput: false,
          sizeHint: plan.audio.size,
          tempNames,
        });
        staging.audio = aOut.sink;
        await this.fetchTo({
          urls: [plan.audio.url, ...plan.audio.backupUrls],
          size: plan.audio.size,
          sink: aOut.sink,
          signal,
          onProgress: (p) => {
            task.speed = p.speed;
            task.eta = p.eta;
            refreshProgress();
          },
        });
        if (task.canceled) throw new DownloadAborted();

        setStatus('saving', '保存音视频文件…');
        await this.finishOutput(vOut, task, destination, `${task.filename}.video.mp4`, 'video/mp4');
        await this.finishOutput(aOut, task, destination, `${task.filename}.audio.m4a`, 'audio/mp4');
      } else {
        // DASH 合并模式：两条轨道先落到临时目标，再混流到最终输出
        const vStage = await this.createTemp(task, plan.video.size, tempNames);
        staging.video = vStage;
        await this.fetchTo({
          urls: [plan.video.url, ...plan.video.backupUrls],
          size: plan.video.size,
          sink: vStage,
          signal,
          onProgress: (p) => {
            task.speed = p.speed;
            task.eta = p.eta;
            refreshProgress();
          },
        });
        if (task.canceled) throw new DownloadAborted();

        const aStage = await this.createTemp(task, plan.audio.size, tempNames);
        staging.audio = aStage;
        await this.fetchTo({
          urls: [plan.audio.url, ...plan.audio.backupUrls],
          size: plan.audio.size,
          sink: aStage,
          signal,
          onProgress: (p) => {
            task.speed = p.speed;
            task.eta = p.eta;
            refreshProgress();
          },
        });
        if (task.canceled) throw new DownloadAborted();

        setStatus('muxing', '无损合并音视频…');
        const out = await this.createOutput({
          task,
          destination,
          name: `${task.filename}.mp4`,
          singleOutput: true,
          sizeHint: plan.totalBytes,
          tempNames,
        });
        await this.mergeInto({
          task,
          vSink: vStage,
          aSink: aStage,
          out,
          destination,
          filename: `${task.filename}.mp4`,
        });
      }

      if (task.canceled) throw new DownloadAborted();

      /* ---------------- 4. 附加内容 ---------------- */
      setStatus('saving', '保存弹幕/字幕…');
      await this.fetchExtras(task, destination, plan, tempNames);

      task.progress = 1;
      task.finishedAt = Date.now();
      setStatus('done', '已完成');
    } catch (err) {
      if (err instanceof DownloadAborted || task.canceled) {
        task.finishedAt = Date.now();
        setStatus('canceled', '已取消');
      } else {
        task.error = err?.message || String(err);
        task.finishedAt = Date.now();
        warn('任务失败', task.id, err);
        setStatus('error', task.error);
      }
    } finally {
      this.running.delete(task.id);
      await this.cleanupTemps(tempNames);
    }
  }

  /**
   * 决定这一路输出的落盘方式。
   *
   * 优先级：
   *   1. 目标目录句柄（批量下载时用户选的文件夹）→ 直接写入
   *   2. 目标文件句柄（单任务时用户选的保存文件）且只有一个输出 → 直接写入
   *   3. 小文件 → 内存
   *   4. 其余 → OPFS 临时文件，稍后导出
   */
  async createOutput({ task, destination, name, singleOutput, sizeHint, tempNames }) {
    if (destination.kind === 'dir' && destination.dir) {
      const handle = await destination.dir.getFileHandle(sanitizeFilename(name), { create: true });
      const sink = await new FileHandleSink(handle).open();
      return { sink, direct: true, handle };
    }
    if (destination.kind === 'file' && destination.handle && singleOutput) {
      const sink = await new FileHandleSink(destination.handle).open();
      return { sink, direct: true, handle: destination.handle };
    }
    if (shouldUseMemory(sizeHint)) {
      return { sink: new MemorySink(), direct: false };
    }
    const tempName = `${task.id}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    tempNames.push(tempName);
    const sink = await this.workspace.create(tempName);
    return { sink, direct: false, tempName };
  }

  /** 收尾一路输出：直接写入的只统计，非直接的导出。 */
  async finishOutput(out, task, destination, filename, mime) {
    if (out.direct) {
      await out.sink.close();
      task.outputs.push({ path: filename, bytes: out.sink.size });
      this.emit(task);
      return;
    }
    const result = await this.persist(out.sink, destination, filename, mime);
    task.outputs.push(result);
    this.emit(task);
  }

  /** 创建临时中间目标（不直接落用户目录）。 */
  async createTemp(task, sizeHint, tempNames) {
    if (shouldUseMemory(sizeHint)) return new MemorySink();
    const tempName = `${task.id}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    tempNames.push(tempName);
    return this.workspace.create(tempName);
  }

  /** 把两路 DASH 流合并成一路并落盘。 */
  async mergeInto({ task, vSink, aSink, out, destination, filename }) {
    const vSource = vSink instanceof MemorySink
      ? memorySource(new Uint8Array(await vSink.blob().arrayBuffer()))
      : blobSource(await vSink.file());
    const aSource = aSink instanceof MemorySink
      ? memorySource(new Uint8Array(await aSink.blob().arrayBuffer()))
      : blobSource(await aSink.file());

    const writeSink = out.sink;
    if (writeSink instanceof FileHandleSink) writeSink.size = 0;

    const result = await mergeDashStream({
      videoSource: vSource,
      audioSource: aSource,
      write: (chunk) => writeSink.write(chunk),
      onProgress: ({ ratio }) => {
        task.progress = 0.98 + ratio * 0.015;
        task.phaseText = `无损合并音视频… ${(ratio * 100).toFixed(0)}%`;
        this.emit(task);
      },
    });
    await this.finishOutput(out, task, destination, filename, 'video/mp4');
    return result;
  }

  /** 统一的分片下载入口，必要时回退到顺序下载。 */
  async fetchTo({ urls, size, sink, onProgress, signal, probe = true }) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) throw new Error('没有可用的下载地址');
    let total = size;
    if (!total && !probe) {
      const p = await probeSize(list[0], { signal });
      total = p.size;
    }
    const concurrency = Math.max(1, Math.min(16, this.settings.concurrency || 8));
    try {
      return await downloadRanged({ urls: list, size: total, sink, concurrency, signal, onProgress, probe });
    } catch (err) {
      if (err instanceof DownloadAborted) throw err;
      warn('分片下载失败，回退到顺序下载', err.message);
      if (sink instanceof MemorySink) sink.records = [];
      if (sink instanceof FileHandleSink) sink.size = 0;
      return downloadSequential({ urls: list, sink, signal, onProgress });
    }
  }

  /** 把中间产物落到最终位置。 */
  async persist(sink, destination, filename, mime) {
    const safeName = sanitizeFilename(filename);
    if (sink instanceof FileHandleSink) {
      await sink.close();
      const file = await sink.file();
      return this.exportFile(file, safeName, mime, destination);
    }
    await sink.close();
    return this.exportFile(sink.blob(mime), safeName, mime, destination);
  }

  /** 导出 Blob/File：有目录句柄就写进去，否则交给 chrome.downloads。 */
  async exportFile(blobOrFile, filename, mime, destination) {
    if (destination.kind === 'dir' && destination.dir) {
      const handle = await destination.dir.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      await streamInto(writable, blobOrFile);
      await writable.close();
      return { path: filename, bytes: blobOrFile.size };
    }

    const blob = blobOrFile instanceof Blob && blobOrFile.type === mime
      ? blobOrFile
      : new Blob([blobOrFile], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      setTimeout(() => URL.revokeObjectURL(url), 180_000);
      return { path: filename, downloadId, bytes: blob.size };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw new Error(`保存文件失败：${err.message}`);
    }
  }

  /** 抓取封面 / 弹幕 / 字幕。 */
  async fetchExtras(task, destination, plan, tempNames) {
    const { settings, api } = this;
    const spec = task.spec;

    const put = async (filename, content, mime = 'text/plain') => {
      const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
      try {
        const res = await this.exportFile(blob, sanitizeFilename(filename), mime, destination);
        task.outputs.push(res);
        this.emit(task);
      } catch (err) {
        warn('附加内容保存失败', filename, err);
      }
    };

    if (settings.saveDanmaku) {
      try {
        const xml = await api.danmakuXml(spec.cid);
        const { list } = parseDanmakuXml(xml);
        const filtered = filterDanmaku(list, { maxLength: 100, dedupe: true });
        const format = settings.danmakuFormat || 'ass';
        if (format === 'xml') {
          await put(`${task.filename}.xml`, xml, 'application/xml');
        } else if (format === 'srt') {
          await put(`${task.filename}.danmaku.srt`, danmakuToSrt(filtered), 'application/x-subrip');
        } else if (format === 'txt') {
          await put(`${task.filename}.danmaku.txt`, danmakuToText(filtered));
        } else {
          const ass = danmakuToAss(filtered, {
            width: settings.danmakuWidth,
            height: settings.danmakuHeight,
            opacity: settings.danmakuOpacity,
            fontScale: settings.danmakuFontScale,
            fontName: settings.danmakuFontName,
            title: task.title,
          });
          await put(`${task.filename}.danmaku.ass`, ass);
        }
        log('弹幕已保存', `${list.length} -> ${filtered.length}`);
      } catch (err) {
        warn('弹幕获取失败', err);
      }
    }

    if (settings.saveSubtitle) {
      try {
        const info = await api.playerV2({ bvid: spec.bvid, aid: spec.aid, cid: spec.cid });
        const subs = info?.subtitle?.subtitles || [];
        const target = pickSubtitle(subs, settings.subtitleLan);
        if (target?.subtitle_url) {
          const url = target.subtitle_url.startsWith('//') ? `https:${target.subtitle_url}` : target.subtitle_url;
          const res = await fetch(url, { credentials: 'include' });
          const json = await res.json();
          const parsed = parseSubtitleJson(json, { lan: target.lan, lanDoc: target.lan_doc });
          const format = settings.subtitleFormat || 'srt';
          if (format === 'ass') {
            await put(
              `${task.filename}.${target.lan}.ass`,
              subtitleToAss(parsed, {
                title: task.title,
                width: settings.danmakuWidth,
                height: settings.danmakuHeight,
              })
            );
          } else if (format === 'txt') {
            await put(`${task.filename}.${target.lan}.txt`, subtitleToText(parsed));
          } else {
            await put(`${task.filename}.${target.lan}.srt`, subtitleToSrt(parsed), 'application/x-subrip');
          }
          log('字幕已保存', target.lan, parsed.items.length);
        }
      } catch (err) {
        warn('字幕获取失败', err);
      }
    }

    if (settings.saveCover && spec.cover) {
      try {
        const res = await fetch(spec.cover, { credentials: 'omit' });
        if (res.ok) {
          const blob = await res.blob();
          await put(`${task.filename}.cover.jpg`, blob, blob.type || 'image/jpeg');
        }
      } catch (err) {
        warn('封面获取失败', err);
      }
    }

    void plan;
    void tempNames;
  }

  async cleanupTemps(names) {
    for (const n of names) await this.workspace.remove(n);
  }

  async cleanupAll() {
    await this.workspace.clear();
  }
}

/** 把 Blob/File 流式写进 WritableStream（避免一次性读进内存）。 */
async function streamInto(writable, blob) {
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await writable.write(value);
  }
}


/**
 * 补齐任务规格里缺失的 cid / 标题 / 分P 信息。
 *
 * 必要性（实测证据）：
 *   bvid + cid=39386548303 → code:0
 *   bvid + cid=1（不匹配） → code:-404「啥都木有」
 *   bvid + 完全无 cid      → code:-400「请求错误」
 *   bvid + cid="undefined" → code:-400「请求错误」
 *
 * content script 的悬浮按钮 / 播放器按钮只解析 URL，给出的 spec 没有 cid，
 * 直接拿去调 playurl 就一定 -400。这里统一用 /x/web-interface/view 补上。
 *
 * @param {object} spec 任务规格（原地补全）
 * @param {import('./api.js').BiliApi} api
 * @param {() => boolean} [isCanceled]
 */
export async function ensureSpecComplete(spec, api, isCanceled = () => false) {
  if (spec.cid) return spec;
  if (!spec.bvid && !spec.aid) return spec;
  if (isCanceled()) return spec;

  let info = null;
  try {
    info = await api.videoInfo({ bvid: spec.bvid, aid: spec.aid });
  } catch (err) {
    warn('补全任务规格失败（拿不到 cid）', err?.message);
    return spec;
  }
  if (!info || isCanceled()) return spec;

  const pages = info.pages || [];
  const page = pages[spec.pageIndex || 0] || pages[0];
  const cid = page?.cid || info.cid;
  if (cid) spec.cid = cid;
  if (!spec.title && info.title) spec.title = info.title;
  if (!spec.cover && info.pic) spec.cover = info.pic;
  if (!spec.totalPages) spec.totalPages = pages.length;
  if (!spec.info) {
    spec.info = {
      title: info.title,
      bvid: info.bvid,
      aid: info.aid,
      pubdate: info.pubdate,
      owner: info.owner,
      duration: info.duration,
      pages,
    };
  }
  return spec;
}

/**
 * 根据 playurl 结果 + 设置，决定「下什么、下多大」。
 */
export function buildPlan(playInfo, settings, spec) {
  if (playInfo.mode === 'durl' && playInfo.durl.length) {
    const item = playInfo.durl[0];
    return {
      mode: 'durl',
      quality: playInfo.quality,
      codec: 'H.264',
      video: null,
      audio: null,
      durl: playInfo.durl,
      totalBytes: item.size || 0,
    };
  }

  const accept = playInfo.acceptQuality || [];
  let quality = spec.quality || settings.defaultQuality || 0;
  if (!quality) quality = accept[0] || playInfo.videos[0]?.quality;
  if (quality && accept.length && !accept.includes(quality)) {
    const lower = accept.filter((q) => q <= quality).sort((a, b) => b - a)[0];
    quality = lower || accept[accept.length - 1];
  }

  // 「仅音频」模式：不下视频轨，直接把音轨原样落盘（B 站的音轨本身就是
  // fragmented MP4，改个扩展名为 .m4a 即可直接播放，无需重封装或转码）。
  const audioOnly = settings.downloadMode === 'audio';

  const video = pickVideoTrack(playInfo.videos, quality, settings.preferCodec);
  const audio = pickAudioTrack(playInfo.audios, { preferLossless: settings.audioPreference !== 'normal' });
  if (!audioOnly && !video) throw new Error('该视频没有可用的视频轨');
  if (!audio) throw new Error('该视频没有可用的音频轨');

  return {
    mode: 'dash',
    quality: audioOnly ? 0 : (video?.quality || quality),
    codec: audioOnly ? '—' : (video?.codec || ''),
    video: audioOnly ? null : video,
    audio,
    audioOnly,
    durl: [],
    totalBytes: ((audioOnly ? 0 : video?.size) || 0) + (audio.size || 0),
  };
}

/**
 * 用一次轻量探测（`Range: bytes=0-0`）拿到真实文件大小。
 *
 * 必要性：B 站的 `playurl` 响应里 DASH 轨**没有 `size` 字段**，只能按
 * `bandwidth × duration / 8` 估算，误差可达数个百分点。估算偏大会让最后一个分片越界，
 * 估算偏小则进度条永远到不了 100%。
 */
export async function refinePlanSizes(plan, signal, settings = {}) {
  const probe = async (track) => {
    if (!track?.url) return;
    try {
      const info = await probeSize(track.url, { signal });
      if (info.size > 0) track.size = info.size;
    } catch (err) {
      warn('文件大小探测失败，将使用估算值', track.url?.slice(0, 80), err?.message);
    }
  };

  if (plan.mode === 'durl') {
    await Promise.all(plan.durl.map((d) => probe(d)));
  } else if (plan.audioOnly || settings.downloadMode === 'audio') {
    await probe(plan.audio);
  } else {
    await Promise.all([probe(plan.video), probe(plan.audio)]);
  }

  plan.totalBytes = plan.mode === 'durl'
    ? plan.durl.reduce((n, d) => n + (d.size || 0), 0)
    : (plan.audioOnly ? 0 : plan.video?.size || 0) + (plan.audio?.size || 0);
  return plan;
}

/** 依据模板生成文件名。 */
export function resolveFilename({ spec, settings, plan }) {
  const info = spec.info || {};
  const vars = buildVars({
    info,
    page: spec.page,
    index: spec.pageIndex ?? 0,
    total: spec.totalPages || (info.pages || []).length,
  });
  return buildFilename({
    settings,
    vars,
    isBatch: (spec.totalPages || 1) > 1 || !!spec.isBatch,
    quality: plan?.quality,
    qualityShort: plan?.quality ? qualityShort(plan.quality) : '',
    codec: plan?.codec,
  });
}

export { qualityShort };
