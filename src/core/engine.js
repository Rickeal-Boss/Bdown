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
import { addRange, completedBytes } from './resume.js';
import { ResumeStore, resumeKey } from './resume-store.js';
import { parseDanmakuXml, danmakuToAss, danmakuToSrt, danmakuToText, filterDanmaku } from './danmaku.js';
import { parseSubtitleJson, subtitleToSrt, subtitleToAss, subtitleToText, pickSubtitle } from './subtitle.js';
import { parseViewPoints, chaptersToTxt, chaptersToVtt } from './chapters.js';
import { buildNfo, nfoFilename } from './nfo.js';
import { buildFilename, buildVars } from './settings.js';
import { qualityShort } from './quality.js';
import { sanitizeFilename, log, warn, sanitizeBiliUrl } from './util.js';

/**
 * @typedef {'pending'|'resolving'|'downloading'|'paused'|'muxing'|'saving'|'done'|'error'|'canceled'} TaskStatus
 *
 * `paused` 是 v1.4.23 新增的**可恢复终态**：中断了，但续传清单还在，可以原地「继续」。
 * 它与 `canceled` 的唯一区别就是清单有没有被清掉（见 discardResume）。
 */

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

    /**
     * 「暂停」意图标记。
     *
     * 为什么不在 pause() 里直接改 status：run() 的 await 链被 abort 打断后还要
     * 走 catch 分支收尾，那时才知道该落到 paused 还是 canceled。这里只记意图，
     * 由 run() 的 catch 去兑现（见 run 末尾）。
     */
    this.paused = false;

    /**
     * 本任务占用过的续传 key（视轨 / 音轨各一个）。
     *
     * 「取消」必须把它们连同 .part 一起删掉 —— 否则用户取消后再下同一个视频，
     * 只要 size 恰好一致就会续到一份**残缺的旧数据**上，产出静默损坏的文件。
     */
    this.resumeKeys = [];
  }

  get canceled() {
    return this.controller.signal.aborted;
  }

  /**
   * 暂停：中断下载但**保留续传清单**，任务停在 `paused`，可由「继续」原地恢复。
   *
   * 与 cancel() 的唯一区别就是事后清不清清单，所以两者只差一个标记位。
   */
  pause() {
    this.paused = true;
    this.controller.abort();
  }

  /**
   * 取消：中断下载并**丢弃**续传清单 —— 下次这个视频从头下。
   *
   * 注意必须先把 paused 置回 false：用户可能先暂停、再改主意点取消，
   * 若沿用上一次的 true，取消也会变成暂停（清单被留下）。
   */
  cancel() {
    this.paused = false;
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
      downloadedBytes: this.downloadedBytes,
      progress: this.progress,
      error: this.error,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      spec: this.spec,
      // ★ 续传 key 必须跟着走。
      //
      // `paused` 是**可恢复**状态：关掉下载中心再打开，任务要能接着「继续」。
      // 恢复出来的 Task 若不认得自己占用过哪些 .part，点「移除」时 discardResume
      // 就没东西可清 —— 那些 .part 会永久占着 OPFS，还可能被下一次同内容下载续上。
      resumeKeys: Array.isArray(this.resumeKeys) ? [...this.resumeKeys] : [],
    };
  }
}

/**
 * @typedef {object} Destination
 * @property {'file'|'dir'|'downloads'} kind
 * @property {FileSystemFileHandle} [handle]
 * @property {FileSystemDirectoryHandle} [dir]
 */

/**
 * 判断下载失败是否由「播放地址过期」引起。
 * B 站 CDN 地址约 120 分钟失效，失效后服务器返回 403（也可能 404）。
 */
export function isUrlExpiredError(err) {
  const st = Number(err?.status);
  if (!Number.isFinite(st)) return false;
  return st === 403 || st === 404 || st === 410;
}

/**
 * 关闭一个 sink，失败只告警不抛出。
 *
 * 对 MemorySink 是 no-op；对 FileHandleSink 是**必须的**——它会 flush 异步写入链
 * 并关闭 OPFS writable。不关就读回文件内容，会拿到未落盘的数据。
 */
async function closeSinkQuietly(sink, label = 'sink') {
  if (!sink || typeof sink.close !== 'function') return;
  try {
    await sink.close();
  } catch (err) {
    warn(`关闭${label}失败（继续尝试读取，可能是半截文件）`, err?.message);
  }
}

/**
 * 把 sink 恢复到「刚建好」的状态，便于从头重下。
 *
 * 注意 FileHandleSink **必须真的截断文件**：只把 `size` 归零而不截断，
 * 覆盖写不会缩短文件，新内容更短时尾部会残留上一轮的字节。
 */
