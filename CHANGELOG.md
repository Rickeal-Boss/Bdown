## [1.4.17] - 2026-09-19

### 🔴 片段扫描：大 moof 被静默丢弃（本项目最危险的失败形态）

**这是本轮最重要的一条。** 由 qa-lead 审计与我自己逐行核对**两条独立来源确认**。

`readBoxHeader` 要求 `offset + size <= limit`，而片段扫描是在 **16KB 的
READ_AHEAD 窗口**里 `listBoxes`。一旦某个 moof 超过窗口：

```
header 解析返回 null → listBoxes 直接 break → 后面所有片段被静默丢弃
```

产出的是**「能播但缺半段」的合法 MP4** —— 文件结构完全正常，播放器不报错，
只是内容少了。真机上极难发现，比崩溃更糟（崩溃至少会被看见）。

**实测前提（不是推测）**：构造 moof = 20088 字节的夹具，在 16KB 窗口下
只能列出 `ftyp, moov` —— **moof 确实被丢了**。修复后 2 个片段都在。

**修复**（`src/core/mp4.js`）：改用「松」的头部读取拿到真实 size，
再**按 size 整块读取**，不再依赖窗口大小。同时修掉同源的另外两个问题：

| 问题 | 修复前 | 修复后 |
|---|---|---|
| moof 超过 16KB | 静默丢弃后续全部片段 | 按真实 size 整块读，不受窗口限制 |
| moov 结束于 16384 之后 | 误报「未找到 moov」 | 同上（顶层扫描同样受益） |
| moof 后面跟的不是 mdat | `mdatSize=0` → **静默丢掉这个片段的 mdat** | 明确报错，并建议改用「音视频分离」 |
| 文件被截断 | 静默补零，产出尾部垃圾 | 明确报「文件不完整」，提示重新下载 |
| `mfhd.sequence_number` | 硬编码 `absStart + 20`（假设 mfhd 是第一个子盒） | 在 moof 子盒里真正找到 mfhd 再定位；找不到就跳过改写 |

### 🔴 durl 多段下载只下第一段（产出截断文件）

`refinePlanSizes` 探测了**所有分段**、`buildPlan` 也返回了完整 `durl` 列表，
但下载时只取 `durl[0]` —— 结果是**只有第一段的截断文件**，
而且进度永远到不了 100%（`totalBytes` 也只按第一段算）。

修复：
- 下载**全部分段**并依次拼接
- 给分片写入加 `writeOffset`：每段写到自己在整个文件里的位置，
  否则第二段会从 0 覆盖第一段
- `buildPlan` 的 `totalBytes` 改为按全部分段求和

### 测试

- 新增 `tools/test-mp4-fragments.mjs`（**8 项**），已接入 CI：
  大 moof 不丢片段 / 截断文件必报错 / 正常文件不受影响
- CI 自检 **20 个套件**（新增片段扫描回归）

### 已知仍存的风险（记录，未处理）

- `readExact` 在源读不满时仍会**补零**而不报错（只在盒子 size 已校验通过的
  路径上才会触发，风险已大幅降低，但没彻底改成抛错）
- `mfhd.sequence_number` 找不到时跳过改写 —— 此时产物序号可能不连续，
  但不会写坏别的字段（这是有意的取舍）

## [1.4.16] - 2026-09-19

### 🔴 NFO：`<title>` 必须有非空兜底（缺它 = 整个 NFO 白写）

产品评审裁决为**发布阻塞**：`<title>` 是 Jellyfin / Kodi 的**必需字段**。
没有它，条目无法入库 —— **整份 NFO 等于白写，而且失败是静默的**
（Jellyfin 不会报错，用户只看到"没刮削到"）。

修复（`src/core/nfo.js`）：
- 回退链 `meta.title || meta.bvid || av{aid} || '未知标题'`
- 回退**用 bvid 而不是 `task.filename`** —— filename 带 `P{n}_{part}` 与清晰度后缀，
  会污染标题（评审员明确指出这点，我原实现没有回退）
- `buildTvShowNfo` 同样加回退链
- 测试加**硬断言**：空输入也必须有 `<title>` 元素且非空
  （只断言"不包含空标签"不算数 —— 缺陷的真实形态是"元素根本不存在"）

### 文本归一化：title 折叠换行，plot 保留换行

- `<title>` 里的换行折叠成空格（Jellyfin 会原样显示，换行让列表错乱）
- `<plot>` **保留**换行（那是正常的段落分隔）
- 两者加了**互锁断言**：确认不是"全折叠"或"全不折叠"，防止一起改坏

### 测试断言收紧（防假阴性）

评审员指出一类病：**只断言"不出现空标签"会正好绕开真实缺陷**（缺陷形态常是
`<x>0</x>` 或 `<x> </x>`，非空标签）。本次把 `[8]` 组所有否定断言
从 `!includes('<x></x>')` 收紧为 `!includes('<x')` —— 即"元素完全不出现"。

这个病在本项目已经出现过三次：
- `vStage`：断言在崩溃点之前，永远通过
- `<runtime>0</runtime>`：断言查空标签，实际是非空标签
- 本次的 `<title>` 缺失：断言查空标签，实际是元素不存在

### 截断顺序固定为「先截断 → 后转义」

已在 v1.4.14 做对，本轮补注释锁住：若改成"先转义再截断"，会在实体中间切断
（`&amp;` 被切成 `&am`），产出**裸 `&`** —— 那是会让整个 XML 解析失败的 P0。
代价是转义后体积可能膨胀（最坏约 5 倍），用罕见的大文件换掉一个潜在 P0，值得。

### 测试

