# 修复验证状态台账

**最新**：v1.4.21（2026-09-20）
**原则**：区分「已实测验证」「静态确认」「待测」三类。**不接受"改了就是已修"**。

---

## 零之前、v1.4.21 复审轮的验证状态

### 已实测验证（Verified）

| 项 | 验证方式 | 结果 |
|---|---|---|
| **弹窗谎报可用档位**（P0） | 用真实响应复刻 `popup.js` 的 `available` 判定 | UI 把 116/80/64 全标"可用"，实际只下到 32 → 证实 ✅ |
| **`pickExactTrack` 修复有效** | `test-quality-pick.mjs` [8]（10 项） | 无精确档时返回 `null`；反证 `pickVideoTrack` 仍会回退返回 32 ✅ |
| **无可用档就近取档** | `test-quality-pick.mjs` [9] | 请求 16 且只有 [80,64] → 取 64（不是 80）✅ |
| **候选档位并集** | `test-quality-pick.mjs` [10] | accept 漏报/虚报两种场景都正确 ✅ |
| **`accept_quality` 实际排序** | 公开接口实测 4 个视频 | 全部降序（`[116,80,64,32,16]` / `[32,16]` / `[112,80,64,32,16]` / `[16]`）—— 降序不是契约，故仍改用 `Math.max` ✅ |
| **durl 模式下 qn 的行为** | 公开接口实测 fnval=1，qn=16/64/80/127 | `data.quality` 恒为 16、durl 段数恒为 1 → 传 127 无副作用 ✅ |
| **DNR 规则 4 不再覆盖通用 CDN** | `test-dnr-side-effects.mjs` [7] | 不含 `akamaized.net`，仍含 B 站专属 CDN ✅ |
| **规则 3 同时设 Origin + Referer** | `test-dnr-side-effects.mjs` [9]（5 项） | 静态规则与动态严格规则都设了 ✅ |
| **课程链接解析** | `test-extract-id.mjs` [3] | `/cheese/play/ep123` → `{cheeseId}`；反证旧实现返回 `{epId}` ✅ |
| **控制字符 lint 有效** | 注入 NUL 字节 → 必须报错 | 报错 ✅（非空洞） |
| **包内容与源码一致** | `cmp -s` 逐字节比对 9 个关键文件 | 全部 OK ✅ |
| **Cookie 携带机制** | 无头 Edge + 最小 MV3 扩展实测 | 有 `host_permissions` → 全部 cookie 都带（含 `SameSite=Strict`）✅ |
| CI 全绿 | `node tools/test-*.mjs` × 19 套件 | **504 项通过 / 0 失败** ✅ |

### 静态确认（Static）— 必须真机复验

| 项 | 位置 | 状态 |
|---|---|---|
| **规则 3/4 加 `excludedInitiatorDomains` 后主页面登录恢复** | `rules/referer.json` | 语义已核对 Chrome 官方文档；**需真机确认那 4 个页面能正常登录** |
| **动态严格规则注册成功** | `src/background/service-worker.js` | 需真机在 `chrome://extensions` 看 service worker 无报错 |
| **扩展自身请求仍能绕开 WAF 412** | 同上 | 需真机确认弹窗能正常解析（即 `api.bilibili.com` 未被拦） |
| **弹窗显示 = 实际下载** | `src/popup/popup.js` | 本轮核心验收项，必须真机确认 |

### 已证伪（Ruled Out）

| 假设 | 证伪方式 |
|---|---|
| "扩展请求没带 SESSDATA cookie" | 无头 Edge 实测：有 `host_permissions` 时全部 cookie 都带，含 `SameSite=Strict` |
| "DASH 下 qn 是上限，传 127 会被降级" | 公开接口实测：qn=16/64/80/127 返回轨道集合完全一致 |

---

## 零、v1.4.20 修复的验证状态

### 0.1 已实测验证（Verified）

| 项 | 验证方式 | 结果 |
|---|---|---|
| **DASH 下 qn 无效**（决定性实证） | 公开接口实测 BV1uv411q7Mv，未登录态传 qn=16/64/80/127 | `dash.video[].id` 集合**四次完全一致** = `[32,32,16,16]`；`accept_quality` 恒为 `[116,80,64,32,16]` ✅ 证明兜底 qn 无意义 |
| **字符串 "0" 的 falsy 陷阱** | `node -e` 实测 `!"0"` | 返回 `false`（字符串 "0" 是 truthy）→ 证实旧 `if (!quality)` 会跳过自动分支 ✅ |
| **buildPlan 在 defaultQuality="0" 时的行为** | `tools/test-quality-pick.mjs` [6] | 修复后选 80；修复前会降到 accept 最小档 16 ✅ |
| **qn=0 实际请求 127 且不带 try_look** | `tools/test-playurl-routing.mjs` [4][5] | 4 种账号状态（会员/非会员/未登录/nav 抖动）全部 qn=127、无 try_look ✅ |
| **DNR 规则不再命中 bilibili.com 系域名** | `tools/test-dnr-side-effects.mjs`（26 项） | 规则 3/4 的 regexFilter 均不含 bilibili.com/tv/b23.tv；都有 `excludedInitiatorDomains:["bilibili.com"]` ✅ |
| **打包产物内容正确** | `unzip -p` 回读包内 manifest / rules | 版本 1.4.20、minChrome 116、规则 3/4 收窄生效 ✅ |
| CI 全绿 | `node tools/test-*.mjs` × 17 套件 | **433 项通过 / 0 失败** ✅ |

### 0.2 静态确认（Static）— 必须真机复验

| 项 | 位置 | 状态 |
|---|---|---|
| **规则 4 不再误伤 passport.bilibili.com** | `rules/referer.json` id=4 | regexFilter 已改到 CDN 域名；**需真机确认这些页面能正常登录** |
| **`excludedInitiatorDomains` 生效** | `rules/referer.json` id=3/4 | 语法与语义已核对 Chrome 官方文档（Chrome 101+，子域自动覆盖）；**需真机确认扩展自身请求仍能绕 WAF** |
| **扩展自身请求未被误排除** | 同上 | 扩展 initiator 是 `chrome-extension://<id>`，按文档不会被 `"bilibili.com"` 排除；**需真机确认下载仍能成功** |
| content.js 不依赖 DNR 注入头 | `src/content/content.js` | 已 Grep 确认只发 `sendMessage`，不发 fetch ✅（静态） |
| **登录态下能拿到 1080P** | `src/core/api.js` / `engine.js` | qn 传 127 + 客户端按 quality 挑最高；**这是本轮的最终验收项，必须真机确认** |

### 0.3 未确认项（Unknown）

| 项 | 说明 |
|---|---|
| 登录态下 `dash.video[]` 的实际档位集合 | 无法在不使用用户 cookie 的前提下实测。已加诊断日志，真机跑一次即可看到 |
| `try_look` 是否曾真的把已登录用户打成 360P | 无公开来源支持，但 yt-dlp 主动 `pop('try_look')` 属于同类规避；本版直接移除该参数，无副作用 |

---

## 一、历史：已实测验证（Verified）

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
