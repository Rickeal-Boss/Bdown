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