`tools/test-nfo.mjs` 70 → **79** 项（新增 title 回退链 5 项、换行处理 4 项、收紧 5 项）

## [1.4.15] - 2026-09-19

### 🔴 NFO：简介里的控制字符会让整个文件变成非法 XML（P0）

产品评审标为 P0，且是**发布阻塞**：`desc`（视频简介）是自由文本，实测确实含
U+0000..U+0008 / U+000B / U+000C / U+000E..U+001F / U+007F 这类控制字符。

- 它们**不是合法 XML 1.0 字符**
- 后果是**整个 NFO 解析失败**，而 Jellyfin 只会**静默丢弃**该文件
- 用户完全不知道为什么没刮削到 —— 典型的静默失败

修复：`escapeXml()` 改为**先剥离控制字符，再做 5 实体转义**。
（换行 U+000A 与制表 U+0009 是合法 XML 字符，保留。）

> 正则用 `String.fromCharCode` 构造，**不写反斜杠转义** —— 本项目踩过：
> 通过 shell heredoc 写文件时，形如 U+0000 的转义会被解释成真正的控制字符
> 写进源码，直接把文件变成语法错误（v1.4.9 的 util.js 事故）。

### 其余 6 条评审修订

1. **时区**：`pubdate` 改用 `Intl.DateTimeFormat` 固定 `Asia/Shanghai`。
   原来用运行环境本地时区，而 CI 跑在 UTC 上 —— **凌晨发布的视频会差一天**。
2. **截断**：简介截断到 10000 字（B 站简介可达数万字符）。
3. **形态判定**：改为按**视频类型**定（番剧 / 课程 = episode），
   不再按 P 数 —— 原来多P 普通视频会被误判成剧集。
4. **模式门禁**：只在产出**单个完整 mp4** 的 `merge` / `durl` 下生成 NFO。
   `separate` 出的是 `.video.mp4` + `.audio.m4a`（两个都不完整），
   `audio` 出的是 `.m4a`（与 NFO 基名对不上）。
5. 补 `source` / `website` / `uniqueid type="avid"`。
6. 明确**不写 `streamdetails`**（会覆盖 Jellyfin 自己的媒体探测结果）。

### 顺带：互动视频（stein gate）识别

用 `view` 接口的 `rights.is_stein_gate`（**不额外请求**）识别互动视频，
命中时给出明确提示「当前只下载主线（默认分支），分支剧情未包含」，
而不是让用户以为是下载失败。分支展开仍未实现（`/x/player.so` 已 404）。

### 保留的取舍（记录，非遗漏）

- `tvshow.nfo` **未接线**：Jellyfin 要求它位于剧集专属目录，我们输出到平铺目录，
  写一个固定 `tvshow.nfo` 会污染同目录其他内容。函数保留待将来
- `<genre>` 用 B 站分区名（B 站内容没有标准影视分类）
- UP 主放 `<actor>`（Kodi 没有"创作者"对应元素，务实借用）

### 测试

- `tools/test-nfo.mjs` 49 → **63** 项：控制字符剥离、时区跨日、超长截断、
  形态判定、`source`/`website`/`uniqueid avid`、不写 streamdetails

### 🟠 测试夹具修了一个真 bug（独立于 NFO）

`buildFmp4` 手算 `moof` 大小时漏了 `first_sample_flags`(4B) 与 `traf`/`moof`
各自的 8 字节头，**固定少算 20 字节** → 产出的样本 `trun.data_offset` 全部偏小。

自查 `mux-test.mjs` 6 项全过（它没校验这一项），但**独立 Python 解析器**
`tools/mp4check.py` 一跑就报「5 个 trun 全部越界」。

改为**先组装一次量出真实大小，再回填**，不再手算。修完独立解析器全绿。

### 抽取共享测试夹具

`buildFmp4` 之前有 **3 份重复拷贝**（`selftest-synthetic.mjs`、
`test-engine-e2e.mjs`、以及新加的样本生成器）—— 这正是"只有一份被修"的根源。
统一到 `tools/fixtures/fmp4.mjs`，移除 229 行重复。

### CI 新增一条真正会执行的校验

原来有一条 `if [ -d samples ] ... else echo 跳过; fi`，而仓库从无 `samples/`，
**它永远走 else，一直是"跳过的绿"**。现在改为：现场用共享夹具合成样本 →
跑 `mux-test.mjs`（含 SHA-256 逐字节比对）→ 再用独立解析器 `mp4check.py` 复核。

**CI 自检 19 个套件全绿。**

## [1.4.14] - 2026-09-19

### 新增：合集（ugc_season）批量下载

路线图里的「批量入口」一直没做。本轮**先用真接口探路**，再决定做哪个。

**探路结论（重要，决定了路线选择）**：

| 候选 | 实测结果 | 结论 |
|---|---|---|
| UP 主空间批量 | `/x/space/wbi/arc/search` 直接返回 **-352 风控校验失败**。需要 `buvid3` 等浏览器指纹 cookie，而扩展无法注入 | **不可行**，排除 |
| 互动视频分支展开 | BBDown 用的 `/x/player.so` 已 **404**（返回 HTML 错误页），拿不到 `graph_version`，无法枚举分支节点 | **不可行**，排除 |
| 合集（ugc_season） | `/x/web-interface/wbi/view/detail` 的 `ugc_season` 字段，**不受 -352 影响**，随当前视频一起返回 | **可行**，本轮实现 |

> 顺带一个发现：`view` 里有个 `stein_guide_cid` 字段（互动视频的引导 cid），
> 实测它和主 cid 都能取到 DASH 流。这比已失效的 `player.so` 靠谱，留作后续。

