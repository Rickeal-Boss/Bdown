# Bdown · B站视频下载助手

一款基于 **Microsoft Edge / Chrome（Manifest V3）** 的哔哩哔哩视频下载扩展。

无需安装任何本地软件、无需配置外部下载器：在浏览器里点一下，就能把视频以最高可用清晰度下载到本地，
音视频**自动无损合并**成可直接播放的 MP4。

> 本项目为开源学习项目，请仅用于下载你有权保存的内容，并遵守哔哩哔哩用户协议。请勿短时间内大量下载。

---

## ✨ 功能

| 分类 | 能力 |
| --- | --- |
| 清晰度 | 240P ~ **8K**、**4K**、**1080P60**、**1080P 高码率**、**HDR**、**杜比视界**、智能修复（以账号权限为准） |
| 编码 | AVC / H.264、HEVC / H.265、AV1（可指定偏好） |
| 音轨 | 64K / 132K / 192K、**杜比全景声**、**Hi-Res 无损 FLAC** |
| 下载方式 | ① 合并为单个 MP4 ② 音视频分离文件 ③ 单文件直下（durl） ④ 仅音频 |
| 混流 | 纯 JavaScript 实现的 **fragmented MP4 无损合并**，零转码、零质量损失、支持 GB 级文件 |
| 加速 | Range 分片并发下载（默认 8 线程，可调），多 CDN 备用地址自动回退，分片级重试 |
| 批量 | 多分P（P1–Pn）、合集（ugc_season）、番剧选集批量下载；支持 `1-3,5` 范围表达式 |
| 附加内容 | 弹幕（XML / **ASS 字幕** / SRT / TXT）、字幕（SRT / ASS / TXT）、封面、章节（TXT / WebVTT）、NFO 元数据（Jellyfin / Kodi 归档） |
| 落盘 | File System Access API 直写用户选定文件/文件夹；或交给浏览器下载目录 |
| 体验 | 视频页悬浮按钮、播放器控制栏按钮、右键菜单、任务队列、实时进度/速率/剩余时间、可取消可重试 |
| 语言 | 扩展 UI 目前为**简体中文**（商店描述为双语）；英文界面在 backlog |

> **仅音频**模式下按音轨的真实类型原样保存、不做任何转码：普通音轨（AAC）与杜比全景声
> 保存为 `.m4a`，Hi-Res 无损音轨保存为 `.flac`。此外，**弹窗里选的下载方式只对本次下载生效**，
> 不会改动设置页里的默认下载方式。

---

## 🚀 安装

### 开发者模式加载

1. 下载或克隆本仓库
2. 打开 Edge：地址栏输入 `edge://extensions/`（Chrome 为 `chrome://extensions/`）
3. 打开右下角 **开发人员模式**
4. 点击 **加载解压缩的扩展**，选择仓库根目录（含 `manifest.json` 的那一层）

### 使用

1. **先登录 B 站**（同一浏览器）。1080P 及以上清晰度、部分字幕都需要登录态，4K/8K/HDR/杜比视界需要大会员。
2. 打开任意视频页 → 点击右下角悬浮按钮「下载」或播放器控制栏的下载图标
3. 在弹窗中确认清晰度 / 选集 / 附加内容 → 点「开始下载」
4. 在弹出的「下载中心」页面点「开始」（或「全部开始」），选择保存位置

---

## 🧠 工作原理

### 1. 为什么必须做「混流」

B 站从 720P60 开始，高清视频**只提供 DASH 格式**：视频轨和音频轨是两个独立的 fragmented MP4
（`*.m4s`）。把两个文件首尾相接得到的是一堆无法播放的垃圾数据。

本扩展在浏览器里实现了完整的无损合并，不需要 ffmpeg：

```
输入：video.m4s（track_ID=1）  audio.m4s（track_ID=1）

观察到的真实结构
  ftyp + free* + moov{ mvhd, mvex{ mehd, trex, trep }, trak, udta }
       + sidx + [ moof{ mfhd, traf{ tfhd(flags=0x020000), tfdt, trun } } + mdat ] × N

关键点：tfhd 带 default-base-is-moof(0x020000)，trun 的 data_offset 相对 moof 起点。
        因此只要 moof+mdat 作为一个整体搬迁，样本字节位置完全不用重算。

输出：ftyp + 合并后的 moov（track 1=视频, 2=音频, mvex 含两条 trex）
       + 按解码时间戳交错排列的 85 个 [moof+mdat]（仅修正 mfhd.sequence_number 与 tfhd.track_ID）
```

结果：**媒体数据逐字节完全一致**（已用真实视频做过 SHA-256 逐片段比对），只是把两个轨道装进了一个容器。

### 2. 请求链路

```
扩展页面 (dashboard)
  ├─ GET /x/web-interface/nav              → 登录态 + WBI 密钥
  ├─ GET /x/web-interface/view?bvid=       → 标题 / 封面 / 分P / 合集
  ├─ GET /x/player/wbi/playurl (WBI 签名)  → dash.video[] / dash.audio[] / support_formats
  ├─ GET /x/player/wbi/v2                  → 字幕列表
  ├─ GET comment.bilibili.com/<cid>.xml    → 弹幕
  └─ GET <upos-*.bilivideo.com>/xxx.m4s    → Range 分片并发下载（8 线程）
```

