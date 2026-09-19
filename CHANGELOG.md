## [1.4.3] - 2026-09-19

### 新增：章节（chapters）保存

BBDown 有「自动合并音频+视频流+字幕流+**章节信息**」，我们没有。调研后发现
章节数据其实是**白送**的：

- 数据源：`/x/player/wbi/v2` → `data.view_points[]`
- **我们本来就在调这个接口取字幕**，所以取章节是零额外请求
- 实测（无章节的视频）：`view_points: []`；有章节时元素形如 `{ from, to, content }`

**实现**：
- 新增 `src/core/chapters.js`（纯函数）：
  - `parseViewPoints()` —— 兼容 `{from,to,content}` / `{start,end,title}` / `{time,text}` 三种写法，
    自动排序、补全 `end`（用下一条的 start，最后一条用总时长）、脏数据丢弃不崩
  - `chaptersToTxt()` —— YouTube 风格 `0:00 标题`
  - `chaptersToVtt()` —— WebVTT 章节轨（PotPlayer / mpv / VLC 可识别）
- `fetchExtras` 里**字幕与章节共用一次 `playerV2` 请求**（原本各调一次会浪费）
- 选项页新增「保存章节」开关 + 章节格式（txt / vtt）下拉
- 默认**关闭**（与字幕、封面一致，不产生意外文件）

### 测试

- 新增 `tools/test-chapters.mjs`（37 项），已接入 CI：
  输入容错（10 种脏输入）、三种字段名兼容、排序与 end 补全、时间戳格式、txt/vtt 导出、空输入
- CI 自检 **12 个套件**：validate 21 + core 57 + api 21 + resume 63 + resume-store 26 +
  routing 9 + quality-pick 14 + chapters 37 + lint-noundef + e2e 29 + synthetic + package

### 已知局限

- `view_points` 的真实字段结构**未在真机确认**（B 站未公开文档）。我们兼容了社区常见的三种写法，
  若实际字段不同，`parseViewPoints` 会静默返回空数组 → 不生成文件，不会崩。
  需要用一个**确实有章节**的视频验证一次。

## [1.4.2] - 2026-09-19

### 🔴 根治「非会员只下到 360P」—— 前三次修复都没触达病根

之前我们把 `qn` 从 127 → 80 → 0 改了三次，**全都改错了地方**。实测：

```
传 qn = 不传 / 0 / 80 / 125 / 127  →  dash.video[].id 恒为 [32,32,32,16,16,16]
accept_quality 恒为 [125,116,80,64,32,16]
```

**DASH 下 `qn` 是无效的**（与 B 站文档「DASH 格式时 qn 无效」及 yt-dlp「DASH 路径
完全不传 qn、改在客户端从 `dash.video[].id` 挑」双向印证）。清晰度是**客户端挑出来的**。

真正的 bug 在 `pickVideoTrack`：排序**只看 codec 与 bandwidth，完全没排清晰度**，
于是低清轨只要码率更高就会被选中 —— 这正是下出 360P 的原因。

修复：清晰度作为第一排序键，其次编码偏好，最后码率：
- auto（qn<=0）→ 挑最高可用档
- 指定清晰度 → 挑**不超过**该档的最高档（尊重用户选择）
- 用户明确选 360P 时仍给 360P

### 其他修复

- **课程（pugv）`fnval` 与 yt-dlp 对齐**：原先沿用 ugc 的 4048（含 HDR/4K/杜比/8K 位，
  对 pugv 是否适用从未验证）。yt-dlp 对 pugv 明确写死 **16（只要 DASH）**，已对齐。
- **课程补 `avid` 兜底**：pugv 文档只列了 `avid`（B 站就没写 `bvid`），
  避免"既无 bvid 又无 avid"被本地闸门拦下。
- **新增 `code: -401` 错误映射**：「非法访问（URL 缺少必填字段或内容不可用）」。

### 测试

- 新增 `tools/test-quality-pick.mjs`（14 项），已接入 CI：
  复刻"360P 码率反而更高"的陷阱场景，锁定「清晰度必须优先于码率」；
  含编码偏好、边界（空列表/单轨道/缺 quality 字段）、pugv fnval 断言。
- CI 自检 **11 个套件**：validate 21 + core 57 + api 21 + resume 63 +
  resume-store 26 + routing 9 + quality-pick 14 + lint-noundef + e2e 29 + synthetic + package

### 待办（本轮调研发现，未做）

- **章节（chapters）**：`/x/player/wbi/v2` 返回 `data.view_points[]`，
  我们已在调该接口取字幕，**顺带读即可，零额外请求**（数据源仍需真机确认字段结构）