**实现**：
- 新增 `src/core/season.js`（纯函数）：`parseUgcSeason()` / `isBatchableSeason()` / `seasonToSpecs()`
- 真实字段结构（实测 BV1Wi4y1k7ed，7 集）：
  `ugc_season.sections[].episodes[]`，每集有 `bvid` / `aid` / `cid` / `title`；
  注意 **`duration` 和封面不在 episode 顶层，在 `arc.duration` / `arc.pic`**，`page` 是对象不是数字
- **定位不了的条目直接跳过**（无 cid 会让 playurl 返回 -400），不给下游制造失败任务
- 只有 ≥2 集才算「可批量」（1 集的"合集"就是普通单视频）
- 弹窗新增「所属合集」区块：显示《合集名》与集数，勾选后按合集逐集建任务
- 拉集合集失败**绝不影响**单视频下载（独立 try/catch + warn）

### 测试

- 新增 `tools/test-season.mjs`（**44 项**），已接入 CI。夹具字段结构来自真实接口实测
- CI 自检 **20 个套件**

### 已知局限

- 弹窗 UI 部分（合集区块渲染 / 勾选逻辑）**CI 测不到**，需真机确认
- 合集里每集的清晰度各自独立挑选（受各自账号权限限制），可能与预期不同

## [1.4.13] - 2026-09-19

### 修 NFO 的 0 值元素（QA 复核发现，Jellyfin 会读成"片长 0 分钟"）

v1.4.12 的 `el()` 只在值为 `undefined` / `null` / `''` 时省略元素，
**`0` 不算空**。而 `runtime` / `season` / `episode` 在拿不到真实值时都是 `0`，
于是会产出 `<runtime>0</runtime>` —— Jellyfin 会把它当成"片长 0 分钟"。

**为什么 v1.4.12 的测试没抓到**：断言写的是「不出现 `<runtime></runtime>`（空标签）」，
而实际产出的是 `<runtime>0</runtime>`（**非空**）—— 断言比需求窄，正好绕开。
这次的根因和 `vStage` 那次是同一类：**断言的形状和真实缺陷的形状不一致**。

修复：`el()` 改用 `isEmpty()`，`0` 与非有限数都视为空。

### 顺带修好的两处

- **代理对被截断**：简介截断时若第 max 个字符是 emoji 的高代理项，会切成半个
  → 末尾出现 U+FFFD（`?`）。现在会先切掉不完整的代理对再补省略号。
- **测试断言的假阳性**：「episode 为 0 时省略」原本写 `!x.includes('<episode')`，
  而根元素 `<episodedetails>` 本身就含子串 `<episode` —— 断言永远为真。
  改成带闭合尖括号的 `'<episode>'`。

### 测试可信度改进：XML 合法性校验不再依赖 DOMParser

原计划用 `DOMParser` 回读产物验证 XML 合法性，但实测 **Node 22 没有 `DOMParser`**
（`new DOMParser()` 抛 `ReferenceError`），那段断言会直接崩、让整个套件挂掉。

改为**零依赖的 `xmlProblems()`**（在测试文件内），检查三件事：
XML 1.0 非法控制字符、未转义的裸 `&`、`movie`/`episodedetails`/`tvshow`/`actor` 标签配平。
同时保留"有 DOMParser 就额外跑一遍"的分支，环境具备时自动增强。

> 也正因为如此：**即便有解析器，也要先做轻量校验** —— 不同实现对控制字符的
> 判定不一致（有些会在解析前静默剥离），只靠 `parsererror` 可能放过真正会被
> Jellyfin 拒掉的字符。

### NFO 模式门禁补了反向用例

`test-engine-e2e` 现在带 `saveNfo: true` 跑四种模式，断言 NFO 数：
`merge: 1 / durl: 1 / separate: 0 / audio: 0`。
**那两个 0 是关键** —— 只有"不该产时必须为 0"的用例存在，才真正锁住了门禁。
（原来只有"该产时产"的正向用例，门禁被删掉也不会红。）

### CI 自检（19 个套件，全绿）

test-nfo 63 → **70** 项；test-engine-e2e 29 → **33** 项。

## [1.4.12] - 2026-09-19

### 按产品评审意见修正 v1.4.11 的 NFO 实现

评审员（gstack-product-reviewer）给了 7 条修订，其中 **1 条是 P0**：

| 评审意见 | v1.4.11 的问题 | 处置 |
|---|---|---|
| **P0：`desc` 必须剥离控制字符** | 只做了 5 实体转义。控制字符**不是合法 XML 1.0 字符**，会让整个 NFO 解析失败，而 Jellyfin 只会**静默丢弃**——用户完全不知道为什么没刮削到 | 剥离 U+0000-0008 / 000B / 000C / 000E-001F / 007F（保留换行与制表符，它们是合法 XML 字符） |
| `pubdate` 按 **Asia/Shanghai** 格式化 | 用的是运行环境本地时区。CI 跑在 UTC 上，**凌晨发布的视频会差一天** | 改用 `Intl.DateTimeFormat` 指定 `timeZone: 'Asia/Shanghai'` |
| 超长简介截断 | 无，数万字符全塞进 NFO | 截断到 10000 字（带省略号） |
| 形态按**视频类型**定 | 按 `pages.length > 1` 判 episode，多P 普通视频被误判成剧集 | 只有番剧 / 课程（`epId`/`seasonId`/`cheeseId`）才是 episode，普通视频（含多P）一律 movie |
| `separate` / `audio` 模式不产 NFO | 所有模式都产。separate 出的是 `.video.mp4` + `.audio.m4a`，两个都不完整 | 只在产出**单个完整 mp4** 的 `merge` / `durl` 模式下生成 |
| 补 `source` / `website` / `uniqueid type="avid"` | 缺失 | 已补（`website` 回链原视频，便于 Jellyfin 识别来源） |
| **不写 `streamdetails`** | 未涉及 | 明确不写——会覆盖 Jellyfin 自己的媒体探测结果 |

