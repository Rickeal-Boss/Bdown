# 修复验证状态台账（v1.5.0）

**日期**：2026-09-19
**commit**：`fc3bcf8`（v1.4.1）
**原则**：区分「已实测验证」「静态确认」「待测」三类。**不接受"改了就是已修"**。

---

## 一、已实测验证（Verified）

以下各项均**实际运行过**，不是"声称"已修。

| 项 | 验证方式 | 结果 |
|---|---|---|
| `sanitizeFilename(null)` 不崩溃 | `node -e` 逐一传入 `null` / `undefined` / `''` | 全部返回 `"untitled"`，**不抛 TypeError**（安全官 C1 不成立，未采纳、未改） |
| 引擎干跑 harness **能抓 P0** | 注入 `vStage` → 跑 harness → 回滚 → 再跑 | 注入时 `exit 1` 且报 `ReferenceError: vStage is not defined`；回滚后 `exit 0`、4/4 PASS |
| **merge 分支** | 干跑 harness（**合成真实 fMP4** 夹具） | `status === 'done'`，产物数 1 ✅ —— B1 端到端验收通过 |
| **separate 分支** | 同上 | `status === 'done'`，产物数 2 ✅ |
| **audio 分支** | 同上 | `status === 'done'`，产物数 1 ✅ |
| **durl 分支** | 同上 | `status === 'done'`，产物数 1 ✅ |
| DNR 正则反例（6 个 URL） | `node -e` 用 `new RegExp(regexFilter)` 实测 | rule 3 严格锚定，`https://www.bilibili.com` 的 Origin **不会**泄漏给非 `api.bilibili.com` 域 ✅ |
| 课程 URL 解析 | `node -e` 传 `/cheese/play/ep<id>`、`/cheese/play/ss<id>` | 正确返回 `ep<id>` / `ss<id>` ✅ |
| CI 全绿 | GitHub Actions run `35357419021` | 8 个自检步骤全部 success |

> **关于 separate / audio / durl 三条分支**：安全官与 QA 均因环境无法运行 node 而标注"未验证"。本台账的实测结果由主理人（有 shell）补齐，可替代他们的预测。

---

## 二、静态确认（Static）

**代码已按建议修改，但缺少运行时/浏览器验证。** 可能是"改对了"也可能是"改了但没用"，需要真机确认。

| 项 | 位置 | 状态 |
|---|---|---|
| DNR rule 1 / rule 4 正则 `([^/]*\.)?` → `([^/?#]*\.)?` | `rules/referer.json` | 已改；反例 URL 的**静态正则测试通过**，但 DNR 规则需在浏览器重载后确认生效 |
| `onMessage` 加 `sender.id` 校验 | `src/background/service-worker.js` | 已加；需确认不会误伤本扩展自己的 popup/dashboard 消息 |
| 移除下载中心无条件 `reload` | `src/background/service-worker.js` | 已移除 |
| `vStage`/`aStage` → `vPrep.sink`/`aPrep.sink` | `src/core/engine.js:358-359` | 已改，**且已被上面的注入测试证明有效**（这条其实是"已实测"） |
| `engine.js` 透传 `spec.cheeseId` | `src/core/engine.js` | 已加 |
| `ensureSpecComplete` 课程（pugv）分支 | `src/core/engine.js` | 已加；用 `/pugv/view/web/season?ep_id=` 反查 cid，**未连过真课程接口** |
| `seasonInfo` 支持 `season_id` / `ep_id` 分流 | `src/core/api.js` | 已改 |
| 新增 `cheeseSeason(epId)` | `src/core/api.js` | 已加，未验证 |
| id 闸门改为"存在且非空" | `src/core/api.js` | 已改 |
| `normalizePlayInfo` 判空 | `src/core/api.js` | 已加 |
| `revokeObjectURL` 180s → 24h | `src/core/engine.js:598` | 已改 |
| 续传区间改为累积（不再只留最后一个分片） | `src/core/downloader.js` | 已改 |
| 干跑 harness 元断言（`pass+fail === 4`）+ 退出码 `fail ? 1 : 0` | `tools/test-engine-dryrun.mjs` | 已加，实测 exit 0 / 注入后 exit 1 |
| popup 预览 `qn: 127` → `qn: 0` | `src/popup/popup.js` | 已改 |
| 测试场景 9/10/11 移入 `main()`（消除 `process.exit` 竞态） | `tools/test-api-validation.mjs` | 已改，21 项通过 |
| 新增 `PRIVACY.md` | 仓库根 | 已建（3389 字节） |
| 新增 `docs/DOWNKYI-ANALYSIS.md` | `docs/` | 已建 |

---

## 三、待测（Untested）

**明确未做，需要浏览器或真实数据才能验证。发版前建议至少过一遍。**

| 项 | 为什么测不了 | 建议验证方式 |
|---|---|---|
| **课程（pugv）端到端** | 通常需要登录 + 付费课程，沙箱无真实 `ep_id` | 用真实 ep_id 打开 `/cheese/play/ep<id>`，点悬浮按钮，确认任务标题显示课程名而非 BV 号 |
| **番剧 v2 → v1 降级** | 需要真实 `ep_id` 且 v2 恰好返回 -400 才触发 | 找一个 v2 失败的番剧，看日志是否出现「番剧 v2 接口失败，降级到 v1」 |
| **DNR 规则重载后是否生效** | 规则在浏览器级生效，需实际发起请求观察 | 重载扩展后，在 DevTools Network 里看发往 `api.bilibili.com` 的请求 `Origin` 是否为 `https://www.bilibili.com` |
| **`sender.id` 校验是否误伤自身** | 需跑完整消息链路 | 依次点 popup 派发、dashboard 接收、选项页保存，确认全部正常 |
| **续传（默认关闭）** | 需人为中断大文件下载 | 选项中打开 `resumeEnabled`，下一个 >100MB 的任务，中途暂停再继续 |
| **本轮修复在真实账号下的表现** | 沙箱无 B 站登录态 | 非会员账号下确认解析预览不再被降级为 360P |

---

## 四、本轮**未做**的修复（诚实清单）

安全官/排障手/QA 提出、但本轮**没有改**的项，全部记录在此，避免"看起来都修了"：

- `subtitle.js` ASS 转义缺失（BD-06）、`danmaku.js` Title 换行注入（BD-16）
- `popup.js:321`（现 ~373）`qualityOpt.label` 未转义（BD-05）
- `README.md:163` 自相矛盾（既说支持 cheese 又说不支持）
- `subtitle_url` / `spec.cover` 域名白名单（BD-07）
- storage 上限与"清除下载历史"入口（BD-08）、`tabs` → `activeTab`（BD-09）
- 全局并发预算、OPFS / resume `.part` 的 TTL 清理（BD-10）
- 新增 `escapeAssText()` 并接入 `subtitleToAss` / `danmakuToAss`
- 新增 `tools/test-dnr.mjs`（DNR 非条件式断言）
- `sanitizeFilename` 补 `\u007f` / `\u2028\u2029` / `\u200b`
- CI action pin 到 SHA

> 本轮刻意只做「P0 阻塞 + 低成本高收益」的项，其余留待下一版。这不是遗漏，是取舍。
