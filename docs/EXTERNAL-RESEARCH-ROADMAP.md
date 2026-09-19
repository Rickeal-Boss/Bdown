# 外部开源项目调研 → Bdown 改进路线图

**日期**：2026-09-19
**对应版本**：v1.4.1（commit `aa1d62d`）
**方法**：抓真实源码 + 实测接口，**不靠 README 推测**；每条结论附可复核来源。

---

## 🎯 一句话结论

外部项目在**功能数量**上远超我们（BBDown 有 NFO / 章节 / 互动视频 / 收藏夹 / 空间批量 / 杜比 / 8K），但那些优势大多依赖 **ffmpeg / mp4box / aria2c 外部二进制**——浏览器扩展拿不到，硬搬是错的。
**真正值得我们做的只有 3 件**：NFO 元数据、章节（chapters）、HDR Vivid 的认知修正。

---

## 一、✅ 已证实：我们做对的地方（继续保留）

| 项 | 来源 | 结论 |
|---|---|---|
| `fnval=4048` | `ILoveScratch2/bilibili-api-collect-new` `docs/video/videostream_url.md` | **正确且完整** —— 官方位表：16 DASH \| 64 HDR \| 128 4K \| 256 杜比音频 \| 512 杜比视界 \| 1024 8K \| 2048 AV1 = **4048「所有可用 DASH 视频流」** |
| `dm_img_*` 指纹参数 | DownKyi `WebClient.cs` 使用 `buvid3`；yt-dlp 使用 `dm_img_*` | 两者是**并行的两套**反风控手段，我们用 yt-dlp 路线且已生效，保留 |
| WBI 签名实现 | DownKyi `WbiSign.cs` | 乱序表、`!'()*` 过滤、`FormUrlEncodedContent`（等价 Python `quote_plus`）**逐项一致**，无漂移 |
| `otype` / `platform` 保留 | 实测 | 去掉后只返 `v_voucher` 拿不到 DASH —— **不能照抄 DownKyi** |
| `buvid3` 不自己注入 | — | 浏览器自动带；我们已移除 `cookies` 权限，无法自行注入，本就 N/A |

### ⚠️ 认知修正：番剧 `fnval` 的 8192 位

我们番剧分支用 `12240 = 4048 | 8192`（照抄 yt-dlp）。
**但官方文档的位表里根本没有 8192 位**（只有 …2048、4048、16384）。
→ **8192 是 yt-dlp 的历史遗留**，无官方语义。当前**无害**（多一个未知位不会让请求失败），但不应再当作"有依据的设计"。
建议：保持现状但加注释说明；若将来番剧出问题，这是第一个可去掉的变量。

### ⚠️ 认知修正：HDR Vivid 我们拿不到

文档明确：`16384 = HDR Vivid`，备注 **"仅 APP 接口可用"**。
我们是 Web 接口（`platform=web`）→ **HDR Vivid 拿不到是设计使然，不是 bug**。不要为此改代码。

---

## 二、🔴 值得做：3 项（都不依赖外部二进制）

| # | 能力 | 价值 | 难度 | 说明 |
|---|---|---|---|---|
| 1 | **NFO 元数据**（Jellyfin） | 高 | **低** | 纯 XML 文本，数据全是 `/x/web-interface/view` 已取的字段（标题、UP、简介、封面、pubdate、tag、BV）。用户呼声最高的"媒体库归档"能力 |
| 2 | **章节（chapters）** | 高 | 中 | 数据源待确认（见下）。写入需要 `mp4.js` 支持 `udta`/`chpl` 盒。若只出外挂 `.chapters.txt` 则难度降到低 |
| 3 | **收藏夹 / UP 主空间批量入口** | 中 | 中 | 需 `Favorites` / `Space` 接口 + 分页 + 登录态（扩展可用 `credentials:'include'`）。BBDown 有 `FavListFetcher` / `SpaceVideoFetcher` / `MediaListFetcher` / `SeriesListFetcher` 四个 |

---

## 三、❌ 明确不做（依赖外部二进制，扩展端拿不到）

| BBDown 能力 | 为什么不做 |
|---|---|
| ffmpeg / mp4box 混流 | 扩展无外部二进制；我们自己实现了 ISO-BMFF 无损混流，这是我们的差异化优势 |
| 杜比视界（`.mp4` 成品） | 需 mp4box 转封装；DASH 流本身能下（512 位已覆盖），只是不转封装 |
| aria2c 下载 | 扩展无法启动外部进程；`chrome.downloads` 已够用 |
| grpc API 路线 | 浏览器发不了 gRPC（需 HTTP/2 + protobuf 二进制），Web JSON API 是唯一可行路线 |