### 顺带：互动视频（stein gate）识别

采纳评审员「低成本替代方案」：从 `view` 接口的 `rights.is_stein_gate`（**不额外请求**）
识别互动视频，命中时明确 warn「当前只下载主线（默认分支），分支剧情未包含」，
而不是让用户以为是下载失败。分支展开（`/x/stein/edgeinfo_v2`）仍未实现。

### 已知保留的取舍

- `tvshow.nfo` **未接线**：Jellyfin 要求它位于剧集专属目录，而我们输出到平铺目录，
  写一个固定 `tvshow.nfo` 会污染同目录其他内容。函数保留，待将来「按番剧建子目录」
- `<genre>` 用 B 站分区名（非标准影视分类）—— B 站内容没有标准分类
- UP 主放 `<actor>` —— Kodi 没有"创作者"对应元素，务实借用

### 测试

- `test-nfo` 49 → **63** 项：新增控制字符剥离（5 项）、超长截断（6 项）、
  北京时区跨日（1 项，UTC 会差一天）、`source`/`website`/`uniqueid avid`（3 项）
- CI 自检 **19 个套件**全绿

## [1.4.11] - 2026-09-19

### 新增：NFO 元数据（Jellyfin / Kodi / Emby 媒体库归档）

继章节（chapters）之后，补上媒体库归档的另一半：下载时附带生成 NFO 文件，
下载目录可被 Jellyfin 直接刮削成条目（标题、简介、封面、UP 主、发布日期、时长）。

**设计要点**：
- 纯函数模块 `src/core/nfo.js`，**零额外网络请求** —— 用的都是 `/x/web-interface/view`
  已经返回的字段（本轮把 `desc` / `pic` / `tname` / `tid` 补进了 `spec.info`）
- **缺字段就省略该元素**，不写空标签（Jellyfin 对空值容忍度差）
- 所有文本走 `escapeXml` —— B 站标题/简介里确实有 `&` 和引号
- 两种形态：`movie`（普通单P）与 `episode`（番剧 / 多P，带 season + episode）
- 文件名与媒体文件同基名（`xxx.mp4` + `xxx.nfo`），多P 不会互相覆盖
- **默认关闭**（与弹幕/字幕/封面/章节一致，不产生意外文件）

**字段映射**：title / desc / pubdate / duration / pic / owner.name / tname / bvid
→ `<title>` / `<plot>` / `<premiered>+<year>` / `<runtime>`（分钟）/ `<thumb>` /
`<actor>` / `<genre>` / `<id>+<uniqueid type="bilibili">`。

### 测试

- 新增 `tools/test-nfo.mjs`（**49 项**），已接入 CI：
  XML 转义 8 项、日期换算 5 项、时长换算 5 项、movie 形态 12 项、episode 形态 5 项、
  缺字段不写空标签 7 项、tvshow 形态 4 项、文件名约定 5 项
- CI 自检 **19 个套件**

### 已知局限

- NFO 的 `<genre>` 用的是 B 站分区名（如"知识"），不是标准影视分类，
  Jellyfin 可能显示为自定义类型 —— 这是 B 站内容没有标准分类的固有限制
- UP 主放进 `<actor>` 是借用字段（Kodi 没有"创作者"对应元素），属于务实取舍

## [1.4.10] - 2026-09-19

### P0 修 v1.4.9 引入的致命问题：util.js 被真实控制字符写坏

给 warn() 加日志清洗时，脚本里写的转义序列（形如 U+0000）被工具链
**解释成了真正的控制字符（NUL / 0x1F / 0x7F）写入源码**，导致
src/core/util.js 语法错误，所有 import 它的模块全线崩溃
（validate 一度报 22 项检查失败 10 项）。

已重写为用 String.fromCharCode 构造正则，源码里不再出现任何反斜杠转义。
实测：warn 收到含回车的消息时输出可见的 <0x0d> 形式。

### 本轮修复（来自最新一轮 QA 应用层审查）

| 项 | 严重度 | 内容 |
|---|---|---|
| T1 | 严重 | 过期重试在 3/6 调用点未接线（默认 merge 模式的视频轨与音轨都没有）→ 已补齐全部 6 处（d/a/v/a/v/a） |
| T3 | 严重 | 刷新播放地址时丢失 URL query（B 站 m4s 的 ?e=&deadline=&trid= 是必需签参，实测去掉后 4 个域名全失败）→ 新增 withQuery() 兜底 |
| T5 | 严重 | 取消时 pendingTasks 残留（用户取消后关掉下载中心再打开，任务会被重新入队）→ 新增 prunePendingTask() |
| T6 衍生 | 中 | engine 的 this.running 是个只删不增的 Set（死代码）。**更正：本轮未改动，也未新增 cancelTask()，此前 CHANGELOG 表述有误** —— 仅记录为遗留项 |
| T7 | 中 | 点「重试」只重置 5 个字段，残留 errorMessage / phaseText / totalBytes / speed / eta / finishedAt → UI 显示上一轮数据。已全部清掉 |
| F-1 | 中 | FileHandleSink 从不关闭 writable（investigator F9b）→ 已在 `mergeInto()` 读回前用 `closeSinkQuietly()` 关闭两个输入 sink（v1.4.7），并在 v1.4.8 补了 `truncate()`。**更正：本轮并未新增 flush()，实际关闭动作由 close() 完成，此前 CHANGELOG 表述有误** |
| T8 | 低 | 弹窗「复制调试日志」的最后 200 行日志 HTML 输出未做 HTML 转义（视频标题可注入）→ 改用 textContent |
| B-5 | 低 | popup.js 的 updateSummary 里 qualityOpt.label 未转义 → 加 escapeHtml() |

