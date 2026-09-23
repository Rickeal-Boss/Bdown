# 修复验证状态台账

**最新**：v1.4.31（2026-09-24）。v1.4.21 台账见下方历史章节；v1.4.22–1.4.30 的
版本级验证状态以 CHANGELOG 对应条目为准。
**原则**：区分「已实测验证」「静态确认」「待测」三类。**不接受"改了就是已修"**。

---

## v1.4.31 第二轮审查收口的验证状态

### 已实测验证（Verified — 本机真实跑过）

| 项 | 验证方式 | 结果 |
|---|---|---|
| **P0：dashboard 模块求值零异常** | `tools/test-page-modules.mjs`（最小桩 import 全部 5 个页面模块） | ✅ 5/5 通过 |
| **变异对照：v1.4.30 的 dashboard.js** | `git show HEAD:...` 写入仓库外副本 + `BDOWN_PAGE_ROOT` 指向副本重跑 | ✅ 精准转红（`ReferenceError: specRegistry` @ :335）→ 修复版转绿，全程不碰工作树 |
| **指纹「恢复 ↔ 重新派发」同形** | `tools/test-spec-key.mjs` [6]（Task + toRecord 往返 + 恢复 claim + has 拦截） | ✅ 35 项通过（28→35） |
| **番剧补全后重算键 ≠ claim 键** | `test-spec-key` [6] 前提断言 | ✅ 证明「重算不可靠」，持久化 specKey 是必要修复 |
| 全量套件 | `for f in tools/test-*.mjs tools/lint-*.mjs tools/selftest-*.mjs` | ✅ 36 套件全绿（新增 1 个） |
| 发布门禁 / 包产物 | `node tools/package.mjs` + `test-release-gate.mjs` | ✅ 见 CHANGELOG（44 文件基线不变） |

### 静态确认（Static — 需真机复验）

- pending 恢复后点「开始」、error+resumeKeys 恢复后「重试」不再撞 `.part`（CI 无法模拟真机 OPFS 时序）。
- 关闭下载中心再重开，已派发未开始的任务仍在列表（persistHistory 落点）。
- btnClean：有失败任务时清 tmp、保留 resume；无失败任务时两样都清。
- 设置页改任意一项后引擎实时生效（normalizeSettings 通道）。

### 待办（本轮明确不做）

- DNR 静态规则 3 收窄到扩展自身（安全 F-004，需动 DNR 副作用测试基线，单独立项）。
- `persistHistory` 失败降级写（丢弃 spec.info.pages 减体积）。
- CI 覆盖元检查数字：`lint-ci-coverage` 现扫描 39 个被执行脚本。

---

## v1.4.30 七路审查轮的验证状态

### 已实测验证（Verified — 本机真实跑过）

| 项 | 验证方式 | 结果 |
|---|---|---|
| **指纹「注册键 == 释放键」** | `tools/test-spec-key.mjs` [3] 端到端复现（无 cid 派发 → `ensureSpecComplete` 原地补 cid → 释放 → 集合必须空） | ✅ 28 项通过 |
| **变异对照：把 cid 加回 `specKey`** | 临时改 `specKey` 后跑同一套件 | ✅ 转红（exit 1）→ 还原转绿，断言非空 |
| **收尾编排六步不可少 / paused 不释放指纹** | `tools/test-lifecycle.mjs`（依赖注入 + 调用顺序断言） | ✅ 29 项通过 |
| **变异对照：收尾去掉 `release`** | 临时删该行后跑同一套件 | ✅ 转红（exit 1）→ 还原转绿 |
| **abort 收尾「先关 sink 再落清单」顺序** | `test-lifecycle` [5]（假 sink 记录调用顺序） | ✅ |
| **变异对照：`abortFetchExit` 不关 sink** | 临时删除 `closeSinkQuietly` 调用 | ✅ 转红（exit 1）→ 还原转绿 |
| **收尾链单步失败不拖累指纹释放** | `test-lifecycle` [4]（prune / persistHistory 注入抛错） | ✅ 指纹仍被释放，`onError` 上报 |
| **番剧 `epId` / `seasonId` 补全 cid** | `test-spec-key` [4]（假 season 响应） | ✅ 含「拿不到剧集时不伪造 cid」反向用例 |
| **课程 `cheeseId` 未被改回** | `test-spec-key` [5] + 「已有 cid 时短路不发请求」 | ✅ |
| **包产物 44 文件 / 无隐藏文件 / 必备结构** | `node tools/package.mjs` + `test-release-gate.mjs` | ✅ 44 文件 / 640.1 KB |
| **CI 覆盖元检查（含 `selftest-*`）** | `lint-ci-coverage` 现扫描 38 个被执行脚本 | ✅ 75 项通过 |
| **三页 DOM id 一致性** | `lint-popup-ids`（popup / dashboard / options） | ✅ 12 项通过 |
| 全量套件 | `for f in tools/test-*.mjs tools/lint-*.mjs tools/selftest-*.mjs` | ✅ **35 套件全绿**（含新增 2 个） |

