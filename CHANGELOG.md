# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-09-18

源码级审查后的加固版本。所有结论均以真实源码比对或独立实现交叉验证为准。

### 修复

- **安全：分P标题 HTML 注入（🟠）**
  `src/popup/popup.js` 把 UP 主可控的 `p.part` 直接拼进 `innerHTML`，一个恶意投稿标题即可在
  `chrome-extension://` 源下执行脚本，进而读取 `chrome.storage` 与扩展内部消息通道。
  新增 `escapeHtml()` 并对所有接口来源文本转义。
- **安全：文件名欺骗与保留名（🟡）**
  `sanitizeFilename()` 现在会剥离 Unicode 双向覆盖字符（`U+202A–U+202E` 等，可把
  `video.exe` 显示成 `video.exe` 之外的后缀），规避 Windows 保留设备名
  （`CON`/`NUL`/`COM1`/`LPT9`），并去掉开头的可疑点号（`../` 此前会被洗成 `.._`）。
- **正确：WBI 签名的编码器语义（🟠，潜在）**
  `signParams()` 原先用 `encodeURIComponent`，与服务端（Python `urllib.parse.urlencode`）
  的转义集合不一致——空格 `%20` vs `+`、`~` `%7E` vs `~`、`!*'()` 原样 vs `%21%2A%27%28%29`。
  当前参数恰好不含这些字符所以线上正常，属「碰巧没踩到」。新增 `formUrlEncode()`，
  用 Python 实测值逐项对拍。
- **正确：混流器对不可搬迁片段的处理（🟠）**
  `parseMoof()` 现在会检查 `tfhd.flags`：若使用绝对 `base_data_offset`（`0x000001` 且未置
  `default-base-is-moof`），搬迁后样本地址必然失效 → 直接抛明确错误，而不是静默产出坏文件。
- **正确：混流器支持 moof 内多 traf / 多 trun（🟡）**
  原先只取第一个 `traf` 与第一个 `trun`，多轨片段会算错时长、漏补 `track_ID`。
  现改为遍历全部，时长取各 traf 的最晚结束时间，`track_ID` 逐个打补丁。

### 变更

- **权限最小化**：移除 `scripting`、`notifications`、`cookies`（全仓库 0 处引用）。
  登录态高清晰度依赖 `host_permissions` + `credentials: 'include'`，不需要 `chrome.cookies` API。
- **移除 `web_accessible_resources`**：代码从未被页面引用（content script 不注入图标、
  不 fetch 扩展页），保留会让任意 `bilibili.com` 页面探测到扩展并把 dashboard 塞进 iframe。
- **番剧接口 fnval 改 12240**（原 4048）。依据：yt-dlp 对 `pgc/player/web/v2/playurl`
  使用 `fnval: 12240 = 4048 | 8192`，可拿到更多清晰度。

### 新增

- `tools/selftest-core.mjs`：43 项核心模块行为自检（XSS 向量、`formUrlEncode` 与 Python
  对拍、MD5 与 Node `crypto` 对拍含分块边界、AV/BV 往返 2 万次 + Python 独立向量、
  文件名安全）。已接入 GitHub Actions。

### 验证

- WBI 乱序表 `MIXIN_KEY_ENC_TAB` 与 yt-dlp `bilibili.py` **逐项一致**（64 项全比对）
- `fnval=4048`、`dm_img_*` 参数（含 `dm_img_inter` 紧凑 JSON）与 yt-dlp `_dm_params` 一致
- 4 个图标经 PNG magic + IHDR 校验，确为 16/32/48/128 真实 PNG
- `manifest.json` 与 `package.json` 版本一致（1.0.0），`_locales` 的 `__MSG_*` 均被正确引用

## [1.0.0] - 2026-09-18

首个可用版本。

### 新增

- **解析**
  - WBI 签名实现（纯 JS MD5 + 固定乱序表 + 指纹参数 `dm_img_*`），可稳定调用 `/x/player/wbi/playurl`
  - 视频信息、分P、合集（`ugc_season`）、番剧选集解析
  - AV/BV 号互转，支持从链接 / BV 号 / av 号 / ep / ss 解析
  - 账号状态与大会员识别，未登录时自动降级并给出明确提示
- **下载**
  - Range 分片并发下载（默认 8 线程，可调 1–16），分片级重试 + 多 CDN 备用地址回退
  - 不支持 Range 时自动回退到单连接顺序下载
  - 三种输出模式：合并 MP4 / 音视频分离 / 单文件直下（durl）
  - 实时进度、速率、剩余时间；任务可取消、可重试
- **混流**
  - 纯 JavaScript 实现的 fragmented MP4 无损合并（`src/core/mp4.js`）
  - 媒体数据零转码、逐字节保留；流式处理，内存占用与文件大小无关
  - 自带 `tools/mux-test.mjs` 端到端自检（SHA-256 逐片段比对 + 结构校验）
- **附加内容**
  - 弹幕：XML 解析 + ASS 生成（车道排布、滚动/顶部/底部/逆向、颜色与字号还原）、SRT、TXT、原始 XML
  - 字幕：SRT / ASS（支持双语上下排）/ TXT
  - 封面下载
- **批量**
  - 多分P、合集、番剧选集批量入队；支持 `1-3,5` 范围表达式与全选/反选
- **落盘**
  - File System Access API 直写用户选定文件/文件夹（支持 GB 级文件）
  - 无该 API 时回退到 `chrome.downloads`
  - OPFS 临时空间管理，可一键清理
- **界面**
  - 视频页右下角悬浮按钮 + 播放器控制栏按钮 + 右键菜单
  - 弹窗：清晰度（含所需权限提示与预估体积）、选集、下载方式、附加内容
  - 下载中心：任务队列、进度、保存位置、账号状态、临时空间占用
  - 设置页：命名模板、下载参数、附加内容、弹幕 ASS 渲染参数、界面开关
- **工程**
  - `rules/referer.json`：通过 declarativeNetRequest 为 CDN 统一注入 Referer / UA
  - `tools/validate.mjs`：JS 语法、JSON、manifest 引用完整性、DNR 规则结构校验（可用于 CI）
  - GitHub Actions 工作流，push / PR 自动校验

### 已知限制

- 不支持直播流与付费课程
- 输出为 fragmented MP4；如需传统 MP4 可用 `ffmpeg -i out.mp4 -c copy final.mp4` 快速重封装
- 弹幕 ASS 为近似还原，不保证与网页播放器像素级一致