### 未采纳（已核实不成立）

- **T6「取消后 this.running.get(promise) 永久悬挂」**：engine.js 的 this.running
  只是个 Set（且只删不增），不存在 running.get()；取消路径会捕获 DownloadAborted
  并正常返回。未复现，未改动（但顺带把死代码修成了真正可用的登记/释放）。

### 教训（同一坑第三次）

**通过 shell heredoc 写 JS 源码时，反斜杠转义会被解释成真实字符**
（第一次：测试文件里的换行；第二次：测试文件里的换行；第三次：util.js 的控制字符）。
以后写这类代码一律用字符码（String.fromCharCode）或 chr(92) 构造，不要直接写转义。

## [1.4.10] - 2026-09-19

### P0 修 v1.4.9 引入的致命问题：util.js 被真实控制字符写坏

给 warn() 加日志清洗时，脚本里写的转义序列（形如 U+0000）被工具链
**解释成了真正的控制字符（NUL / 0x1F / 0x7F）写入源码**，导致
src/core/util.js 语法错误，所有 import 它的模块全线崩溃
（validate 一度报 22 项检查失败 10 项）。

已重写为用 String.fromCharCode 构造正则，源码里不出现任何反斜杠转义。
实测：warn 收到含回车的消息时输出 <0x0d> 这样的可见形式。

教训（同一坑第三次）：
1. 通过 shell heredoc 写 JS 源码时，反斜杠转义会被解释成真实字符；
   以后这类代码一律用字符码构造。
2. 我把修改直接用 git add -A 提交了，坏版本进了 HEAD，git checkout 救不回来，
   只能手工重写 —— **提交前必须先跑静态校验**。

### 本轮修复（来自 QA 应用层审查 + 排障手）

| 项 | 内容 |
|---|---|
| T3 | 刷新播放地址时丢失 URL query。B 站 m4s 的 ?e=...&deadline=...&trid=... 是必需签参（QA 实测去掉后 4 个域名全部失败）。新增 withQuery()：新地址不带 ? 时用旧地址的 query 补上 |
| B-5 | popup.js 的 updateSummary() 里 qualityOpt.label 未转义 -> 加 escapeHtml() |
| T5 | 取消/完成/失败后 chrome.storage 的 pendingTasks 条目未清理 -> 关掉下载中心再打开会被重新入队。新增 prunePendingTask()，在 startTask 的 finally 按 cid + pageIndex 清理 |
| T7 | 点「重试」只重置 5 个字段，残留 errorMessage / phaseText / totalBytes / speed / eta / finishedAt -> UI 显示上一轮数据。已全部清掉 |
| T8 | warn() 把控制字符转成可见的 <0x0d>，避免 B 站返回内容里的回车把 DevTools 日志截断覆盖 |

### 未采纳（已核实不成立）

- T6「取消后 this.running.get(promise) 永久悬挂」：engine.js 的 this.running
  只是个 Set（且只删不增），不存在 running.get()；取消路径会捕获
  DownloadAborted 并正常返回。未复现，未改动。

## [1.4.10] - 2026-09-19

### P0 修 v1.4.9 引入的致命问题：util.js 被控制字符写坏

给 `warn()` 加日志清洗时，我在脚本里写了形如 U+0000 的转义序列，
**被工具链解释成了真正的控制字符（NUL / 0x1F / 0x7F）写进源码** —— 于是
`src/core/util.js` 变成语法错误文件，所有 import 它的模块全线崩溃。

已重写为用 `String.fromCharCode` 构造正则，源码里不出现任何反斜杠转义：

```js
const ctrl = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
  'g',
);
return a.replace(ctrl, (ch) => '<0x' + ch.charCodeAt(0).toString(16).padStart(2, '0') + '>');
```

**教训（同一个坑第三次）**：通过 shell heredoc 写文件时，反斜杠转义序列会被
解释成真实字符。**写 JS 源码时避免在脚本里出现反斜杠转义，改用字符码构造。**

### 本轮其余修复

| 项 | 内容 |
|---|---|
| T3 | 刷新播放地址时**丢失 URL query**。B 站 m4s 的 `?e=...&deadline=...&trid=...` 是必需签参（QA 实测去掉后 4 个域名全部失败）。现在新地址若不带 `?`，用旧地址的 query 补上 |
| B-5 | `popup.js` 的 `updateSummary()` 里 `qualityOpt.label` 未转义 → 已加 `escapeHtml()` |
| T5 | 取消 / 完成 / 失败后，`chrome.storage` 的 `pendingTasks` 里对应条目未清理 → 关掉下载中心再打开会被重新入队。已在 `startTask` 的 `finally` 里按 `cid + pageIndex` 清理 |
| T7 | 点「重试」只重置了 5 个字段，残留 `errorMessage` / `phaseText` / `totalBytes` / `speed` / `eta` / `finishedAt` → UI 会显示上一轮的数据。已全部清掉 |
| T8 | `warn()` 现在把控制字符转成可见的 `<0x0d>`，避免 B 站返回内容里的回车把 DevTools 日志截断覆盖 |

### 未采纳（说明）

- **T6「取消后 `this.running.get(promise)` 悬挂」**：`engine.js` 里的 `this.running`
  只是个 `Set`（且只删不增），不存在 `running.get()`；取消路径会捕获
  `DownloadAborted` 并正常返回。该条未复现，未改动。