- **CDN URL 有效期约 120 分钟**：断网重试时如果 URL 已过期，需重新 playurl 再下载

## [1.4.1] - 2026-09-19

### 🔴 P0 修复：默认 merge 模式 100% 失败

`src/core/engine.js` 的 `mergeInto({ vSink: vStage, aSink: aStage })` —— `vStage` /
`aStage` 在 v1.3.1 的 `prepareStage` 重构（改名成 `vPrep` / `aPrep`）时**漏改这两行**。
ES Module 恒为严格模式，读取未声明标识符直接抛 `ReferenceError`。

- **影响**：`downloadMode: 'merge'`（DEFAULT_SETTINGS 默认值）且 `plan.mode === 'dash'`
  时，音视频两轨**下载完成后**才崩 → 任务转 `error`，文案 `vStage is not defined`。
  **即默认配置的每一次下载都必然失败**，一路溜过 v1.3.1 与 v1.4.0 两个发布版本。
- **为什么 CI 全绿**：`tools/validate.mjs` 只做 `node --check`（语法级），**抓不到读取
  未声明变量**；`test-api-validation.mjs` 里两处 `catch (e) {}` 又把异常吞了，断言只
  检查 playurl 发出的 `qn`（在崩溃点之前）。
- **修复**：`vSink: vPrep.sink, aSink: aPrep.sink`。

### 回归防护（防止同类漏改复发）

- **新增 `tools/test-engine-dryrun.mjs`（15 项）**：用桩件（`setFetchImpl` 注入假下载源、
  桩 `chrome.downloads`）真跑 `DownloadEngine.run` 的 merge / separate / audio / durl
  四条分支，断言 `task.status === 'done'` 且不出现 `is not defined`。
  **已做注入验证**：把 `vPrep.sink` 改回 `vStage` → 测试报 `ReferenceError: vStage is not defined`（失败）；
  改回来 → 15/15 通过。已接入 CI。
- **新增 `tools/lint-noundef.mjs`**：零依赖的「未定义标识符」静态检查。设计原则是
  **宁可漏报也不误报**（误报会让 CI 红在无关提交上，工具很快就被关掉）。当前 34 个文件 0 处问题。

### 其他修复

- **课程（pugv）端到端打通**：`engine.js` 之前没把 `spec.cheeseId` 透传给 `api.playurl`，
  v1.4.0 宣称的课程支持在引擎侧根本走不通。已补上，并给 `ensureSpecComplete` 加课程
  分支（用 `/pugv/view/web/season?ep_id=` 反查 cid）。**注：课程接口通常需登录且为付费内容，未真机验证。**
- **`sanitizeFilename` 实测确认没问题**（不采纳"传 null 会抛 TypeError"的说法）：
  `null` / `undefined` / `''` → `"untitled"`；`../../etc/passwd` → `_.._etc_passwd`；
  `CON` → `_CON`；含 RLO 的 `P1‮gp4.exe` → `P1gp4.exe`。
- **移除下载中心的无条件 reload**：`openDashboard` 里 `if (focus) chrome.tabs.reload(tab.id)`
  会在页面刚打开 / 网络抖动 / 离线时把下载中心刷成白屏。下载中心本来就通过
  `chrome.storage.onChanged` 即时接收新任务，**不需要重载**。
- **popup 预览的 qn 从 127 改为 0**（自动），与 engine 一致 —— 否则非会员在解析预览
  阶段就被降级成 360P 预览。
- **`seasonInfo` 传参修正**：B 站的 `/pgc/view/web/season` 同时接受 `season_id` 与
  `ep_id`；之前拿 `spec.epId` 却塞进 `season_id`。已按入参分流。
- **DNR 正则收紧**：`([^/]*\.)?` → `([^/?#]*\.)?`。原先 `https://evil.com?.hdslb.com/x`
  这类 URL 会被 rule 1 命中，导致任意攻击者主机的请求被注入 `Referer: https://www.bilibili.com/`。
- **`onMessage` 加 `sender.id` 校验**：只接受本扩展自己发来的消息。

### 文档

- **新增 `PRIVACY.md`** —— 商店上架的**阻塞项**（v1.0.0 提交时没有）。说明不收集任何数据、
  存了什么（设置/任务/历史/续传进度）、为什么需要每个权限、不存 Cookie/SESSDATA。
- **新增 `docs/DOWNKYI-ANALYSIS.md`** —— 对 `yaobiao131/downkyi` 与 `HanLuo/downkyicore` 的深度分析。

