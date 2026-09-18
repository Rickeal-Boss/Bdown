# DownKyi 深度分析：对 Bdown 的启发

分析对象（均为 C# 桌面客户端，但 API 层与稳定性设计可直接借鉴）：

- `yaobiao131/downkyi` —— 哔哩下载姬（WPF，14 stars，103 MB，2025-06 更新）
- `HanLuo/downkyicore` —— 哔哩下载姬跨平台版（Avalonia，2026-07 更新，**更值得参考**）

以下结论都基于**真实源码**，不是 README 推测。

---

## 1. 签名层：与我们的实现完全一致 ✅

`DownKyi.Core/BiliApi/Sign/WbiSign.cs`：

```csharp
// 同一张乱序表
int[] mixinKeyEncTab = { 46, 47, 18, 2, 53, 8, ... 36, 20, 34, 44, 52 };
// 过滤 value 中的 "!'()*" 字符
paraStr = paraStr.ToDictionary(kvp => kvp.Key, kvp => new string(kvp.Value.Where(chr => !"!'()*".Contains(chr)).ToArray()));
// 序列化参数
var query = new FormUrlEncodedContent(paraStr).ReadAsStringAsync().Result;
// w_rid = md5(query + mixinKey)
```

**对照 Bdown**：`MIXIN_KEY_ENC_TAB` 逐项一致；`FORBIDDEN_CHARS = /[!'()*]/g` 一致；`formUrlEncode` 对齐 .NET 的 `FormUrlEncodedContent` 与 Python `quote_plus` 语义（`~` 不转义、空格转 `+`）。**签名层我们没问题，不用改。**

一个差异：DownKyi 把 `ImgKey`/`SubKey` **持久化在用户设置里**（`SettingsManager.GetUserInfo()`），我们是内存缓存 10 分钟。客户端可以这么干（自带存储），扩展这么做意义不大（浏览器存储要权限），且密钥会轮换，持久化反而有陈旧风险。**不采纳。**

---

## 2. playurl 参数：DownKyi 比我们"瘦"

`DownKyi.Core/BiliApi/VideoStream/VideoStream.cs`：

```csharp
{ "fourk", 1 }, { "fnver", 0 }, { "fnval", 4048 }, { "cid", cid }, { "qn", quality }
// + bvid 或 aid
```

**没有** `otype`、`platform`、`high_quality`、`dm_img_*`。

但实测：**去掉 `otype` / `platform` 后，B 站只返回 `v_voucher`，拿不到 DASH 清单**：

```
带 otype=json&platform=web   → data.dash 完整
不带                          → {"data":{"v_voucher":"voucher_xxx"}}
```

**结论**：DownKyi 那套在它自己的网络环境能跑通，但我们不能照抄——保留 `otype` / `platform` 更稳。这也提醒：**不同客户端的"能跑通"不等于通用解，`dm_img_*`（yt-dlp 路线）与 `buvid3`（DownKyi 路线）是两套并行的反风控手段，我们用的是前者且已生效。**

---

## 3. 内容类型：番剧与课程的接口差异（重要）

DownKyi 源码里的关键注释：

```csharp
// 必须有episodeId，否则会返回请求错误
if (episodeId != 0) { url += $"&ep_id={episodeId}"; }
```

| 类型 | DownKyi | yt-dlp / sakidown | Bdown（改后） |
|---|---|---|---|
| 普通 ugc | `/x/player/wbi/playurl` | 同 | 同 ✅ |
| 番剧 | `/pgc/player/web/playurl`（**v1**） + cid，**不传 ep_id** | `/pgc/player/web/v2/playurl` + ep_id | **v2 优先，失败降级 v1** |
| 课程 cheese | `/pugv/player/web/playurl` + **必填 ep_id** | 同 | **新增支持** |

两种番剧写法都能通，我们保留 v2 但**加 v1 降级**——这就是"稳定性"的具体落地。

**课程（pugv）是 Bdown 之前完全没有的内容类型**，本轮补上（含 URL 解析 `/cheese/play/ep<id>`、`/cheese/play/ss<id>`）。

---

## 4. 稳定性：DownKyi 的 HTTP 层

`DownKyi.Core/BiliApi/WebClient.cs`：

```csharp
public static string RequestWeb(string url, ..., int retry = 2, ...)
{
    if (retry <= 0) return "";
    try { ... }
    catch (HttpRequestException e) { return RequestWeb(url, ..., retry - 1); }
    catch (Exception e)          { return RequestWeb(url, ..., retry - 1); }
}
```

