# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

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