### 测试

新增 21 项（`test-engine-dryrun` 15 + `lint-noundef` 覆盖 34 文件）。**CI 自检 216 项**。

## [1.4.0] - 2026-09-18

> ## ⚠️ 本版本带病发布，请勿使用
>
> **默认下载模式（`downloadMode: 'merge'`）100% 失败。**
> `src/core/engine.js` 的 `mergeInto({ vSink: vStage, aSink: aStage })` 中
> `vStage` / `aStage` 未定义 —— v1.3.1 的 `prepareStage` 重构（改名成 `vPrep` / `aPrep`）
> 漏改了这两行。ES Module 恒为严格模式，运行时直接 `ReferenceError: vStage is not defined`。
>
> **影响**：音视频两轨**下载完成后**才崩，任务转 `error`，已下载的临时文件被丢弃。
> 当时 CI 全绿是因为 `tools/validate.mjs` 只做 `node --check`（语法级），
> **抓不到读取未声明变量**。
>
> **已修于 v1.4.1**（`vSink: vPrep.sink, aSink: aPrep.sink`）。
> 若你装的是本版本，请升级到 v1.4.1 或以上。
>
> 注：`separate` / `audio` / `durl` 三条**不混流**的分支不受影响。


### 新增：对 DownKyi 深度分析后的落地改动

分析了 `yaobiao131/downkyi` 与 `HanLuo/downkyicore` 的真实源码（详见
`docs/DOWNKYI-ANALYSIS.md`），发现三处可落地差异：

1. **课程（pugv / cheese）支持** —— Bdown 之前完全没有这个内容类型。
   DownKyi 源码注释明确写了「**必须有 episodeId，否则会返回请求错误**」，
   这正好解释了我们之前遇到的 code=-400。新增：
   - `api.playurl` 的 `cheeseId` 分支 → `/pugv/player/web/playurl`（必带 `ep_id`）
   - URL 解析：`/cheese/play/ep<id>` 与 `/cheese/play/ss<id>`

2. **番剧 v2 → v1 降级** —— DownKyi 与 sakidown 都用 `/pgc/player/web/playurl`
   （**v1**，只传 cid、不传 ep_id），yt-dlp 用 v2 + ep_id。两种都能通，
   现在 v2 拿到 -400 时自动降级 v1，更稳。

3. **路由三分支明确化**：ugc / pgc / pugv 各自走不同接口与参数。

### 分析报告

新增 `docs/DOWNKYI-ANALYSIS.md`，包含：
- 签名层对比（**与 DownKyi 完全一致，无需改**）
- playurl 参数对比（DownKyi 不用 `otype`/`platform`，但实测去掉后只返
  `v_voucher` 拿不到 DASH —— **不能照抄**）
- 内容类型接口差异表
- 稳定性设计（DownKyi 的 `retry=2`、连接池、超时、可配 UA/代理）
- 安全性/反风控对比（DownKyi 的 `buvid3` 对扩展是 **N/A** —— 浏览器自带
  B 站 cookie，且我们已移除 `cookies` 权限无法自行注入）
- 功能矩阵：哪些能借鉴（课程、番剧降级、弹幕多布局、收藏夹/UP主投稿），
  哪些不能（ffmpeg 工具箱、Aria2、代理/UA 配置 —— 浏览器接管了）

### 测试

- 新增 `tools/test-playurl-routing.mjs`，**9 项**：ugc/番剧/课程三分支路由、
  课程必带 ep_id、番剧 v2→v1 降级真的触发且拿到视频轨、缺 cid 本地拦截。
- 已接入 CI。**核心自检总计 195 项**（21+57+19+63+26+9+合成）。

### 待办（记录，未做）

- `get()` 层网络异常重试（DownKyi `retry=2` 的做法）—— 我们目前只在
  playurl 的 -403/-352/-412 上重试，网络层异常/5xx 不重试
- 收藏夹 / UP 主全部投稿（DownKyi 有对应模块可参考）
- 弹幕多布局算法（DownKyi 的 `DanmakuLayoutAlgorithm`）
- 页面 `window.__playinfo__` 抓取降级 —— 实测 B 站现在是客户端渲染，
  SSR HTML 里没有，需浏览器验证 JS 执行后是否存在

## [1.3.1] - 2026-09-18

