# 外部开源项目调研 → Bdown 改进路线图

**日期**：2026-09-19
**调研对象**：BBDown（`nilaoda/BBDown`，C# CLI，功能面最全的之一）为主
**方法**：直接抓源码与真实接口实测，不是读 README 推测

---

## 一、能力对照表（BBDown vs Bdown）

| 能力 | BBDown | Bdown | 差距 |
|---|---|---|---|
| 番剧 | Web / TV / App | 仅 Web（v2，失败降级 v1） | 可接受（TV/App 需额外签名） |
| 课程（pugv） | Web | Web | ✅ 平 |
| 普通视频 | Web / TV / App | 仅 Web | 可接受 |
| **互动视频（stein gate）** | ✅ 展开成虚拟分P | ❌ **完全没有** | 🔴 内容类型缺失 |
| **章节（chapters）** | ✅ 并入 MP4 | ❌ **完全没有** | 🟠 元数据缺失 |
| **收藏夹 / 个人空间 / 合集批量** | ✅ 4 个 Fetcher | 仅合集 | 🟠 入口缺失 |
| 多分P / 指定分P / 指定清晰度 | ✅ | ✅ | 平 |
| 字幕（转 srt） | ✅ | ✅ SRT/ASS/TXT | 平 |
| 弹幕 | ✅（元数据） | ✅ ASS/XML/SRT/TXT | 平 |
| 单独下载视/音/字幕 | ✅ | ✅（merge/separate/audio/durl） | 平 |
| 多线程 / 断点续传 | ✅ | ✅（续传默认关闭） | 平 |
| 8K / HDR / 杜比视界 / 全景声 | ✅ | ✅（fnval 4048 + 128） | 平 |
| AVC / HEVC / AV1 | ✅ | ✅（preferCodec） | 平 |
| 自定义文件名 | ✅ | ✅（模板） | 平 |
| aria2c / ffmpeg 工具箱 | ✅ | N/A（扩展端无意义） | 不适用 |

---

## 二、两个"零额外请求成本"的新能力（最高性价比）

### 2.1 章节（chapters）—— 数据我们已经在取，只是没用

**实测证据**（本项目目录内跑 `/x/player/wbi/v2`）：
```
code: 0
顶层字段: ..., subtitle, view_points, ...
view_points: []      ← 该视频无章节，但字段确实存在
```

- **数据位置**：`/x/player/wbi/v2` → `data.view_points[]`
- **关键**：我们**已经在调这个接口取字幕**（`api.playerV2()`），只是没读 `view_points`
  ⇒ **取章节 = 零额外请求**
- **落地**：
  1. `api.playerV2()` 的返回值里带上 `view_points`
  2. 生成章节文件（YouTube 风格的 `chapters.txt`，或 WebVTT 的 `CHAPTERS` 轨）
  3. 若要做 MP4 内嵌章节，需要在 `mp4.js` 的 moov 里写 `chap` 引用（工作量较大，可后置）

### 2.2 互动视频（stein gate）—— 完全没支持的内容类型

**BBDown 的做法**（`BBDown.Core/Fetcher/NormalInfoFetcher.cs:53-75`，源码实读）：
```csharp
if (isSteinGate == 1) // 互动视频获取分P信息
{
    // 1) 拿 graph_version
    var playerSoApi = $"https://api.bilibili.com/x/player.so?bvid={bvid}&id=cid:{cid}";
    // 返回 XML，取 //interaction 节点（内含 JSON）
    var graphVersion = JsonDocument.Parse(interactionNode.InnerText).RootElement
        .GetProperty("graph_version").GetInt64();

    // 2) 用 graph_version 换分支列表
    var edgeInfoApi = $"https://api.bilibili.com/x/stein/edgeinfo_v2?graph_version={graphVersion}&bvid={bvid}";
    var questions = edgeInfoData.GetProperty("edges").GetProperty("questions").EnumerateArray();
    var index = 2; // 互动视频分P索引从 2 开始
    foreach (var question in questions) {
        foreach (var page in question.GetProperty("choices")) { ... }  // 每个 choice 是一个分支
    }
}
```

**我们这边的检测入口**（实测）：
```
/x/web-interface/view → data.rights.is_stein_gate   0=普通 1=互动
（测试视频 BV16s7b68EEz 的 is_stein_gate = 0）
```

- **落地**：
  1. `api.videoInfo()` 之后读 `rights.is_stein_gate`
  2. 为 1 时走 stein 分支：拉 `graph_version` → `edgeinfo_v2` → 把每个 choice 渲染成一个可选"分P"
  3. 每个 choice 里应含 `cid`（需真机确认字段结构）

---

## 三、入口扩展：收藏夹 / 个人空间 / 合集

BBDown 有 4 个独立 Fetcher，我们是 0：
```
BBDown.Core/Fetcher/FavListFetcher.cs       收藏夹
BBDown.Core/Fetcher/SpaceVideoFetcher.cs    个人空间（UP 主全部投稿）
BBDown.Core/Fetcher/MediaListFetcher.cs     合集/播单
BBDown.Core/Fetcher/SeriesListFetcher.cs    系列
```

- **价值**：批量下载是 Bdown 的核心卖点之一，但入口只有"当前视频页"
- **落地难度**：中（需要分页 + 登录态，扩展端可用 `credentials: 'include'` 带 Cookie）
- **建议优先级**：中（先把互动视频和章节做完）

---

## 四、注意事项（BBDown 依赖但我们不能依赖的）

- BBDown 的章节合并**依赖 ffmpeg / mp4box**（外部二进制）。扩展端没有，
  所以"MP4 内嵌章节"要么自己写 moov 的 `chap`，要么只产出外挂章节文件。
- BBDown 的 aria2c / 二维码登录 / TV&App 接口在扩展端无意义或不适用。

---

## 五、待办（本轮未覆盖）

- [ ] `fnval` 各位的官方语义（`bilibili-API-collect` 的 fnval 文档此前一直返回 404，未能核实 8192 位）
- [ ] Gitee 上的同类项目（本轮网络未取到）
- [ ] 浏览器扩展形态的 B 站下载器调研（子代理因 429 配额失败，配额 16:29 后重试）
- [ ] 互动视频 `choices[].cid` 字段结构需真机确认