### 3. WBI 签名

`playurl` 等接口要求 WBI 签名，算法为 B 站前端公开实现：

1. `nav` 取 `wbi_img.img_url` / `sub_url` 的文件名，拼成 64 位 lookup
2. 按固定的乱序表 `MIXIN_KEY_ENC_TAB` 重排后取前 32 位 → `mixinKey`
3. 参数按 key 升序、剔除 `!'()*`、urlencode 得到 query
4. `w_rid = md5(query + mixinKey)`，并补 `wts` 时间戳

另外会附带 `dm_img_list / dm_img_str / dm_cover_img_str / dm_img_inter` 指纹参数以降低被风控（-352）概率。

### 4. Referer

CDN 对部分节点要求 `Referer: https://www.bilibili.com/`。扩展通过
`declarativeNetRequest` 静态规则（`rules/referer.json`）对 `*.bilivideo.com`、`*.hdslb.com`、
`*.akamaized.net` 等域名统一注入 Referer 与 UA，因此无论下载还是读取封面都不会 403。

### 5. 大文件与内存

- 下载中间产物放在 **OPFS**（Origin Private File System），而不是内存
- 混流是**流式**的：每次只读 1MB，内存占用与文件大小无关
- 用户通过 `showSaveFilePicker` / `showDirectoryPicker` 选定位置时，直接写入目标文件，省去二次导出

---

## 📁 目录结构

```
Bdown/
├── manifest.json                 MV3 清单
├── rules/referer.json            DNR 静态规则（Referer / UA 注入）
├── _locales/{zh_CN,en}/          国际化文案
├── assets/icons/                 图标
└── src/
    ├── core/                     与 UI 无关的核心逻辑（可单独测试）
    │   ├── md5.js                纯 JS MD5（WebCrypto 不支持）
    │   ├── wbi.js                WBI 签名 + 指纹参数
    │   ├── api.js                B 站接口封装与响应归一化
    │   ├── avbv.js               AV/BV 互转
    │   ├── quality.js            清晰度/编码/音轨元数据
    │   ├── mp4.js                ★ ISO BMFF 解析 + DASH 无损合并
    │   ├── downloader.js         ★ Range 分片并发下载引擎
    │   ├── sink.js               内存 / 文件句柄 / OPFS 落盘目标
    │   ├── engine.js             ★ 任务流水线（解析→下载→混流→落盘→附加内容）
    │   ├── danmaku.js            弹幕 XML → ASS（车道排布）/ SRT / TXT
    │   ├── subtitle.js           字幕 JSON → SRT / ASS
    │   ├── settings.js           设置与命名模板
    │   └── util.js               通用工具
    ├── background/service-worker.js
    ├── content/                  视频页悬浮按钮 + 播放器按钮
    ├── popup/                    解析与选项弹窗
    ├── dashboard/                下载中心（任务队列，长任务在此执行）
    ├── options/                  设置页
    └── ui/common.css             共用设计令牌
```

---

## 🧪 自检

仓库自带一组**不依赖浏览器**的校验脚本，可在 CI 或本地直接运行：

```bash
node tools/validate.mjs            # ① JS 语法 + JSON + manifest 引用 + DNR 规则 + 模块导入图
node tools/selftest-synthetic.mjs  # ② 合成 DASH 流跑一遍混流器（无需任何素材）
node tools/smoke-api.mjs           # ③ 真实接口：WBI 签名 / playurl / CDN Range / 弹幕字幕
node tools/smoke-pipeline.mjs BV1GJ411x7h7 16   # ④ 完整流水线：取流 → 下载 → 混流 → 校验
node tools/mux-test.mjs video.m4s audio.m4s out.mp4  # ⑤ 用你自己的 m4s 验证混流
```

校验内容：媒体片段 SHA-256 逐个一致、moov 轨道数与 handler、mvex/trex、mfhd 序号连续、
tfhd track_ID、tkhd flags、trun data_offset 落在 mdat 内。

> 实测记录（360P，213 秒视频）：14.02 MB 下载 1.67s（5.3 MB/s，8 线程），
> 混流 12 ms，85 个片段的媒体数据 SHA-256 全部一致。

---

## ⚠️ 已知限制

- **不支持直播流**（`live.bilibili.com`）与付费课程（`cheese`）的部分内容
- 港澳台等地区限定内容取决于你的网络出口
- 输出为 **fragmented MP4**：Chrome/Edge/VLC/mpv/ffmpeg/PotPlayer 均正常；Windows 自带播放器
  与个别老式剪辑软件可能不识别，如需传统 MP4 可用 ffmpeg 快速重封装：
  `ffmpeg -i out.mp4 -c copy final.mp4`
- 弹幕 ASS 为近似还原（车道排布、滚动时长按通用规则估算），不保证与网页播放器像素级一致
- 请勿把并发分片数调得过高（>16），容易被 CDN 限速甚至触发风控

---

## 📄 许可

[MIT](LICENSE)