> ## ⚠️ 本版本带病发布，请勿使用
>
> **默认下载模式（`downloadMode: 'merge'`）100% 失败。**
> `src/core/engine.js` 的 `mergeInto({ vSink: vStage, aSink: aStage })` 中
> `vStage` / `aStage` 未定义 —— v1.3.1 的 `prepareStage` 重构（改名成 `vPrep` / `aPrep`）
> 漏改了这两行。ES Module 恒为严格模式，运行时直接 `ReferenceError: vStage is not defined`。
>
> **影响**：音视频两轨**下载完成后**才崩，任务转 `error`，已下载的临时文件被丢弃。
> 当时 CI 全绿是因为 `tools/validate.mjs` 只做 `node --check`（语法级），
> **抓不到读取未声明变量**。
>
> **已修于 v1.4.1**（`vSink: vPrep.sink, aSink: aPrep.sink`）。
> 若你装的是本版本，请升级到 v1.4.1 或以上。
>
> 注：`separate` / `audio` / `durl` 三条**不混流**的分支不受影响。


### 新增：断点续传的持久化层（OPFS）

- **`src/core/resume-store.js`**
  - `resumeKey({bvid/aid/cid/epId, quality, codec, track})` —— 由**内容身份**
    派生 key。**刻意不含 URL**：CDN 地址每次 playurl 都会换，但内容字节不变，
    拿 URL 当身份会导致续传永远命中不了。
  - `canResume(meta, expectedSize, {ttlMs})` —— 清单校验，必须同时满足：
    size 完全一致（换清晰度 / CDN 内容变了都不续）、没过期（默认 7 天）、
    已完成区间有效、且**真的没下完**（下完就不该走续传路径）
  - `ResumeStore`（OPFS）：`<key>.part` 存部分内容 + `<key>.json` 存清单。
    `FileHandleSink.open()` 本来就用了 `createWritable({keepExistingData:true})`，
    重开不会清空已有字节 —— 天然支持续传
  - 每个方法都不抛异常（读不到 / 写失败都返回 null / false），避免续传问题
    反而把正常下载搞挂

- **接线**：
  - `DownloadEngine.prepareStage()` —— 开启续传时用持久分片替代临时文件
  - `fetchTo` 支持 `resume` 参数，随分片完成增量写清单；成功下载完清掉清单；
    用户取消时**保留**清单（这才叫续传）；回退顺序下载时清掉（会重下整个文件）
  - `downloadRanged` 的 `onProgress` 新增 `range` 字段（最近完成的分片区间），
    让上层能精确记账

- **设置**：`resumeEnabled`，**默认 false**。选项页有开关（标注「实验性」）。
  浏览器端行为没法在 CI 里验证，所以默认关；出问题关掉即可，不影响主流程。

### 测试

- 新增 `tools/test-resume-store.mjs`，**26 项**，全部不联网：
  - key 派生（含"不含 URL"、清晰度/轨道/cid 区分度、缺 cid 返回空、codec 特殊字符清洗）
  - 清单校验（大小不匹配 / 过期 / 空区间 / 已下完 等 10 种拒绝场景 + 4 种通过场景）
- 已接入 CI。**核心自检总计 186 项**（21 + 57 + 19 + 63 + 26 + 合成自检）。

## [1.3.0] - 2026-09-18

### 新增：断点续传（底层能力）

- **`src/core/resume.js`：纯逻辑层**（不碰网络、不碰存储，可在 CI 完整验证）
  - `mergeRanges` —— 合并重叠**与相邻**区间（相邻不合并会产生大量 1 字节碎片）
  - `missingRanges(total, done)` —— 已下载区间 → 还缺哪些区间
  - `completedBytes` / `addRange` / `isComplete` / `toChunks`
  - `serialise` / `deserialise` —— 带容错的持久化（脏 JSON 不抛异常）

- **`downloadRanged` 接线**：新增 `resumeRanges` 选项（已完成区间，半开 `[start, end)`）。
  不传时行为与之前**完全一致**（零回归）；传了就只下载缺失部分。
  已下字节计入进度但**不计入瞬时速度**（否则首 tick 会虚高）。

- **`downloader.js` 新增 `setFetchImpl()`**：允许注入 fetch，使下载器可单测，
  不再依赖真实网络。

### 修复：`MemorySink.blob()` 不处理空洞 / 重叠 / 乱序

原实现只是 `sorted.map(r => r.bytes)` 拼接 —— 顺序下载时恰好正确，
但**断点续传一定会踩到**（写入顺序与偏移不一致、重试产生重叠、未下区间是空洞）。
改为按最终 `size` 建缓冲区逐条写入：后写覆盖先写，未覆盖处补 0。

同时给 `writeAt` 加入参防御（非 `Uint8Array` 视为空）——曾因此出现
`size` 变 `NaN`、产物多出 1 字节的怪象。