### 静态确认（Static — 需真机复验）

| 项 | 位置 | 状态 |
|---|---|---|
| 番剧 `epId`/`seasonId` → 真机 /bangumi 页面按钮可下载 | `engine.ensureSpecComplete` 番剧分支 | **需真机**：`/pgc/view/web/season` 的真实响应结构与沙箱假数据可能有差异 |
| content.js 两个注入按钮改为 `<button>` 后不受 B 站播放器样式干扰 | `src/content/content.js` + `content.css` | **需真机**：宿主页面对 `button` 的全局样式可能覆盖自绘样式 |
| 键盘 Tab 走到悬浮按钮/播放器按钮并回车触发 | 同上 | **需真机** |
| 对比度改动（`--bd-text-3` / `--bd-*-ink` / `--bd-focus` / `--bd-primary` / `--bd-track-off`）的视觉观感 | `src/ui/common.css` | **需真机**：比值是按 sRGB 公式手算的，观感需人眼确认 |
| 弹窗清晰度列表键盘选中后焦点归还 | `src/popup/popup.js` `select()` | **需真机** |
| `pendingTasks` 收口到 SW 后，连续快速派发（连点悬浮按钮 ×3）不丢任务 | `service-worker.js` + `dashboard.js` | **需真机**：跨上下文时序无法在 Node 里复现 |

### 待测 / 已知局限（诚实清单）

- **`/cheese/play/ss<id>`（课程 season 级链接）仍不能工作**：`content.js` 与
  `util.extractVideoId` 都把它归一成 `cheeseId`，而 `api.cheeseSeason()` 走的是
  `ep_id` 入参 —— 拿 season id 查不到剧集，最终以「任务缺少 cid」失败（**会报错，不静默**）。
  要真正支持需要给 `cheeseSeason` 加 `season_id` 入参并区分两种链接，属独立立项。
- 课程（pugv）接口与 `.flac` 无损路径**仍未真机验证**（付费/大会员内容）。
- `test-lifecycle` [4] 明确了「收尾步骤失败只上报不抛出」的语义 —— 若将来希望
  失败上抛给调用方，需同步改该断言。
- `validate.mjs` 在本机有 `spawnSync node.exe EBUSY` 环境问题（沙箱限制，**CI 不受影响**），
  本轮仍未处理；本地等价校验靠 `node --check` + 35 套件。
- DNR 静态规则 3 对第三方页面的 Origin 改写为**已记录的接受风险**（F-002），维持现状。

---

## v1.4.29 六路审查轮的验证状态

### 静态确认（CI/单测锁定）

| 项 | 验证方式 | 结果 |
|---|---|---|
| 合集 spec 带 downloadMode | `selftest-core` [10] 源码断言（`currentMode()` ≥2 处） | ✅ |
| startAll/pump 收尾统一 finishTracked | `selftest-core` [10]（≥3 处调用） | ✅ |
| 课程（cheese）弹窗入口 | `selftest-core` [10]（cheeseSeason 分支存在）；**真实付费课程接口未验证** | ⚠️ 待真机 |
| fetchTo 重试子路径 abort 收尾 | `selftest-core` [10]（abortExit ≥3 处）；`test-stall-rotation` 全绿 | ✅（真机暂停时序待测） |
| 幽灵卡片守卫 / paused 指纹注册 | `selftest-core` [10] 源码断言 | ✅ |
| 字幕白名单跳过 / 章节换行折叠 / Title 转义回归 | `selftest-core` [10] + `test-chapters` [6] + `test-danmaku` [9] | ✅ |
| resumeKey cheeseId/trackId | `test-resume-store` [1b] | ✅ |
| 设置枚举白名单 | `test-settings-enum.mjs`（新套件，已登记 validate.yml） | ✅ |
| 焦点样式真实存在 | `selftest-core` [10]（common.css 含 `:focus-visible`）+ 键盘可达性（清晰度列表 tabindex/role） | ✅（Tab 走查待真机） |
| 死代码 13 项删除（backlog 10 + 新发现 3） | 全库引用计数为 0（数据一致性预审）+ 28 套件全绿 | ✅ |

### 待真机验证（v1.4.29 新增面）

- 合集 + 「音视频分离」/「仅音频」组合（本轮 F-1 修复路径）
- 课程链接进弹窗解析（付费内容需已购）
- ask + 单文件 + 附加内容的 toast 提示与落盘位置
- 键盘 Tab 走查三页面（焦点样式、清晰度列表 Enter/Space）
- error 任务移除后「清理临时文件」对续传缓存的清理

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