---

## 四、📌 文档源更新（重要）

**`SocialSisterYi/bilibili-API-collect` 已于 2026-01-30 归档**（`archived: true`，20215★）。
这解释了我们此前查 `fnval` 位定义一直返回 404 的原因——**不是我们查错，是仓库没了**。

**新的活跃文档源**：
- `ILoveScratch2/bilibili-api-collect-new`（680 文件，未归档）← **本次 `fnval` 位表出处**
- `BACNext/BACNext`（194★，"bilibili API Collect Next"）
- `z0z0r4/bilibili-API-collect`（21★，"不断更新中"）

后续核 API 请改用上面这些，不要再引用已归档的那个。

---

## 五、待办 / 本轮未覆盖

- [ ] 章节数据源确认：`/x/player/wbi/v2` 的 `data.view_points`（我们已在调该接口取字幕，可顺带读） vs `clip_info`
- [ ] Gitee 上的同类项目（本轮未取到，沙箱访问受限）
- [ ] 浏览器扩展形态的 B 站下载器调研（子代理因 429 配额失败，配额 2026-09-19 16:29 后重试）—— 重点想验证"DNR 静态规则 vs session 动态规则 + `initiatorDomains`"
- [ ] `yutto-dev/yutto`（这轮没查成，功能面广，值得一并对照）


---

## 接口探路实测结论（2026-09-19 补充）

> 这一节的价值在于：**避免后人照着已归档的仓库去实现，对着死端点写一堆代码**。
> 教训来源：BBDown 已于 2026-05 归档，它用的 `/x/player.so` 现在直接 404。

### 批量入口三条路线的实测

| 候选 | 端点 | 实测结果 | 结论 |
|---|---|---|---|
| UP 主空间批量 | `/x/space/wbi/arc/search` | **-352 风控校验失败**；参数补齐后变成 **HTTP 412**（WAF 页） | 排除 |
| UP 主信息（粉丝数） | `/x/space/wbi/acc/info` | **-352 风控校验失败** | 排除 |
| 关注数 | `/x/relation/stat` | **code 0，可用** | 可用（但价值低） |
| 互动视频分支展开 | `/x/player.so` | **HTTP 404**（返回 HTML 错误页），拿不到 `graph_version` | 排除 |
| 互动视频分支列表 | `/x/stein/edgeinfo_v2` | 依赖 `graph_version`，上游 404 所以拿不到 | 连带不可用 |
| **合集（ugc_season）** | `/x/web-interface/wbi/view/detail` 的 `ugc_season` | **code 0，不受 -352 影响**，随当前视频一起返回 | **已实现（v1.4.14）** |

**重要边界**：上述 -352 / 412 都是在**沙箱（无登录 cookie）**下测的。
-352 与 412 都可能与"未登录 / 缺 `buvid3` 指纹"有关，**已登录的真机里可能可用**。
所以这里的结论应读作「沙箱下被拒、需真机确认」，而不是「确定不可用」。
真机只需在 DevTools 跑一次 `/x/space/wbi/arc/search` 看 `code` 是否为 0 即可定论。

### 互动视频的替代线索

`view` 响应里有个 **`stein_guide_cid`** 字段（互动视频的引导 cid）。
实测（BV1xDgL6SEzk）：`cid=41156151510`、`stein_guide_cid=99543100`
**两者都能取到 DASH 流**（code 0，视频轨 id 均为 `[32,32,32,16,16,16]`）。

这比已失效的 `/x/player.so` 靠谱，是将来做互动视频的入口：
- 最小可用：把入口视频 + 引导视频都下下来
- 完整方案：需要能枚举分支节点，目前无可用端点

### 真实互动视频样本（供后续验证）

- `BV1xDgL6SEzk`（cid 41156151510，`rights.is_stein_gate = 1`）
- `BV1gyY26vEYE`、`BV1NRju6LEmZ`、`BV18ug66REzE`、`BV1vb4y1r7cg` 同样是互动视频

获取方式：`/x/web-interface/wbi/search/type?search_type=video&keyword=互动视频`

### 真实合集样本

- `BV1Wi4y1k7ed`：合集 id 2563105，《成人拼音打字速学教程系列视频》，**7 集**
- 字段结构：`ugc_season.sections[].episodes[]`，每集 `bvid`/`aid`/`cid`/`title`
  （`duration` 与封面在 `arc.duration` / `arc.pic`，**不在 episode 顶层**）

### 真机验证清单

见 `docs/MANUAL-VERIFICATION.md` —— 上架前必须走完 A 组（大文件 merge + 清晰度）。