### 测试

- 新增 `tools/test-resume.mjs`，**63 项**，全部不联网：
  - 区间合并 / 缺失计算 / 切分 / 序列化（含脏数据容错）
  - 10MB 文件的端到端模拟（下完 3MB → 余 7MB → 切 7 片）
  - **集成**：用假 fetch 验证 `downloadRanged` 只请求缺失的 512 字节（不是 1024）
  - **零回归**：不传 `resumeRanges` 时全量下载
  - `MemorySink` 的空洞 / 重叠 / 乱序 / 入参防御
- 已接入 CI。**核心自检总计 139 项**（57 + 19 + 63）。

### 未完成

- 断点续传的**持久化层**（把进度存到 OPFS / IndexedDB）还没做 ——
  目前 `resumeRanges` 需要调用方自己提供。下一步：任务中断时落盘进度，
  重启后自动恢复。

## [1.2.3] - 2026-09-18

### 修复：自动清晰度按账号状态挑选（VIP-aware）

你给出了清晰的 B 站清晰度规则：

| 账号状态 | 最高可用清晰度 |
|---|---|
| 大会员 | 全部（8K / 4K / HDR / 1080P60 / 1080P+ 高码率） |
| 已登录非会员 | **1080P 30 帧（非高码率，qn=80）** |
| 少数限免影片 | 满血清晰度（B 站自己放行） |
| 未登录 | 720P 准高清（qn=64） |

之前 `api.playurl` 默认 qn=127，对已登录非会员会发超出权限的 qn，B 站对超权限
qn 的响应是**整份清晰度清单降级为 360P 预览**——这就是你拿到 360P 的根因。
v1.2.2 改成 qn=0 也不对（实测 qn=0 时 `accept_quality` 为 null）。

修复：`api.playurl` 在调用方传 qn=0 / 不传时，按 `account.vip` 自动挑：

```js
const resolvedQn = qn > 0 ? qn : (account && account.vip ? 127 : (logged ? 80 : 64));
```

调用方显式选清晰度（如 popup 选了 1080P+）时透传，不被覆盖。

### 测试

- `test-api-validation.mjs` 18 → 19 项：新增 VIP-aware qn 三档（大会员 127 /
  非会员 80 / 未登录 64）。
- 核心自检总计 **76 项**（57 + 19）。

## [1.2.2] - 2026-09-18

### 修复：自动清晰度默认 qn 改为 0（让 B 站按用户权限挑）

用户的反馈：「自动清晰度居然只下载 360P 而不是正在播放的 1080P」。

排查：
- 用户的视频是 B 站大会员纪录片
- 扩展 nav 显示 `vip: false`（非大会员）
- engine.run 旧逻辑：`qn: spec.quality || settings.defaultQuality || 127`，
  `settings.defaultQuality=127`（VIP 顶级），于是对非大会员用户发了 qn=127
- B 站对大会员视频 + 非大会员用户 + qn 超过其权限的组合，**降级到 360P 预览**
- popup 的清晰度选项也只有 360P（标记「需大会员」），自动选了它

修复：
- `settings.defaultQuality` 从 `127` 改为 `0`（自动 → 让 B 站按用户权限挑最好的）
- engine.run：`qn: spec.quality > 0 ? spec.quality : 0`（popup 显式选了某清晰度就透传，否则发 0 让 B 站决定）

popup 已经有 `需大会员：720P 高清、1080P 高清…` 提示元素（`qualityHint`），
不需要再改 UI。

### 测试

- `test-api-validation.mjs` 16 → 18 项：新增 2 项验证 engine.run 在
  `spec.quality=0` 时发 `qn=0`，在 `spec.quality=80` 时透传 80。
- 核心自检总计 **75 项**（57 + 18）。

## [1.2.1] - 2026-09-18

### 🔴 找到 -400 的**真正**根因：任务 spec 缺 cid（分P 标识）

前几轮的 Origin/WAF 结论也不完全对——但顺着那条线做实测穷举，终于摸到真因。
用 curl 对 `BV16s7b68EEz` 穷举 cid 取值：

```
bvid + cid=39386548303（正确） → code:0
bvid + cid=1（存在但不匹配）   → code:-404「啥都木有」
bvid + cid=（空）              → code:-400「请求错误」  ← 用户报的错
bvid + 完全没有 cid             → code:-400「请求错误」  ← 用户报的错
bvid + cid=undefined（字符串）  → code:-400「请求错误」
```

**B 站对「缺 cid」和「BV 不存在」返回的是同一个 -400**，所以之前无论怎么改
错误信息都指向错误方向。

