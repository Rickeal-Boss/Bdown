# 架构说明

## 一、分层

```
┌──────────────────────── 界面层（扩展页面，各自独立） ────────────────────────┐
│  popup/       解析当前视频 → 选清晰度/选集/附加内容 → 派发任务                │
│  dashboard/   ★ 任务队列 + 保存位置 + 实时进度（长任务在这里执行）             │
│  options/     设置（data-key 自动绑定）                                      │
│  content/     视频页悬浮按钮 / 播放器按钮 / URL 变化监听                       │
│  background/  仅做消息路由与右键菜单（SW 会被回收，不承载长任务）              │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼───── 核心层（与 UI 完全解耦） ────────────┐
│  engine.js     ★ 任务流水线：解析 → 下载 → 混流 → 落盘 → 附加内容             │
│  mp4.js        ★ ISO BMFF 解析 + DASH 无损合并（纯函数，可在 Node 里测试）    │
│  downloader.js ★ Range 分片并发下载（多 CDN 回退 / 分片重试 / 顺序兜底）      │
│  sink.js       落盘目标：MemorySink / FileHandleSink / OpfsWorkspace         │
│  api.js        B 站接口封装 + 响应归一化（PlayInfo / VideoTrack / AudioTrack）│
│  wbi.js        WBI 签名 + 指纹参数        md5.js  纯 JS MD5                  │
│  danmaku.js    弹幕 XML → ASS（车道排布） / subtitle.js  字幕 → SRT/ASS      │
│  settings.js   设置与命名模板             util.js  通用工具                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

核心层没有任何 DOM / chrome API 依赖（除 `engine.js` 用到 `chrome.downloads` 与 OPFS），
因此 `mp4.js`、`downloader.js` 可以直接在 Node 里跑端到端测试（见 `tools/mux-test.mjs`）。

## 二、任务状态机

```
                 ┌──────────── cancel / 失败 ────────────┐
                 ▼                                       │
pending ──► resolving ──► downloading ──► muxing ──► saving ──► done
   │             │              │            │          │
   └─ cancel ────┴──────────────┴────────────┴──────────┘
                                 ▼
                             canceled / error ──► retry ──► pending
```

`Task` 持有自己的 `AbortController`，取消时信号会一路传到 `fetch`，正在写文件的 sink 也会被中止。
每个阶段都会 `emit(task)` 通知 UI 重绘。

## 三、输出路径决策

`createOutput()` 按优先级选择落盘方式：

| 条件 | 行为 | 内存占用 |
| --- | --- | --- |
| 用户选了**文件夹**（批量） | `dirHandle.getFileHandle()` → 直接写入 | 极低 |
| 用户选了**具体文件**且只有一个输出 | `showSaveFilePicker()` 的句柄 → 直接写入 | 极低 |
| 文件 ≤ 256MB 且没有句柄 | `MemorySink` → `Blob` → `chrome.downloads` | 与文件同量级 |
| 其余 | OPFS 临时文件 → `File` → `chrome.downloads` | 极低 |

混流模式下，两条轨道**总是**先落到临时目标（`createTemp`），合并结果再写进最终输出 ——
避免把视频轨数据与合并结果混在同一个 sink 里。

## 四、混流算法

详见 [`docs/RESEARCH.md`](RESEARCH.md#3-混流方案对比本项目最关键的决策点) 与 `src/core/mp4.js` 的头部注释。

```
scanFile(videoSource) ─┐
                       ├─► buildMergedMoov() ─► ftyp + moov + Σ(moof+mdat, 按 tfdt 交错)
scanFile(audioSource) ─┘
```

`scanFile` 只读每个 `moof` 的头部（≤16KB），因此扫描 1000 个片段也很快；
合并阶段按 1MB 分块流式复制，`FileHandleSink` 用 `write({position})` 顺序追加。

## 五、Referer 注入

MV3 的 `fetch` 无法设置 `Referer`（禁止头，会被静默丢弃），因此：

```json
// rules/referer.json
{
  "action": {
    "type": "modifyHeaders",
    "requestHeaders": [
      { "header": "Referer", "operation": "set", "value": "https://www.bilibili.com/" }
    ]
  },
  "condition": {
    "regexFilter": "^https?://([^/]*\\.)?(bilivideo\\.com|bilivideo\\.cn|akamaized\\.net|hdslb\\.com|biliapi\\.net)(:\\d+)?/",
    "resourceTypes": ["xmlhttprequest", "media", "other", "object", "sub_frame"]
  }
}
```

规则是静态的（`declarative_net_request.rule_resources`），由浏览器内核执行，不需要 Service Worker 参与，
因此 SW 被回收也不影响下载。

## 六、为什么不用 Service Worker / Offscreen Document 跑下载

| 方案 | 问题 |
| --- | --- |
| Service Worker | 30 秒无事件即被回收，长下载必然中断 |
| Offscreen Document | 生命周期可控，但**无法使用 File System Access API 的 `showSaveFilePicker`**（需要用户手势与可见页面），且无法给用户展示进度 |
| 扩展标签页（本项目） | 生命周期稳定、可交互、可用文件选择器、可开 Web Worker，唯一代价是需要用户保持标签页打开（已在离开前做拦截提示） |

## 七、扩展点

- **新增输出方式**（如 aria2 / 外部下载器）：在 `engine.js` 里加一个 `exportFile` 的分支即可
- **新增附加内容**（如 NFO、章节）：在 `fetchExtras()` 里加一段
- **新增站点适配**：`api.js` 是唯一与 B 站耦合的地方，抽象出 `PlayInfo` 后即可复用整条流水线
- **新清晰度 / 编码**：只改 `quality.js` 的元数据表