## [1.4.9] - 2026-09-19

### 🔴 修 CI 红：`sink.js` 里的 `truncate()` 用了未定义的 `warn`

上一版给 `FileHandleSink` 加 `truncate()` 时写了 `warn?.('截断文件失败...')`，
但 **sink.js 并没有引入 `warn`**。`?.` 让它在运行时静默不崩，却被
`lint-noundef` 抓了出来。

**这是我这轮第二次"没看到输出就说全绿"**：本地我只跑了 14 个 node 套件，
lint 那行的输出是空的我没核对，就宣布"全绿"。CI 第一步就红，后续步骤被
GitHub 级联跳过，看起来像大面积失败，其实只有 1 处。

已修：sink.js 补 `import { warn } from './util.js'`。

> 值得一提：`lint-noundef.mjs` 这是**第一次在生产代码**（而非注入的演示 bug）
> 上抓到未定义标识符，说明这个工具真的有用。

### 🟠 测试夹具的 `trun.data_offset` 算错 20 字节（独立解析器抓到）

把上一版新加的「混流产物结构校验」接进 CI 后，下一步的**独立解析器**
`tools/mp4check.py`（纯 Python，完全不引用项目代码）报：

```
✗ 所有 trun.data_offset 落在紧随其后的 mdat 内（检查 5 个 trun，越界 5）
  实际 108 / 正确 128，偏差 -20
```

一开始我怀疑是 `mp4.js` 的合并算错了。逐字节比对源样本与产物后确认：
**源文件自己的 data_offset 就是 108**，`mp4.js` 只是忠实复制（它不该重写——
真实 B 站文件的偏移本来就是对的，重写反而会改坏）。

真因在**测试夹具** `buildFmp4`：手算 moof 大小时漏了 `first_sample_flags`(4B)
与 `traf`/`moof` 各自的 8 字节头，固定少 20。

修复：**先组装一次量出真实大小，再回填**（`buildMoof(0).length + 8`），
不再手算。修完独立解析器全绿（越界 0）。

顺带消除三份分叉的 `buildFmp4` 拷贝 —— `selftest-synthetic.mjs` 与
`test-engine-e2e.mjs` 改为共用 `tools/fixtures/fmp4.mjs`（共移除 229 行重复）。

### 其他

- `tools/fixtures/make-samples.mjs`：CI 现场生成混流样本（已 gitignore）
- CI 里「真实素材混流校验」从"永远跳过"改为真执行

### CI 自检

**17 个套件**（新增混流产物结构校验 + 独立解析器交叉校验为真实执行）

## [1.4.8] - 2026-09-19

### 🔴 修复「自动下载了 360P」的三条路径（继 v1.4.7 修 merge 崩溃之后）

上一版只解决了 merge 崩溃，360P 单独查。找到三条独立成因：

**1. `buildPlan` 静默降级到最低档**（最主要）

```js
// 修复前
if (!quality) quality = accept[0] || playInfo.videos[0]?.quality;   // ← 数组第一个，实测常是 360P
...
quality = lower || accept[accept.length - 1];                        // ← 名单末位 = 最低档
```

- `accept_quality` 为空时取 `videos[0]` —— **数组第一个未必是最高**，实测是 16（360P）
- 请求的档位不可得时降到 **`accept` 末位（最低档）**，把高清请求悄悄变成 360P

改为：
- 自动档先看 `accept[0]`，为空则取**实际存在的最高档**（从返回轨道算，不从宣称名单猜）
- 降级优先「不超过请求值的最高档」；若全都更高则升到**最接近**的一档；不再取末位
- 真的发生调整时 `warn` 出来，不再静默

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `accept=[]` + 自动 | 16（360P）❌ | 32（480P）✅ |
| 请求 125，accept=[32,16] | 16 ❌ | 32 ✅ |
| 请求 16，accept=[80,64] | 64（末位巧合） | 64（最接近）✅ |

**2. `try_look=1` 在登录态未知时被误发**

`playurl` 原来 `logged = ensureAccount().catch(() => false)` —— nav 失败且无缓存时一律当
"未登录"，于是带上 `try_look=1`（B 站"未登录试看"参数），服务端很可能只给低清试看流。
用户明明登录了却下到 360P 且不知原因。

改为**三态**：`true` / `false` / `null`（拿不到登录态）。只在**确认**未登录时才发
`try_look`；未知时不发，把判断权留给服务端 Cookie。

**3. `pickVideoTrack` 只看码率**（v1.4.2 已修，此处补齐测试）

### 其他修复

- **`refreshUrls` 补齐**：v1.4.6 我声称"音视频轨各接上"，实际 6 个 `fetchTo` 调用点
  只有 2 个接了，**默认的 merge 模式两条一条都没有**。现已全部接上（d/a/v/a/v/a），
  并给 helper 加了 durl 分支（durl 没有 video/audio 轨，要取 `durl[0]`）
- **`FileHandleSink` 新增 `truncate()`**：重试 / 换清晰度 / 续传清单失效时，
  `resetSink` 原来只把 `size` 归零**不截断文件**，OPFS 覆盖写不会缩短文件 →
  新内容更短时尾部残留上一轮字节。`resetSink` 改为 async 并真截断
- **CI 里有一条"永远跳过"的绿步骤**：`if [ -d samples ] ... else echo 跳过; fi`，
  而仓库从来没有 `samples/` —— 一直走 else，看着像有真实素材校验其实 0 覆盖。
  改为现场用共享夹具合成样本后真跑 `tools/mux-test.mjs`（含 SHA-256 逐字节比对）