**cid 为什么会丢**：`src/content/content.js:113` 的悬浮按钮 / 播放器按钮
只做 URL 解析：

```js
const spec = parseVideoFromUrl(location.href);   // → { bvid, pageIndex }
chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD',
  payload: { tasks: [{ ...spec, sourceUrl, isBatch: false }] } });
```

`parseVideoFromUrl` 返回的是 `{ bvid, pageIndex }`，**没有 cid**。这个裸 spec
直接进队列 → `engine.run` 调 `api.playurl({cid: undefined})` → `signParams`
遇到 undefined 会 `continue` 跳过 → 请求里根本没有 cid → **-400**。

两个独立信号互相印证：
1. dashboard 任务标题显示 `BV16s7b68EEz`（兜底逻辑是
   `spec.title || spec.info?.title || spec.bvid`，说明 spec 连 title/info 都没有）
2. 接口返 -400（说明 cid 缺失）

### 修复

- **新增 `ensureSpecComplete(spec, api)`（engine.js）**：`engine.run` 在调
  playurl 前，若 `spec.cid` 缺失且有 bvid/aid，先用 `/x/web-interface/view`
  把 cid 补上，顺带补齐 title / cover / info.pages / totalPages。
  已有 cid 时跳过，零额外请求。
- **`api.playurl` 缺 cid 时本地报错**：不再静默发出没有 cid 的请求，直接抛
  「任务缺少 cid（分P 标识），无法请求播放地址。请回到视频页面重新点一次下载，
  或在下载中心删除该任务后重新添加。」
- **任务标题不再显示 BV 号**：`engine.run` 补完 spec 后同步刷新 `task.title`。

### 测试

- `test-api-validation.mjs` 10 → 16 项（重写了文件，原来场景 8 误落在
  `process.exit` 之后从未执行）：
  - playurl 缺 cid → 本地抛错且不打到 playurl
  - `ensureSpecComplete` 补全 cid / title / info.pages，且已有 cid 时跳过请求
  - HTTP 412 + HTML → 报「被 B 站风控拦截」并提示 Origin 原因
  - DNR Origin 规则 4 项
- **核心自检总计 73 项**（57 + 16），全部不联网。

## [1.2.0] - 2026-09-18

### 🔴 找到 -400 的真正根因：B 站 WAF 只放行 Origin 为 bilibili.com 的请求

用户给的真 BV `BV16s7b68EEz`（在 B 站**真实存在**，aid=116808682048293，
标题「兔子！有空拍个视频吗？」）依然 -400。这次用 `curl` 穷举 Origin 拿到铁证：

| 请求带的 Origin | HTTP | 结果 |
|---|---|---|
| `https://www.bilibili.com` | 200 | `code:0` ✅ |
| 无 Origin | 200 | `code:0` ✅ |
| `https://example.com` | 403 | WAF HTML 错误页 |
| `chrome-extension://abcdefg` | **412** | WAF HTML「出错啦! - bilibili.com」 |

**B 站的 WAF 会拦截 Origin 为 `chrome-extension://...` 的请求。**
而 Chrome 的 `fetch()` 把 `Origin` 列为 forbidden header —— JS 无法设置，
扩展页发起的跨域请求必然携带 `Origin: chrome-extension://<id>`，所以**一定被拦**。

这也解释了为什么我前几轮用 curl / Node 怎么测都是 `code:0`：那两种环境里
`Origin` 是我手动设的（或根本没发），压根没走到浏览器那条路径。

### 修复

- **`rules/referer.json` 新增 id 3 / id 4**：用 DNR 在网络层覆写 Origin
  - id 3（priority 5）：`api.bilibili.com` → `Origin: https://www.bilibili.com`
  - id 4（priority 4）：其他 `*.bilibili.com` / `b23.tv` → 移除 Origin
  - DNR 在网络栈改头，**不受 fetch 的 forbidden-header 限制**（这正是我们
    一直在用 DNR 设 Referer 的原因）。Chrome 官方文档：`append` 才受白名单
    限制，`set` / `remove` 不受限（示例里甚至能 remove `cookie`）。
  - **优先级必须 3 > 4**：id 4 的 `([^/]*\.)?bilibili\.com` 也会匹配
    `api.bilibili.com`，同优先级时规则顺序在 Chrome 里是未定义行为。