async function resetSink(sink) {
  if (sink instanceof MemorySink) {
    sink.records = [];
    sink.size = 0;
  } else if (sink instanceof FileHandleSink) {
    await sink.truncate(0);
  }
}

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
   * 丢弃一个任务占用过的全部续传清单（连同 .part 分片文件）。
   *
   * 「取消」和「任务彻底成功」都要调它：
   *  - 取消：用户明确放弃，不该留下半份数据 —— 否则下次下同一个视频（size 恰好一致时）
   *    会续到残缺内容上，产出**静默损坏**的文件；
   *  - 成功：两轨的 .part 已被 mergeInto 消费，留着只是占 OPFS。
   *
   * 而「暂停」**绝不调它** —— 留下清单正是暂停能续传的唯一原因。
   */
  async discardResume(task) {
    const keys = Array.isArray(task?.resumeKeys) ? task.resumeKeys : [];
    if (!task) return;
    task.resumeKeys = [];
    if (!keys.length) return;
    try {
      const store = this.resumeStore || (this.resumeStore = new ResumeStore());
      for (const k of keys) {
        await store.clear(k).catch(() => {});
      }
    } catch (err) {
      warn('清理续传清单失败（不影响本次结果）', err?.message);
    }
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
        // 课程（pugv）的必需参数。缺了它 api.playurl 不会走 /pugv 分支，
        // 课程任务会以「缺少 cid」失败。
        cheeseId: spec.cheeseId,
        qn: spec.quality > 0 ? spec.quality : 0,
        mode: settings.downloadMode === 'durl' ? 'durl' : 'dash',
      });
      if (task.canceled) throw new DownloadAborted();

      const plan = buildPlan(playInfo, settings, spec);

      /**
       * 播放地址过期时重新拿一批。
       * B 站 CDN 地址约 120 分钟失效（表现为 403/404），这时必须重新 playurl，
       * 而不是拿同一个过期地址重试。
       * @param {'v'|'a'} side
       */
      /**
       * 用旧地址里的 query 补到新地址上。
       *
       * B 站的 m4s 地址形如 `...m4s?e=ig8euxZM2r...&deadline=...&trid=...`。
       * 实测**去掉 ? 后 4 个域名全部失败**（QA 独立复现），说明这些签参是必需的。
       * 而 playurl 返回的地址有时不带 query，所以刷新后要用旧地址的 query 兜底。
       */
      const withQuery = (url, fallbackUrl) => {
        if (!url) return '';
        if (String(url).includes('?')) return url;
        const i = String(fallbackUrl || '').indexOf('?');
        return i > 0 ? String(url) + String(fallbackUrl).slice(i) : url;
      };

      const refreshUrls = async (side) => {
        const fresh = await api.playurl({
          bvid: spec.bvid,
          aid: spec.aid,
          cid: spec.cid,
          epId: spec.epId,
          cheeseId: spec.cheeseId,
          qn: spec.quality > 0 ? spec.quality : 0,
          mode: settings.downloadMode === 'durl' ? 'durl' : 'dash',
        });
        const fp = buildPlan(fresh, settings, spec);
        // durl（单文件直下）没有 video/audio 轨，取 durl[0]
        if (side === 'd') {
          const item = (fp.durl || [])[0];
          if (!item) return [];
          const base = (plan.durl || [])[0];
          return [withQuery(item.url, base?.url)].filter(Boolean);
        }
        const track = side === 'a' ? fp.audio : fp.video;
        if (!track) return [];
        const base = side === 'a' ? plan.audio : plan.video;
        // 只回主源即可：backupUrls 在 buildPlan 里未必带签参，
        // 而这里的关键是「URL 过期 -> 换一批**完整可用**的地址」
        return [withQuery(track.url, base?.url)].filter(Boolean);
      };
      if (spec.info?.steinGate) {
        warn('这是一个互动视频：当前只下载主线（默认分支），分支剧情未包含');
      }
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

      // 清晰度诊断日志（用户报「怎么只有 360P」时，看这一行就能定位）：
      //   - isLogin / vip：扩展**自己探测到**的账号状态（来自 /x/web-interface/nav）
      //   - accept_quality：服务端"宣称"可给的档位
      //   - dashVideos：服务端**实际返回**的轨道 id 集合
      //   - picked：客户端最终选中的轨道
      //
      // 判读表（这一行就是为了让"到底哪一环出问题"不再靠猜）：
      //   isLogin=false            → 扩展没探测到登录态（Cookie 未送达 / 未登录）
      //   isLogin=true 但 dashVideos 最大只有 16/32
      //                            → 服务端没按登录态给高画质
      //                              （Cookie 虽在 nav 生效但 playurl 未带 / 内容本身受限）
      //   isLogin=true 且 dashVideos 含 80/112，但 picked 更低
      //                            → 客户端选轨 bug
      //   accept_quality 有 80 但 dashVideos 没有
      //                            → 账号权限不足或该内容限制
      log('清晰度诊断', {
        isLogin: api.account?.isLogin ?? null,
        vip: api.account?.vip ?? null,
        uname: api.account?.uname || '',
        accept_quality: playInfo.acceptQuality || [],
        dashVideos: (playInfo.videos || []).map((v) => `${v.quality}/${v.codec}`),
        dashAudios: (playInfo.audios || []).map((a) => a.id),
        picked: plan.video ? `${plan.video.quality}/${plan.video.codec}` : '(无视频轨)',
        specQuality: spec.quality,
        settingsDefaultQuality: settings.defaultQuality,
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
        // ★ 必须下载**全部分段**并依次拼接。
        // 原来只下 durl[0]：但 refinePlanSizes 探测了所有分段、buildPlan 也返回了
        // 完整的 durl 列表 —— 结果就是产出**只有第一段的截断文件**，而且进度永远
        // 到不了 100%（totalBytes 只按第一段算）。
        const segments = (plan.durl || []).filter((seg) => seg && seg.url);
        if (!segments.length) throw new Error('durl 模式下没有可下载的分段');
        const total = segments.reduce((sum, seg) => sum + (Number(seg.size) || 0), 0);
        task.totalBytes = total || task.totalBytes || 0;
        const out = await this.createOutput({
          task,
          destination,
          name: `${task.filename}.mp4`,
          singleOutput: true,
          sizeHint: total || 0,
          tempNames,
        });
        staging.video = out.sink;
        let written = 0;
        for (const seg of segments) {
          await this.fetchTo({
            urls: [seg.url, ...(seg.backupUrls || [])],
            refreshUrls: () => refreshUrls('d'),
            size: seg.size,
            sink: out.sink,
            // 关键：每段写到自己在整个文件里的位置，否则第二段会从 0 覆盖第一段
            writeOffset: written,
            signal,
            onProgress: (p) => {
              task.speed = p.speed;
              task.eta = p.eta;
              refreshProgress();
            },
          });
          written += Number(seg.size) || 0;
          if (task.canceled) throw new DownloadAborted();
          refreshProgress();
        }
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
          refreshUrls: () => refreshUrls('a'),
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
          refreshUrls: () => refreshUrls('v'),
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
          refreshUrls: () => refreshUrls('a'),
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
        const vPrep = await this.prepareStage({
          task, spec, plan, track: 'v', size: plan.video.size, tempNames,
        });
        staging.video = vPrep.sink;
        await this.fetchTo({
          urls: [plan.video.url, ...plan.video.backupUrls],
          refreshUrls: () => refreshUrls('v'),
          size: plan.video.size,
          sink: vPrep.sink,
          signal,
          resume: vPrep.resume,
          onProgress: (p) => {
            task.speed = p.speed;
            task.eta = p.eta;
            refreshProgress();
          },
        });
        if (task.canceled) throw new DownloadAborted();

        const aPrep = await this.prepareStage({
          task, spec, plan, track: 'a', size: plan.audio.size, tempNames,
        });
        staging.audio = aPrep.sink;
        await this.fetchTo({
          urls: [plan.audio.url, ...plan.audio.backupUrls],
          refreshUrls: () => refreshUrls('a'),
          size: plan.audio.size,
          sink: aPrep.sink,
          signal,
          resume: aPrep.resume,
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
          // 注意：这里是 vPrep.sink / aPrep.sink（prepareStage 的返回值）。
          // 曾经因为 prepareStage 重构（vStage→vPrep）时漏改这两行，
          // 导致默认 merge 模式在合并阶段抛 ReferenceError、100% 失败。
          vSink: vPrep.sink,
          aSink: aPrep.sink,
          out,
          destination,
          filename: `${task.filename}.mp4`,
        });
      }

      if (task.canceled) throw new DownloadAborted();

      /* ---------------- 4. 附加内容 ---------------- */
      setStatus('saving', '保存弹幕/字幕…');
      await this.fetchExtras(task, destination, plan, tempNames);

      // 任务彻底成功：两轨的 .part 已被消费掉，清单与分片文件都可以清了。
      // 不清的话这些 .part 会永久占着 OPFS（此前"旧 .part 无清理"就挂在遗留清单里）。
      await this.discardResume(task);

      task.progress = 1;
      task.finishedAt = Date.now();
      setStatus('done', '已完成');
    } catch (err) {
      if (err instanceof DownloadAborted || task.canceled) {
        task.finishedAt = Date.now();
        if (task.paused) {
          // 暂停：清单留着，UI 停在「已暂停」，等用户点「继续」。
          // 注意这里**不能**调 discardResume —— 那正是暂停与取消的分界线。
          setStatus('paused', '已暂停，可从断点继续');
        } else {
          await this.discardResume(task);
          setStatus('canceled', '已取消');
        }
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
  /**
   * 为一条轨道准备下载目标。
   *
   * 开启续传（settings.resumeEnabled）时用 ResumeStore 的持久分片，
   * 跨会话有效；否则用普通临时目标（内存 / OPFS 临时文件）。
   *
   * @param {'v'|'a'} track 视轨 / 音轨
   */
  async prepareStage({ task, spec, plan, track, size, tempNames }) {
    if (this.settings.resumeEnabled) {
      try {
        const store = this.resumeStore || (this.resumeStore = new ResumeStore());
        const key = resumeKey({
          bvid: spec.bvid,
          aid: spec.aid,
          cid: spec.cid,
          epId: spec.epId,
          quality: plan.quality,
          codec: plan.codec,
          track,
        });
        if (key) {
          // 记下 key，供「取消 / 成功」时清理（discardResume）。
          // 暂停时**不会**被清 —— 这正是能续传的原因。
          if (!Array.isArray(task.resumeKeys)) task.resumeKeys = [];
          if (!task.resumeKeys.includes(key)) task.resumeKeys.push(key);
          const opened = await store.openPartial(key, size);
          return { sink: opened.sink, resume: { store, key, ranges: opened.ranges }, resumed: opened.resumed };
        }
      } catch (err) {
        warn('续传目标打开失败，回退到临时文件', err?.message);
      }
    }
    return { sink: await this.createTemp(task, size, tempNames), resume: null, resumed: false };
  }

  async createTemp(task, sizeHint, tempNames) {
    if (shouldUseMemory(sizeHint)) return new MemorySink();
    const tempName = `${task.id}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    tempNames.push(tempName);
    return this.workspace.create(tempName);
  }

  /** 把两路 DASH 流合并成一路并落盘。 */
  async mergeInto({ task, vSink, aSink, out, destination, filename }) {
    // ★ 关键：读回输入 sink 之前**必须先关闭它**。
    //
    // 大文件（> 256MB，见 sink.js 的 MEMORY_LIMIT）走 OPFS 的 FileHandleSink：
    // 它的 writeAt() 只把写入排进异步 _chain，**只有 close() 才会 await _chain
    // 并关闭 writable**。不关闭就直接 handle.getFile()，拿到的可能是还没落盘的
    // 空文件/半截文件 —— 表现出来就是「不是有效的 MP4：未找到 moov 盒子」。
    //
    // 这个 bug 从 v1.0.0 起就存在，但 CI 一直测不出来：test-engine-e2e 用的是
    // 几 KB 的合成片段，走 MemorySink（数据在内存里，不关也能读到）。
    // 真实 1080P 长视频必然超过 256MB，于是真机必崩。
    await closeSinkQuietly(vSink, '视频轨');
    await closeSinkQuietly(aSink, '音频轨');

    const vSource = vSink instanceof MemorySink
      ? memorySource(new Uint8Array(await vSink.blob().arrayBuffer()))
      : blobSource(await vSink.file());
    const aSource = aSink instanceof MemorySink
      ? memorySource(new Uint8Array(await aSink.blob().arrayBuffer()))
      : blobSource(await aSink.file());

    // ★ 必须**真的截断**目标文件，不能只把 size 归零。
    //
    // createOutput 是用 `keepExistingData: true` 打开的目标文件，所以同名文件
    // 二次下载、或上次失败留下过字节时，只 `size = 0` 而**不截断**的话：
    // 新内容更短 → 尾部残留上一轮的字节 → 产物 = 新 moov + 旧 mdat 尾巴，
    // 文件长度对不上、MP4 结构损坏（能播但花屏/时长错，或直接打不开）。
    //
    // 这与 engine.js 顶部 resetSink() 用 truncate(0) 是同一类问题
    // —— 覆盖写不会缩短文件，必须显式截断。
    const writeSink = out.sink;
    if (writeSink instanceof FileHandleSink) {
      writeSink.size = 0;
      try {
        // 此时 writable 还开着（finishOutput 里才 close），truncate 有效
        if (typeof writeSink.truncate === 'function') await writeSink.truncate(0);
      } catch (err) {
        warn('合并前截断目标文件失败（可能残留旧字节）', err?.message);
      }
    }

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
  /**
   * 下载一条轨道到 sink。
   *
   * `resume` 传入续传描述（见 ResumeStore.openPartial）时，只下载缺失区间，
   * 并随分片完成增量更新清单——这样中途取消 / 崩溃后下次能接着下。
   * 默认关闭（settings.resumeEnabled），因为浏览器端行为还没法在 CI 里验证。
   */
  /**
   * @param {object} o
   * @param {string[]} o.urls
   * @param {(() => Promise<string[]>)|null} [o.refreshUrls]
   *   当下载因 **URL 过期** 失败（B 站 CDN 地址约 120 分钟失效，表现为 403/404）时，
   *   调用它重新拿一批地址并重试一次。不传则沿用旧行为（只重试同一批地址，必然全败）。
   */
  async fetchTo({ urls, size, sink, onProgress, signal, probe = true, resume = null, refreshUrls = null, writeOffset = 0 }) {
    let list = (urls || []).filter(Boolean);
    if (!list.length) throw new Error('没有可用的下载地址');
    let total = size;
    if (!total && !probe) {
      const p = await probeSize(list[0], { signal });
      total = p.size;
    }
    const concurrency = Math.max(1, Math.min(16, this.settings.concurrency || 8));
    // 每个地址的额外重试次数。旧实现里 downloader 把它硬编码成 2，
    // 设置页的「失败重试次数」从来没人读 —— 用户调了没反应（v1.4.22 修复）。
    const retries = Number(this.settings.retries);

    /** 已完成的区间（续传时非空） */
    let doneRanges = resume && resume.ranges ? [...resume.ranges] : [];
    let refreshUrlsUsed = 0;
    const persistProgress = async () => {
      if (!resume || !resume.store || !resume.key) return;
      await resume.store.write(resume.key, { size: total, ranges: doneRanges });
    };

    /**
     * 把这一轨标记为「已下完」。
     *
     * ★ 这里原来是 `await resume.store.clear(resume.key)` —— 那是 P0：
     *   把清单删掉等于**忘了记下"这条轨已经下完了"**。下次 openPartial 读不到清单，
     *   canResume 判 false → 走"不能续传"分支 → **truncate(0) 把 .part 整个抹掉**。
     *
     *   典型受害场景（合并模式，两条轨顺序下）：
     *     视频轨下完 → 音频轨下到一半 → 暂停 → 继续
     *     → 视频轨 .part 被抹掉重下整份，续传等于没生效。
     *
     *   改成写一条「区间 = 全量」的清单后，openPartial 能认出它并直接跳过下载。
     */
    const markTrackComplete = (finalSize) => {
      if (!resume || !resume.store || !resume.key) return Promise.resolve();
      const s = Number(finalSize) || total;
      if (!Number.isFinite(s) || s <= 0) return Promise.resolve();
      return resume.store
        .write(resume.key, { size: s, ranges: [{ start: 0, end: s }] })
        .catch(() => {});
    };

    /**
     * 包一层 onProgress：分片完成时把区间记进 `doneRanges`。
     *
     * ★ 三处 `downloadRanged` 调用**必须共用这一个**包装版本。
     *   原来只有首次调用包了，两条重试路径传的是**原始** onProgress ——
     *   于是重试期间下的字节完全没有记账，带来两个隐患：
     *     - 重试再失败时，"已下区间"少算了重试那一段，回退顺序下载时白白重下；
     *     - 开了续传时，重试期间的进度不落盘，下次续传的起点比实际偏早。
     */
    const wrappedProgress = (p) => {
      // 分片完成时增量记录：p 里带 range 就记一段
      // 优先用 ranges（本次上报周期内完成的全部区间）；没有则退回单个 range。
      const done = (p && Array.isArray(p.ranges)) ? p.ranges : (p && p.range ? [p.range] : null);
      if (done && done.length) {
        for (const r of done) {
          if (Number.isFinite(r.start) && Number.isFinite(r.end)) {
            doneRanges = addRange(doneRanges, { start: r.start, end: r.end + 1 });
          }
        }
        // ★ 记账与落盘要分开：没开续传时也要在**内存里**记，
        //   否则失败重试只能从 0 再来（见下面"保留进度重试"那段）。
        //   落盘则只在开启续传时做，且不 await，避免拖慢下载；
        //   节流交给调用方（每 300ms 的 report）。
        if (resume) persistProgress().catch(() => {});
      }
      onProgress?.(p);
    };

    try {
      const result = await downloadRanged({
        urls: list,
        size: total,
        writeOffset,
        sink,
        concurrency,
        retries,
        signal,
        onProgress: wrappedProgress,
        probe,
        resumeRanges: doneRanges.length ? doneRanges : null,
      });
      // ★ 「记账」之前必须先把字节**真的落盘**。
      //
      // FileHandleSink 的 writeAt 只把写入排进异步链，**只有 close() 才会 await 这条链
      // 并关掉 writable**。不关就写下"已下完"清单的话，磁盘上的 .part 可能还短着，
      // 而 openPartial 现在会拿 .part 的真实长度校验清单（见 resume-store.planResume）
      // —— 长度对不上就判 fresh，把这条已下完的轨 truncate 掉重下，续传等于白做。
      //
      // 只在开启续传时做：durl 多个分段共用同一个 sink，中途关掉会让后续分段写不进去；
      // 其余路径本来就会在 finishOutput / mergeInto 里关。
      // mergeInto 里的二次 close 是幂等的（close 会把 writable 置 null，再调即空操作）。
      if (resume) await closeSinkQuietly(sink, '续传分片');
      // 标记完成（不是删除）—— 见 markTrackComplete 的说明
      await markTrackComplete(result?.size);
      return result;
    } catch (err) {
      if (err instanceof DownloadAborted) {
        // ★ 用户取消 / 暂停：必须**先关掉 sink**再记清单、再抛。
        //
        // 续传用的 .part 是 FileHandleSink，它的 writable 从 open() 起就一直开着。
        // 不关会出两个问题：
        //   ① 已写的字节可能还在 writable 缓冲区里没落盘，
        //      而清单已经把这些区间记成"已完成" → 下次续上的内容对不上；
        //   ② 下次「继续」时 openPartial 会对**同一个 .part 文件**再开一个 writable，
        //      同一个 OPFS 文件两个 writable 并存 → 写入互相覆盖，或直接抛错。
        //
        // 先 close 再 persist，保证"落盘完成"发生在"记账"之前。
        await closeSinkQuietly(sink, '续传分片');
        // 保留清单，下次可续（取消会在 run() 的 catch 里再把它清掉）
        await persistProgress().catch(() => {});
        throw err;
      }
      // B 站 CDN 地址约 120 分钟失效，失效后返回 403 / 404。
      // 这时拿同一个过期地址重试毫无意义——必须重新 playurl 换一批地址。
      const expired = isUrlExpiredError(err);
      if (expired && refreshUrls && refreshUrlsUsed < 1) {
        refreshUrlsUsed += 1;
        try {
          warn('播放地址疑似过期（' + err.status + '），重新获取地址后重试', err.message);
          const fresh = (await refreshUrls()) || [];
          const next = fresh.filter(Boolean);
          if (next.length) {
            list = next;
            total = size;
            doneRanges = [];
            await resetSink(sink);
            if (resume) await resume.store.clear(resume.key).catch(() => {});
            const retried = await downloadRanged({
              urls: list,
              size: total,
              writeOffset,
              sink,
              concurrency,
              retries,
              signal,
              onProgress: wrappedProgress,
              probe,
              resumeRanges: null,
            });
            if (resume) await closeSinkQuietly(sink, '续传分片'); // 同上：先落盘再记账
            await markTrackComplete(retried?.size);
            return retried;
          }
        } catch (e2) {
          warn('刷新播放地址后重试仍失败', e2?.message);
          err = e2;
        }
      }

      // ★ 直接回退顺序下载的代价被严重低估了：resetSink 会把**已下好的字节全部丢掉**，
      //   然后**单连接**从头再下一遍 —— 用户体感就是"下到 80% 突然慢 8 倍"。
      //
      //   这是「后半段变慢」最隐蔽的来源之一：它只在出错时触发，
      //   看起来像网络抽风，实际是我们在主动放弃全部进度。
      //   只有服务器真的不支持 Range（rangeIgnored）时才必须走这条路。
      if (!err?.rangeIgnored && doneRanges.length) {
        const keptBytes = completedBytes(doneRanges);
        if (keptBytes > 0 && keptBytes < total) {
          try {
            warn(`分片下载中断（已下 ${keptBytes} / ${total} 字节），保留进度重试一次`, err.message);
            const kept = await downloadRanged({
              urls: list,
              size: total,
              writeOffset,
              sink,
              concurrency,
              retries,
              signal,
              onProgress: wrappedProgress,
              probe,
              // 只下缺口，已写的字节原地保留 —— 不调 resetSink 是关键
              resumeRanges: doneRanges,
            });
            if (resume) await closeSinkQuietly(sink, '续传分片'); // 同上：先落盘再记账
            await markTrackComplete(kept?.size);
            return kept;
          } catch (e2) {
            if (e2 instanceof DownloadAborted) throw e2;
            warn('保留进度重试仍失败，才回退到顺序下载', e2?.message);
            err = e2;
          }
        }
      }

      warn('分片下载失败，回退到顺序下载', err.message);
      await resetSink(sink);
      // 回退顺序下载时不能续传（会重下整个文件），清掉清单避免半份残留
      if (resume) await resume.store.clear(resume.key).catch(() => {});
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
      // 延后回收 blob URL。原来是 180 秒，但用户若在「另存为」对话框里
      // 停留超过 3 分钟，URL 已被回收 → 下载失败且报错难懂。改为 24 小时；
      // 页面关闭时浏览器会统一回收，不会真的泄漏一整天。
      setTimeout(() => URL.revokeObjectURL(url), 24 * 60 * 60 * 1000);
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

    // 字幕与章节的数据都在 /x/player/wbi/v2 里，共用一次请求，避免重复调用。
    let playerInfo = null;
    if (settings.saveSubtitle || settings.saveChapters) {
      try {
        playerInfo = await api.playerV2({ bvid: spec.bvid, aid: spec.aid, cid: spec.cid });
      } catch (err) {
        warn('播放器信息获取失败（字幕/章节都依赖它）', err);
      }
    }

    if (settings.saveSubtitle) {
      try {
        const info = playerInfo;
        const subs = info?.subtitle?.subtitles || [];
        const target = pickSubtitle(subs, settings.subtitleLan);
          if (target?.subtitle_url) {
            // ★ 字幕 URL 来自接口数据，必须过白名单再决定要不要带凭证。
            // 旧实现直接 `fetch(url, { credentials: 'include' })`，既没校验域名
            // （可对任意可控 URL 发带 Cookie 请求），也没强制 https
            // （`http://` 会明文带凭证）。见 util.sanitizeBiliUrl。
            const { url, safe, reason } = sanitizeBiliUrl(target.subtitle_url);
            if (!url) throw new Error(`字幕地址无效：${reason || '未知原因'}`);
            if (!safe) warn('字幕地址不在 B 站域名白名单内，已改为不带凭证请求', reason);
            const res = await fetch(url, { credentials: safe ? 'include' : 'omit' });
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

    // 章节：数据源是 /x/player/wbi/v2 的 view_points。
    // 上面取字幕时已经调过这个接口，这里若再调一次就是纯浪费；
    // 但 saveSubtitle 关闭时我们没调过，所以按需各取一次。
    if (settings.saveChapters) {
      try {
        const info = playerInfo;
        const chapters = parseViewPoints(info?.view_points, {
          duration: spec.duration || plan?.duration,
        });
        if (chapters.length) {
          if (settings.chapterFormat === 'vtt') {
            await put(`${task.filename}.chapters.vtt`, chaptersToVtt(chapters), 'text/vtt');
          } else {
            await put(`${task.filename}.chapters.txt`, chaptersToTxt(chapters), 'text/plain');
          }
          log('章节已保存', chapters.length);
        }
      } catch (err) {
        warn('章节获取失败', err);
      }
    }

    // NFO（Jellyfin / Kodi 归档）：与媒体文件同基名，多P 天然不互相覆盖。
    //
    // 只在**产出单个 mp4** 的模式（merge / durl）下生成：
    //   - separate 出的是 .video.mp4 + .audio.m4a，两个文件都残缺，不该有 NFO
    //   - audio 出的是 .m4a，NFO 基名对不上，Jellyfin 不会识别
    const nfoMode = settings.downloadMode === 'merge' || settings.downloadMode === 'durl';
    if (settings.saveNfo && nfoMode) {
      try {
        const info = spec.info || {};
        const page = info.pages?.[spec.pageIndex || 0];
        // 形态按**视频类型**定，不按 P 数：
        //   普通视频（哪怕是多P）是 movie，只有番剧 / 课程才是 episode
        const isBangumi = !!(spec.epId || spec.seasonId || spec.cheeseId);
        const nfo = buildNfo({
          kind: isBangumi ? 'episode' : 'movie',
          title: isBangumi && page?.part
            ? `${info.title || spec.title} - ${page.part}`
            : (info.title || spec.title),
          showTitle: info.title || spec.title,
          season: isBangumi ? 1 : undefined,
          episode: isBangumi ? (Number(spec.pageIndex || 0) + 1) : undefined,
          plot: info.desc,
          pubdate: info.pubdate,
          duration: page?.duration || info.duration || spec.duration,
          cover: spec.cover || info.pic,
          owner: info.owner,
          genre: info.tname,
          bvid: info.bvid || spec.bvid,
          aid: info.aid || spec.aid,
        });
        await put(nfoFilename(task.filename), nfo, 'text/xml');
        log('NFO 已保存');
      } catch (err) {
        warn('NFO 生成失败', err);
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
  // 课程只需要 cheeseId 就能反查 cid；其余类型至少要能定位到一个视频
  if (!spec.bvid && !spec.aid && !spec.cheeseId) return spec;
  if (isCanceled()) return spec;

  let info = null;
  try {
    if (spec.cheeseId) {
      // 课程：用 /pugv/view/web/season?ep_id= 反查该集的 cid。
      // 注：课程接口需要登录且通常是付费内容，这条路径**没有真机验证过**，
      // 失败会 warn 并回退，不会让任务更糟。
      const season = await api.cheeseSeason(spec.cheeseId);
      const ep = (season?.episodes || []).find((e) => Number(e.id) === Number(spec.cheeseId));
      if (ep && Number(ep.cid) > 0) {
        spec.cid = Number(ep.cid);
        if (!spec.title && ep.title) spec.title = ep.title;
        return spec;
      }
      warn('课程：未能从 season 接口解析出 cid', 'cheeseId=' + spec.cheeseId);
      return spec;
    }
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
      // NFO 需要：简介 / 封面 / 分区。都是同一个 view 接口返回的，不额外请求。
      desc: info.desc,
      pic: info.pic,
      tname: info.tname,
      tid: info.tid,
      // 互动视频（stein gate）标记。B 站的互动视频有多个分支剧情，
      // 我们目前只下主线（默认分支），分支展开未实现 —— 先识别出来，
      // 好在日志里给出明确提示，而不是让用户以为是下载失败。
      steinGate: !!info.rights?.is_stein_gate,
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
    // totalBytes 必须按**全部分段求和**：durl 可能是多段（长视频/番剧分段），
    // 只算第一段会让进度永远到不了 100%，也让上层误判文件大小
    const totalBytes = (playInfo.durl || []).reduce((sum, seg) => sum + (Number(seg?.size) || 0), 0);
    return {
      mode: 'durl',
      quality: playInfo.quality,
      codec: 'H.264',
      video: null,
      audio: null,
      durl: playInfo.durl,
      totalBytes,
    };
  }

  const accept = playInfo.acceptQuality || [];
  // 轨道里**实际存在**的最高清晰度。accept_quality 是 B 站"宣称可接受"的名单，
  // 里面常有实际并不存在的档位（未登录/非会员时尤其明显），所以不能用它推断
  // 真实上限——真实上限只能从返回的轨道里看。
  const trackQualities = (playInfo.videos || [])
    .map((v) => v.quality ?? v.id)
    .map(Number)
    .filter((q) => Number.isFinite(q) && q > 0);
  const maxTrack = trackQualities.length ? Math.max(...trackQualities) : 0;

  // ★ 候选档位 = 宣称名单 ∪ **实际存在的轨道档位**。
  //
  // 为什么必须取并集（而不是只信 accept_quality）：
  //   - accept_quality 会**虚报**：实测未登录时宣称 [116,80,64,32,16]，
  //     而 dash.video 实际只有 [32,16]。只信它 → 算出"请求 116"，
  //     再被 pickVideoTrack 回退成 32，用户看到的就是"标称高清、实际低清"。
  //   - accept_quality 也可能**漏报**：某个档位明明有轨道却没列进 accept。
  //     只信它 → 自动模式取到比实际可达更低的值（静默低画质）。
  // 并集则两头都兜住：只要**轨道真实存在**，它就有资格成为目标档位。
  const candidates = [...new Set([...accept.map(Number), ...trackQualities])]
    .filter((q) => Number.isFinite(q) && q > 0)
    .sort((a, b) => b - a);

  let quality = Number(spec.quality) || Number(settings.defaultQuality) || 0;
  // 自动（0）：取候选里的最高档。
  //
  // **关键**：Number(spec.quality) 不是 Number() 化摆设 —— settings 里 defaultQuality
  // 经 storage 持久化再读回时是**字符串**（"0" 而不是 0），而 JS 里 `!"0" === false`
  // （非空字符串是 truthy）。如果用 `spec.quality || settings.defaultQuality` 兜底，
  // 字符串 "0" 会被当 truthy 跳过自动分支，导致降级到最低档（360P）。
  // 数值归一化在 settings.loadSettings 里已经做过，但这里再防御一次（也防
  // settings 来自测试 / 直接调用 / 旧版本扩展未升级），双保险。
  //
  // 用 Math.max 而不是 accept[0]：实测 4 个不同视频的 accept_quality 都是降序
  // （[116,80,64,32,16] / [32,16] / [112,80,64,32,16] / [16]），但这**不是接口契约**，
  // 一旦顺序变了 accept[0] 就可能取到最低档 —— 那正是 360P 事故的形态。
  if (!quality) {
    quality = candidates[0] || playInfo.videos[0]?.quality || 0;
  }

  if (quality && candidates.length && !candidates.includes(quality)) {
    // 请求的档位不可得：优先降到「不超过它的最高档」；
    // 若全都比它高（例如请求 16 但最低档是 32），就升到最接近的一档。
    // ★ 原来是 `accept[accept.length - 1]`（名单末位 = 最低档），
    //   会把用户的高清请求**静默变成 360P** —— 这正是"怎么自动下了 360P"的来源。
    const lower = candidates.filter((q) => q <= quality).sort((a, b) => b - a)[0];
    const higher = candidates.filter((q) => q > quality).sort((a, b) => a - b)[0];
    const fallback = lower || higher || maxTrack || quality;
    if (fallback !== quality) {
      warn('请求的清晰度不可用，已就近调整', `请求 ${quality} → 实际 ${fallback}`);
    }
    quality = fallback;
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
