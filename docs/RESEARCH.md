# 参考实现调研

开荒前对 GitHub / Gitee 上的同类开源项目做了系统性调研，用于确认**当前可用的接口细节**、
**浏览器扩展的取流约束**以及**各家混流方案的取舍**。下面是结论汇总。

## 一、调研对象

| 项目 | 语言 / 形态 | Star | 参考价值 |
| --- | --- | --- | --- |
| [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) | 文档 | 20k+ | 接口字段与 WBI 签名算法的权威说明（仓库已归档，`master` 分支改名为 `deprecated`） |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) `extractor/bilibili.py` | Python / CLI | 100k+ | **最权威且持续维护**。WBI 实现、`fnval=4048`、`dm_img_*` 指纹、字幕与弹幕接口都以它为准 |
| [iawia002/lux](https://github.com/iawia002/lux) | Go / CLI | 31k+ | 极简的取流路径，DASH 与 durl 双模式 |
| [the1812/Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) | 用户脚本 | 20k+ | **浏览器端最成熟的下载面板**：清晰度/编码/音轨选择、CDN 偏好、批量选集、输出方式抽象 |
| [BilibiliVideoDownload/BilibiliVideoDownload](https://github.com/BilibiliVideoDownload/BilibiliVideoDownload) | Electron | 3.5k | 桌面端流程，扫码登录与任务队列设计 |
| [nICEnnnnnnnLee/BilibiliDown](https://github.com/nICEnnnnnnnLee/BilibiliDown) | Java | 3k+ | 批量与番剧/合集的遍历策略 |
| [ScottSloan/Bili23-Downloader](https://github.com/ScottSloan/Bili23-Downloader) | Python | 7.5k | 多线程加速、弹幕元数据、命名模板 |
| [iuroc/bilidown](https://github.com/iuroc/bilidown) | Tauri | 2.2k | 8K / Hi-Res / 杜比视界 的清晰度处理 |
| [lanyeeee/bilibili-video-downloader](https://github.com/lanyeeee/bilibili-video-downloader) | Rust | 2k | nfo 刮削与媒体库集成 |
| [monkeyWie/gopeed-extension-bilibili](https://github.com/monkeyWie/gopeed-extension-bilibili) | JS / 下载器扩展 | 260 | **与浏览器最接近的形态**：`Referer` 注入、`fnval` 位掩码组合、断链后重新取流 |
| [xxxily/h5player](https://github.com/xxxily/h5player) | TS / 扩展 | 3.7k | 扩展里的媒体嗅探与下载边界处理 |
| [0xlau/biliplus](https://github.com/0xlau/biliplus) | JS / Edge 扩展 | 1k | Edge 扩展工程结构 |
| [bilibili-helper/bilibili-helper-o](https://github.com/bilibili-helper/bilibili-helper-o) | JS / 扩展 | 3.8k | 早期 durl 下载方案 |

## 二、关键结论

### 1. 取流接口（2026-09 实测确认）

- 高清视频**只有 DASH**：`fnval=4048 = 16(DASH) | 64(HDR) | 128(4K) | 256(杜比音频) | 512(杜比视界) | 1024(8K) | 2048(AV1)`
- `durl`（`fnval=1`）仍可用，但清晰度上限低，适合做「单文件直下」兜底
- 必须走 **WBI 签名版** `GET /x/player/wbi/playurl`，非签名版在多数情况下返回 -403
- `nav` 接口**未登录时返回 `code:-101`，但 `data.wbi_img` 依然有效** —— 这点极易踩坑
- `dm_img_list / dm_img_str / dm_cover_img_str / dm_img_inter` 指纹参数能显著降低 -352 风控概率
  （yt-dlp 有完整实现；`dm_img_inter` 必须是**无空格的紧凑 JSON**）
- 音轨：`dash.audio[]`（30216/30232/30280）、`dash.dolby.audio`、`dash.flac.audio` 三条路径都要看
- 字幕走 `GET /x/player/wbi/v2` → `data.subtitle.subtitles[].subtitle_url`
- 弹幕仍可用老的 XML 接口 `comment.bilibili.com/<cid>.xml`，比 protobuf 更省事

### 2. 浏览器扩展的取流约束（实测）

| 约束 | 实测结果 | 结论 |
| --- | --- | --- |
| CDN 是否要求 Referer | `xy***.mcdn.bilivideo.cn` 节点**不带 Referer 也返回 206** | 仍应统一注入 Referer（`upos-*-mirror*` 等节点会校验） |
| CORS | 响应头 `Access-Control-Allow-Origin: *` | 扩展页面 / 内容脚本都能直接 fetch，无需代理 |
| Range | 响应头 `Accept-Ranges: bytes`，`Content-Range: bytes 0-1023/20872903` | **可做多线程分片下载** |
| 设置 Referer 的方式 | `fetch` 的 `Referer` 是禁止头，会被静默丢弃 | 必须用 `declarativeNetRequest` 的 `modifyHeaders` 注入 |
| MV3 Service Worker | 空闲会被回收 | 长任务必须放到扩展标签页，不能放 SW |

### 3. 混流方案对比（本项目最关键的决策点）

调研发现一个有意思的现象：**几乎所有浏览器端方案都不做混流**。

| 方案 | 代表项目 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 交给外部工具合并 | Bilibili-Evolved（输出 aria2 / ABDM 参数）、gopeed | 实现简单 | 用户必须另装 ffmpeg 或桌面端，体验割裂 |
| 输出 `.m4s` 让用户自己拼 | 多数扩展 | 无 | 拿到的文件无法直接播放 |
| StreamSaver 边下边写 | Bilibili-Evolved 的 `steamSaver` 输出 | 不受内存限制 | 仍需外部合并 |
| ffmpeg.wasm | 少数网页工具 | 功能全 | 体积 20–30MB；MV3 CSP 禁止加载远程脚本，只能打包进扩展 |
| MediaRecorder 重编码 | 少量工具 | 输出即标准 MP4 | **有损重编码**，画质下降，速度极慢 |
| **纯 JS 重写容器（本项目）** | — | 无损、快、无额外体积 | 需要正确实现 ISO BMFF 解析 |

本项目选择了最后一种，并利用 B 站 m4s 的一个特性把它做得非常简单：

> `tfhd` 的 flags 带 `default-base-is-moof (0x020000)`，即 `trun` 的 `data_offset` 是**相对 moof 起点**的。
> 因此只要把 `moof` 与其后的 `mdat` **作为一个整体**搬迁，样本的字节位置完全不用重算 ——
> 媒体数据可以逐字节原样复制，只需要：
> 1. 重建一个含两条 `trak` 的 `moov`（track_ID 改为 1/2，重建 `mvex`）；
> 2. 按解码时间戳交错两个文件的 `moof+mdat`；
> 3. 修正 `mfhd.sequence_number` 与音频侧 `tfhd.track_ID`（各 4 字节）。

实测一个 213 秒的 480P 视频（视频 20.9MB + 音频 5.4MB，共 85 个片段）：
**64 ms 完成合并，85 个片段的媒体数据 SHA-256 逐个一致。**

### 4. 其他值得借鉴的设计

- **CDN 偏好选择**：Bilibili-Evolved 会把 `baseUrl` + `backupUrl` 按 Mirror / UPOS / BCache / MCDN 分类排序。
  本项目简化为「主地址 + 全部备用地址依次回退」，由下载引擎自动完成。
- **清晰度缺失提示**：从 `support_formats` 与 `accept_quality` 的差集推断「哪些清晰度需要大会员」，
  比单纯报错友好得多。
- **命名模板变量**：Bilibili-Evolved 的 `batchFilenameFormat` 支持 `user / userID / publishYear / ...`，
  本项目沿用同一套变量命名以便用户迁移。
- **不要短时间内大量下载**：多个项目的 README 都强调这一点，本项目在 UI 与文档中同样做了提示。

## 三、本项目未采纳的方案及原因

| 方案 | 不采纳原因 |
| --- | --- |
| ffmpeg.wasm 打包进扩展 | 体积增加 20–30MB，而本项目已有无损且更快的方案 |
| 扫码登录 / Cookie 导入 | 扩展可直接复用浏览器登录态（`credentials: 'include'` + host_permissions），无需额外的凭据管理 |
| aria2 / 外部下载器集成 | 与「纯浏览器、开箱即用」的定位冲突；如需可后续加输出适配层 |
| 直播流下载 | 协议（FLV/HLS 分片 + 实时追加）与点播差异大，另立项更合适 |