- **`api.get` 识别 WAF 拦截**：状态码 412/403 或 content-type 为 `text/html`
  时，给出明确提示「被 B 站风控拦截（HTTP xxx）。扩展页的请求会带
  Origin: chrome-extension://...，B 站只放行 ... 请确认 DNR 规则已生效并
  重新加载扩展」，而不是含糊的「响应不是合法 JSON」。

### 测试

- `test-api-validation.mjs` 5 → 9 项：新增 DNR Origin 规则的 4 项校验
  （存在 Origin 规则 / api.bilibili.com 有 set / set 优先级严格高于 remove /
  Origin 值必须是 `https://www.bilibili.com`）。
- **核心自检总计 66 项**（57 + 9），全部不联网。

### 待验证

- DNR 能否作用于「扩展页自己发出的请求」需你在浏览器确认。若无效，
  备选方案是把 API 调用改由 bilibili.com 页面里的 content script 发起
  （content script 的 Origin 天然是 `https://www.bilibili.com`）。

## [1.1.3] - 2026-09-18

### 修复

- **🔴 第三次 -400：把「请求参数错误」变成有诊断价值的信息**
  用户第三次截图 BV `BV1TeU6aEct`（合法格式，含 base58）依然 -400。我前面
  两轮都在改「正则过宽」和「缺少 bvid/avid」，但**真正的真因**是：

  ```
  $ curl /x/web-interface/view?bvid=BV1TeU6aEct
  -400 「请求错误」       ← B 站 view 接口自己也返 -400
  $ curl /x/web-interface/view?bvid=BV1LAeP64EaM
  0 OK aid=117280994297713 ← 真存在的 BV 正常返回
  ```

  也就是 `BV1TeU6aEct` **在 B 站就不存在**（可能用户手输的测试 BV / 已删除 / 上传者撤回）。

  前两轮把扩展的全部 BVID 都拒了也会出事（用户用真 BV 也下不了），所以这不是
  「把所有 -400 拦下」能解决的——只能让错误信息更可读。

- **`api.get` 的 -400 错误现在带具体诊断**：
  - 请求里没有任何 bvid/avid/ep_id（本地预校验已拦）→ 提示「请求缺少视频标识」
  - 请求里带了 id 但 B 站仍 -400 → 把 id **原文**写进错误，并提示「该 BV 在 B 站不存在或已删除 / 也可能是网络被拦截 / 请到控制台查看完整 URL」
  - 完整请求 URL 在 `error.url` 里，方便用户到 `chrome://extensions` 的
    service worker console 排查

### 测试

- `test-api-validation.mjs` 4 → 5 项：新增「B 站 -400 + bvid → 错误消息点名该 BV」。
- **核心自检总计 62 项**（57 + 5），全部不联网。

### 未完成（待用户确认）

- 用户截图里的 `BV1TeU6aEct` 究竟从何而来？popup 不会生成假 BV；可能是：
  - 用户在「手动输入」框手输测试字符串
  - 旧 v1.1.0 的 pendingTasks 残留（在 dashboard 重启时被 retry 拉起来）
  - 别的入口（收藏夹 / 历史等未实现的解析）误触发
  建议在 dashboard 加一个「清理无效任务」按钮或自动过滤 BVID 不合法的任务。
- bilibili-API-collect 的 fnval 8192 仍是间接证据。

## [1.1.2] - 2026-09-18

### 修复

- **🔴 用户复现的 -400「请求参数错误」真实根因**：task spec 缺少 bvid / avid / ep_id 时悄悄打到 B 站
  用户第二次截图用了合法格式的 BV1LAeP64EaM（不含 I，我的 v1.1.1 正则过宽修正帮不上），但我之前没找到真因。真机对 4 种参数组合穷举后定位：
  ```
  bvid+avid+qn+fnval            | code: 0
  try_look=1                    | code: 0
  avid=117280994297713（大 aid） | code: 0
  bvid + avid 同时              | code: 0
  无 bvid/avid                   | code: -400「请求错误」
  ```
  也就是说只要请求里没有任何视频标识，B 站就返回 -400。

  在浏览器场景里触发这条的具体路径：popup.js 构建 spec 时 info.bvid 可能是空串（部分番剧没有 bvid、或 title 字段异常），task 照样被加进队列，引擎收到空 spec → 调 api.playurl({bvid: '', aid: undefined, epId: undefined, ...}) → if (bvid) ... else if (aid) 两边都空 → 请求里没有 bvid/avid/ep_id → -400。