- 抽出 `tools/fixtures/make-samples.mjs` 样本生成器；`samples/` 加入 `.gitignore`

### 测试

- `test-quality-pick` 14 → **18** 项：新增 `buildPlan` 降级四场景
- CI 自检 **16 个套件**（新增混流产物结构校验为真实执行）

### 教训（又踩一次）

给 `test-quality-pick.mjs` 追加场景时，summary / `process.exit` 被留在了中间，
新场景在它之后执行 —— 计数不进汇总，输出里"通过 14"其实是假的。
**追加测试场景后必须确认结尾块在文件最后**（这是我第 4 次踩同一个坑）。

## [1.4.7] - 2026-09-19

### 🔴 根治「未找到 moov 盒子」—— v1.0.0 起就存在的真机必崩 bug

**先看否定性证据（避免再走弯路）**：我抓了真实 B站 m4s 完整字节，解析 box：

```
BV16s7b68EEz  Q32 / Q16 全部轨道：
ftyp(32) → moov(904) → sidx(304) → moof(1904) → mdat(...)
```

**有 moov**。并且把真实 m4s（视频 5.67MB + 音频 876KB）直接喂进
`mergeDashStream`，**成功产出 6.5MB 可播文件**（44 片段 / 时长 105.8s）。
⇒ mp4.js 没坏。（v1.4.4 我断言"DASH 分片不含 moov"是错的，已撤回。）

**真因：合并前没有 flush 输入 sink**

| 环节 | 事实 |
|---|---|
| `sink.js` 的 `MEMORY_LIMIT = 256MB` | 超过就走 OPFS 的 `FileHandleSink` |
| `FileHandleSink.writeAt()` | 只把写入**排进异步 `_chain`**，不落盘 |
| `FileHandleSink.close()` | 唯一会 `await _chain` 并**关闭 writable** 的地方 |
| `mergeInto`（本次之前） | 直接 `await vSink.file()`（= `handle.getFile()`），**从未 close** |

⇒ 大文件（真实 1080P 长视频必然 > 256MB）合并时读到的是**还没落盘的空文件**
⇒ `scanFile` 扫不到任何 box ⇒ 报「未找到 moov 盒子」。

**为什么 CI 全绿**：`test-engine-e2e` 用几 KB 的合成片段 → 走 `MemorySink`
（数据在内存里，不 close 也能读到）→ 一直"4/4 PASS"。**测试夹具与真实数据形状脱节。**

**注入验证**（证明修复与测试都有效）：移除 close 调用后，测试精确复现用户报错，
且诊断信息里 `已扫描到的顶层 box：(空)` —— 空文件，与机理完全吻合。

### 修复

- `engine.mergeInto()`：读回 `vSink` / `aSink` 前先 `closeSinkQuietly()` 关闭它们
- `sink.js` 的 `FileHandleSink.close()`：原来写成 `await this._chain;` —— 一旦任何
  一次 `writeAt` 失败，`_chain` 永久 rejected，**writable 永远不会被关闭**（OPFS
  句柄锁死，文件无法删除/覆盖，后续 `getFile()` 也读不到数据）。
  现在即便写入链出错也保证释放句柄，错误延后抛出不吞
- 抽出 `tools/fixtures/fmp4.mjs` 共享合成 fMP4 夹具（此前已有 2 份重复拷贝；
  不能直接 import `selftest-synthetic.mjs`，它模块末尾会自动 `main()` + `process.exit`）

### 测试

- 新增 `tools/test-merge-flush.mjs`（8 项），已接入 CI：
  用「未 close 就读不到内容」的假 sink **忠实复刻 OPFS 语义**，断言合并成功、
  两个输入 sink 都被关闭、产物非空且以 `ftyp` 开头、close 失败不中断流程
- CI 自检 **16 个套件**

## [1.4.6] - 2026-09-19

### 新增：播放地址过期（403/404）自动刷新重试

B 站 CDN 的播放地址约 **120 分钟**失效（文档明文：「获取 url 有效时间为 120min，
超时失效需要重新获取」），失效后服务器返回 **403**（也可能 404）。

**原实现的问题**：拿到 403 后只用**同一个过期地址**重试 2 次，再回退顺序下载
（还是那个地址）—— 必然全部失败。典型场景：大文件下到一半、断点续传跨会话、
或解析完隔了一阵才开始下。

**修复**：
- `downloader.js` 的 HTTP 错误现在**带 `status`**（新增 `httpError(res)`），
  且重新包装成「分片 X-Y 下载失败：...」时**保留 status**
  （原来这里会丢，导致过期判断永远不触发）
- `engine.js` 新增 `isUrlExpiredError(err)`：403 / 404 / 410 判定为地址过期
- `fetchTo()` 新增可选 `refreshUrls` 回调：检测到过期就重新 playurl 换一批地址，
  重置 sink 后重试**一次**（不无限重试）
- `run()` 为视频轨 / 音频轨各接上 `refreshUrls`，刷新时重新 `playurl` +
  `buildPlan` 取对应轨道的新地址（含 backupUrls）

**兼容性**：不传 `refreshUrls` 时沿用旧行为（仍会抛错，不会假装成功）。

### 测试

- 新增 `tools/test-url-refresh.mjs`（12 项），已接入 CI：
  - `isUrlExpiredError` 判定（403/404/410 是，500/网络错误不是，undefined 不崩）
  - **核心**：403 → 刷新地址 → 重试成功，且确实请求过新地址
  - 不提供 `refreshUrls` 时仍抛错（不假装成功）
  - 刷新后仍失败 → 最终抛错且 `refreshUrls` 最多调用 1 次（不无限循环）

### CI 自检