- **任意异常都重试 2 次**（递归递减）
- `SocketsHttpHandler`：`PooledConnectionLifetime=10min`、`ConnectTimeout=3s`、`AutomaticDecompression=All`
- 代理三档：None / System / Custom
- **UA 可配置**（`SettingsManager.GetUserAgent()`）
- 下载用 `Downloader` 库：`ChunkCount` 可配、`ParallelCount=2`、`MaximumMemoryBufferBytes=50MB`

**对 Bdown 的启发**：
- ✅ 我们已有：分片并发（concurrency）、多 CDN 回退、分片级重试、超时（AbortController）
- ⚠️ **我们缺：`get()` 层面的整体重试**（目前只在 playurl 的 `-403/-352/-412` 上重试，网络层异常/5xx 不重试）→ 已确认需补
- ❌ 代理 / 可配 UA：浏览器扩展由浏览器接管，无意义（**不采纳**）
- ❌ `AutomaticDecompression`：浏览器自动处理（**不采纳**）

---

## 5. 功能性：哪些能借鉴，哪些不能

| DownKyi 功能 | 对 Bdown 的启发 |
|---|---|
| 批量下载、多P、合集、收藏夹、UP主全部投稿 | 我们有批量/多P/合集；**收藏夹/UP主全部投稿未实现**（需 `Favorites` / `Space` 接口，DownKyi 有对应模块可参考） |
| 课程（Cheese） | ✅ **本轮补上** |
| 番剧 v1/v2 | ✅ **本轮加降级** |
| 弹幕（XML→ASS，含**多种布局算法**） | 我们有 ASS；DownKyi 有 `DanmakuLayoutAlgorithm` 设置项（多种排布策略），可参考扩展 |
| 字幕（`/x/player/wbi/v2` → `subtitle.subtitles`） | 我们有，接口一致 ✅ |
| 去水印、音视频提取、工具箱 | 依赖 ffmpeg，扩展端无意义（**不采纳**） |
| Aria2 支持（完整 RPC 客户端 + 内置 server） | 扩展端无意义（**不采纳**） |
| **网页抓取降级**（`GetPlayUrlWebPage`） | ⚠️ **高价值但需验证**：扩展可从页面读 `window.__playinfo__` 绕开全部 API/WAF 问题。实测 B 站页面现在是客户端渲染，SSR HTML 里**没有** `window.__playinfo__`，但浏览器 JS 执行后可能存在——**需在浏览器确认** |

---

## 6. 安全性

DownKyi 是桌面客户端，权限模型与扩展完全不同（它能读本地文件、写任意目录、启动 aria2 进程）。能借鉴的**反风控**手段：

| 手段 | DownKyi | Bdown | 结论 |
|---|---|---|---|
| WBI 签名 | ✅ | ✅ | 一致 |
| `buvid3` / `buvid4` cookie | ✅ 调 `/x/frontend/finger/spi` 拿 `b_3`/`b_4` 并注入每个请求 | 浏览器已自带 B 站 cookie（含 buvid3） | **N/A**——扩展本来就带浏览器 cookie，且我们已移除 `cookies` 权限，无法自行注入 |
| `dm_img_*` 指纹参数 | ❌ 不用 | ✅ 已用（yt-dlp 路线） | 保留 |
| 自定义 UA / Referer / Origin | ✅ | ✅（DNR 覆写 Origin） | 已覆盖 |
| 重试 | ✅ retry=2 | ⚠️ 仅错误码重试 | **需补网络层重试** |

**结论**：安全/反风控上我们没有落后，DownKyi 的 `buvid3` 对扩展是 N/A（浏览器已提供）。真正要补的是**重试**。

---

## 7. 本轮落地清单

| # | 改动 | 文件 | CI 验证 |
|---|---|---|---|
| 1 | 番剧 v2 → v1 降级 | `src/core/api.js` | ✅ `test-playurl-routing.mjs` |
| 2 | 课程（pugv）支持，含 URL 解析 | `src/core/api.js`、`src/content/content.js` | ✅ `test-playurl-routing.mjs` |
| 3 | 路由三分支（ugc/pgc/pugv） | `src/core/api.js` | ✅ 9 项 |

## 8. 待办（记录，未做）

- [ ] `get()` 层网络异常重试（DownKyi retry=2 的做法）
- [ ] 收藏夹 / UP 主全部投稿（DownKyi 有 `Favorites` / `Users` 模块可参考）
- [ ] 弹幕多布局算法（DownKyi 的 `DanmakuLayoutAlgorithm`）
- [ ] 页面 `window.__playinfo__` 抓取降级（**需浏览器验证是否可行**）