- **api.get 本地预校验**：调 playurl/view 类接口时，先检查 params 是否含 bvid/avid/ep_id/season_id 中任一标识。空则直接抛 BiliError(-400, '请求缺少视频标识（bvid / avid / ep_id），任务规格可能不完整', url)，不发请求。
- **BiliError 自定义 message 优先**：原实现里 ERROR_MESSAGES[-400] = '请求参数错误' 会覆盖自定义 message；改为「传入 message 则用 message」，避免本地主动抛的具体提示被默认文案掩盖。
- **headers 增强**：用桌面浏览器 UA（Edg/126.0.0.0）+ Origin: https://www.bilibili.com 替代浏览器默认 UA。证据：stevenjoezhang/bilibili-downloader 与 wu529778790/parse.shenzjd.com 的 WBI 实现都显式设置这三件套，避免被 B 站来源校验拒。

### 新增

- tools/test-api-validation.mjs：4 项预校验自检（无 id 拦截、有 bvid 放行、只 ep_id 放行、view 接口也拦截）。已接入 CI。

### 测试

- selftest-core.mjs 57 项 + test-api-validation.mjs 4 项 = 61 项核心自检，全部 CI 可运行、不联网。

### 未完成（待用户确认）

- 真实任务规格何时会出现 bvid/avid/ep_id 都缺？需要在 popup / dashboard 加更友好的提示「该视频缺少标识，请重新打开视频页面或重试」——下次类似问题可一次锁定。
- bilibili-API-collect 的 fnval 官方位定义仍是 404，8192 位的语义靠 yt-dlp 间接证据，未直接证实。

# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.1] - 2026-09-18

### 修复

- **🔴 「请求参数错误（code -400）」的根因**：BV 号正则过宽
  旧 `/^BV[0-9A-Za-z]{10}$/` 只检查「12 个字母数字」，把含 `I` / `0` / `O` / `l`
  的伪造号（人眼易混的字符）也判为合法 → 打到 B 站 → 接口返回 `-400`「请求错误」。
  截图里的 `BVITX…KE9J` 正含 `I`，正中此坑。
  新正则按 B 站 BV 生成器的实际字符集收紧到 `^BV1[base58]{9}$`，
  字符表 `fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF`（58 字符，
  排除 `0`/`O`/`I`/`l`），与 `bv2av` 用的 TABLE 完全一致。`isBvid` / `bv2av` /
  `content.js parseVideoFromUrl` 三处同步更新。

### 变更

- `playurl` 的 `platform` 从 `'pc'` 改为 `'web'`。值等都能拿到正常响应，
  但 B 站近年对 `pc` 的支持不稳定，yt-dlp 全部用 `'web'`，照齐以减少 -400 概率。

### 测试

- `selftest-core.mjs` 新增 `[7] BV 号严格校验`（9 项）：合法 BV 通过、含
  `I`/`O`/`0`/`l` 的伪造号被拒、过短被拒、长度错误被拒、非 `BV1` 前缀被拒、
  `bv2av` 对伪造 BV 抛错。自检 48 → **57 项**。

### 验证

- 真机对 4 个真实 BV（`BV1xx411c7mD` / `BV1GJ411x7h7` / `BV1ws411c7BY` /
  `BV1mx411M7LA` 等）调 `/x/player/wbi/playurl`：三种 platform 变体（web / 极简 / pc）
  均 `code:0`，证实本轮问题不在 WBI / fnval / 编码器语义，而是客户端校验放过非法 BV。

## [1.1.0] - 2026-09-18

### 新增

- **「仅音频」下载模式**（`downloadMode: 'audio'`）
  此前只有 `merge | separate | durl` 三种，缺竞品标配的纯音频下载。
  B 站的音轨本身就是 fragmented MP4，直接落盘为 `.m4a` 即可播放，**无需重封装或转码**。
  popup 与选项页均已加入入口；`buildPlan` 在此模式下不下视频轨，且纯音频投稿（无视频轨）也能正常下载。
- **`tools/package.mjs`：零依赖打包脚本**
  手写 ZIP（STORE 方式，不依赖系统 `zip` 命令也不用第三方库），产出
  `dist/Bdown-v<version>.zip`，自动排除 `tools/ docs/ .github/ samples/ dist/` 等开发内容，
  打完包回读中央目录自检。CI 里作为 artifact 上传，可直接提交 Edge / Chrome 商店。
  已用 Python `zipfile` 独立验证：CRC 校验通过、37 个条目、排除规则正确。

### 测试

- `selftest-core.mjs` 新增 `[6] buildPlan 下载方式分支`：merge / audio / durl 三种计划的
  轨选择与体积计算，含「纯音频投稿不报错」「merge 缺视频轨必须报错」两个边界。
  自检从 43 项增至 **48 项**。

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