**15 个套件**：validate 21 + core 57 + api 21 + resume 63 + resume-store 26 +
routing 9 + quality-pick 14 + chapters 37 + mp4 7 + nav 11 + url-refresh 12 +
lint-noundef + e2e 29 + synthetic + package

## [1.4.5] - 2026-09-19

### 🔴 修复「获取登录信息失败导致使用问题」—— 已登录用户被误判成未登录

用户反馈：扩展开启时获取 B 站登录信息失败，导致使用上出问题。

**机理**（排障手上轮已报、本轮实测确认）：`api.nav()` 有三个硬伤：
  1. **无超时** —— 网络挂起时永久卡住（它在 `get()` 的 20s 定时器之外，直接调 fetchImpl）
  2. **无重试** —— 一次失败就抛
  3. **不查 `res.ok` / content-type** —— B 站 WAF 返回 **412 HTML 错误页**时，
     `res.json()` 裸抛 `SyntaxError`

结果：`playurl` 里的 `await this.ensureAccount().then(a => a.isLogin).catch(() => false)`
把**已登录**用户 catch 成 `false`（未登录）→ 传 `try_look=1`、清晰度按未登录降档
（1080P → 720P）。用户感知就是"登录了却只能下低清 / 下载失败"。

**修复**：
- `nav()` 加超时（默认 8s，`AbortController`）、重试（默认 2 次，指数退避 300/600ms）、
  `res.ok` 检查、`content-type` 检查（非 JSON 明确报"可能被风控拦截"而非 SyntaxError）
- `ensureAccount()` 加**失败回退**：nav 偶发失败时，若本地有近期（30 分钟内）确认过的
  登录态，**沿用缓存**而不是降级成未登录。一次网络抖动不该让用户掉清晰度
- 无缓存时才抛出（不掩盖真实的首次失败）

### ⚠️ 撤回 v1.4.4 的错误断言（重要）

v1.4.4 我曾断言「B 站 DASH 分片流不含 moov」并据此改了错误文案。
**该结论已被实测证伪**：抓真实 m4s 字节解析 box，`BV16s7b68EEz` 的 **Q32 与 Q16 全部轨道**
结构均为 `ftyp(32) → moov(904) → sidx(304) → moof(1904) → mdat(...)`，**有 moov**。

所以「未找到 moov」的真因是别的（文件未下完整 / 该视频是纯 segment / 拿到的不是 DASH 分片）。
错误文案已改为**中立 + 带诊断**（输出实际扫到的顶层 box 列表），不再下错误断言。

### 测试

- 新增 `tools/test-nav.mjs`（11 项），已接入 CI：
  WAF HTML 必须显式报错（非 SyntaxError）、重试自愈、**抖动时不降级登录态**（核心）、
  无缓存才抛出、超时不挂起（实测 308ms）
- `tools/test-mp4.mjs` 改为 7 项：真实结构**必须能找到 moov**（防退化）+ 无 moov 时给中立诊断

### 说明：本轮两路调研 Agent 均因 429 配额失败

`dash-muxer`（DASH 无 moov 合并方案）与 `yutto-analyst`（yutto/yt-dlp 清晰度与错误码）都因
模型配额超限失败（16:29 恢复）。**本轮所有结论均为主理人自己抓源码/实测得出，不是子代理产出。**

### CI 自检

**14 个套件**：validate 21 + core 57 + api 21 + resume 63 + resume-store 26 +
routing 9 + quality-pick 14 + chapters 37 + mp4 7 + nav 11 + lint-noundef +
e2e 29 + synthetic + package

## [1.4.4] - 2026-09-19

### 🔴 v1.0.0 至今的根 bug：merge 模式根本跑不通

**真根**：B 站 DASH 分片流（m4s）的实际字节结构是 `ftyp + styp + moof + mdat`，
**全程没有 moov**（moov 在 init 段，分片不带）。我们的 `mp4.scanFile` 假设分片里有 moov
（用来取 mvhd/trak/mvex/trex），遇到真实分片直接抛「不是有效的 MP4：未找到 moov
盒子（该文件可能不是 DASH 分片流）」—— 一抛就退出，连扫 moof+mdat 片段都不做。

**为什么 CI 没发现**：v1.4.3 之前用 `selftest-synthetic.mjs`（合成 fMP4，含 moov）测
合并，所以 merge=4/4 PASS；我们**没有用真实分片形状**测过。从 v1.0.0 至 v1.4.3 五个
发布版本，**真实 merge 下载从未成功过**。

修复（这一版只是把症状说清楚，根因修复是下一版的事）：
- 错误文案改成：`不支持该来源：B 站 DASH 分片流不含 moov，mp4.js 当前无法
  直接合并；请把"下载方式"改为「音视频分离」后重试`
- 新增 `tools/test-mp4.mjs`（4 项），用真实分片字节（`ftyp+moof+mdat`，无 moov）锁住
  行为：必须抛错且文案含「DASH 分片流不含 moov」「音视频分离」，**且不**是旧的
  「未找到 moov 盒子」（防止以后退化）

### Workaround（用户立即可用）

- **别用 merge / separate / audio / durl 默认 merge**：用 `downloadMode='separate'`
  下两个文件（video.mp4 + audio.m4a），再自行 ffmpeg 合并

### 下版（v1.5.0）真正要做的

- 重写 `buildMergedMoov`：从 `moof.tfhd/trun` 推算 mvhd.duration 与 timesclae、
  构造 trak（hdlr+mdhd+minf）、trex 默认值；这样**纯分片流**也能直接合并出可播的 MP4

### 测试

- 新增 `test-mp4.mjs` 4 项已接入 CI。
- CI 自检 **13 个套件**（added mp4）。

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
