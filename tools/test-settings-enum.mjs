/**
 * loadSettings 枚举白名单校验（v1.4.29 数据一致性 F8）。
 *
 * settings.js 依赖 chrome.storage —— Node 里用最小 mock 直接驱动生产代码。
 * 运行：node tools/test-settings-enum.mjs
 */

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name} — ${msg}`);
  }
};

/** 存储 mock：可注入脏数据。 */
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({ ...store }),
      set: async (patch) => Object.assign(store, patch),
    },
  },
};

const { loadSettings, DEFAULT_SETTINGS } = await import('../src/core/settings.js');

console.log('\n[1] 非法枚举值 → 回落默认值（storage 被写坏/旧版本淘汰字段的防御）');
{
  Object.assign(store, {
    downloadMode: 'bogus-mode',
    saveMode: 42,
    danmakuFormat: 'flash',
    subtitleFormat: 'lrc',
    chapterFormat: 'pdf',
    preferCodec: 'mpeg2',
    audioPreference: 'flac8k',
  });
  const s = await loadSettings();
  ok('downloadMode 非法 → merge', s.downloadMode === DEFAULT_SETTINGS.downloadMode, String(s.downloadMode));
  ok('saveMode 非法 → ask', s.saveMode === DEFAULT_SETTINGS.saveMode, String(s.saveMode));
  ok('danmakuFormat 非法 → ass', s.danmakuFormat === DEFAULT_SETTINGS.danmakuFormat, String(s.danmakuFormat));
  ok('subtitleFormat 非法 → srt', s.subtitleFormat === DEFAULT_SETTINGS.subtitleFormat, String(s.subtitleFormat));
  ok('chapterFormat 非法 → txt', s.chapterFormat === DEFAULT_SETTINGS.chapterFormat, String(s.chapterFormat));
  ok('preferCodec 非法 → avc', s.preferCodec === DEFAULT_SETTINGS.preferCodec, String(s.preferCodec));
  ok('audioPreference 非法 → best', s.audioPreference === DEFAULT_SETTINGS.audioPreference, String(s.audioPreference));
}

console.log('\n[2] 合法枚举值原样保留');
{
  Object.assign(store, { downloadMode: 'audio', saveMode: 'downloads', preferCodec: 'hevc' });
  const s = await loadSettings();
  ok('downloadMode=audio 保留', s.downloadMode === 'audio', String(s.downloadMode));
  ok('saveMode=downloads 保留', s.saveMode === 'downloads', String(s.saveMode));
  ok('preferCodec=hevc 保留', s.preferCodec === 'hevc', String(s.preferCodec));
}

console.log('\n[3] 未存储的键回落默认值（新装用户）');
{
  for (const k of Object.keys(store)) delete store[k];
  const s = await loadSettings();
  ok('全部回落默认', s.downloadMode === 'merge' && s.saveMode === 'ask' && s.danmakuFormat === 'ass');
}

/**
 * [4] 数字字段钳制 + 布尔强制（v1.4.30 加固）。
 *
 * 为什么必须有这一段：v1.4.30 之前 loadSettings 只做 `Number(v)`，不校验有限性
 * 也不钳制区间。实测（数据一致性预审）：storage 里写坏成 `concurrency: "NaN"`
 * 后，下游 `Math.max(1, Math.min(16, "NaN" || 8))` —— `"NaN" || 8` 是**非空串**（truthy）
 * 得 "NaN"，`Math.min(16,"NaN")` = NaN，`Math.max(1, NaN)` = NaN → 分片数 NaN →
 * worker 循环 0 次 → 任务"成功"却产出 0 字节文件（静默失败）。
 * 布尔同理：`notifyOnComplete: "false"` 是非空串（truthy），会被当成"开启通知"。
 *
 * 断言设计：每个数字脏值都要求「读回是有限数且落在合法区间内」，
 * 并额外钉死钳制语义（越界→钳到边界；非有限→回落默认）。
 */
console.log('\n[4] 数字字段钳制 + 布尔强制（非法值不得透传给下游）');
{
  const reset = () => { for (const k of Object.keys(store)) delete store[k]; };

  // 4.1 非有限数（"NaN" 字符串 / Infinity / NaN）→ 回落默认（默认本身必在区间内）
  const nonFinite = [
    { key: 'concurrency', bad: 'NaN', def: DEFAULT_SETTINGS.concurrency, lo: 1, hi: 16 },
    { key: 'maxParallelTasks', bad: Infinity, def: DEFAULT_SETTINGS.maxParallelTasks, lo: 1, hi: 8 },
    { key: 'retries', bad: NaN, def: DEFAULT_SETTINGS.retries, lo: 0, hi: 5 },
    { key: 'danmakuOpacity', bad: 'abc', def: DEFAULT_SETTINGS.danmakuOpacity, lo: 0.1, hi: 1 },
  ];
  for (const c of nonFinite) {
    reset();
    store[c.key] = c.bad;
    const s = await loadSettings();
    const v = s[c.key];
    ok(`${c.key}=${String(c.bad)} → 回落默认 ${c.def}`,
      Number.isFinite(v) && v === c.def && v >= c.lo && v <= c.hi, String(v));
  }

  // 4.2 越界 / 非数值 → 钳到最近边界（不放任 0/负数/超限透传）
  const clamped = [
    { key: 'concurrency', bad: 0, want: 1 },
    { key: 'concurrency', bad: -5, want: 1 },
    { key: 'concurrency', bad: 999, want: 16 },
    { key: 'maxParallelTasks', bad: '-5', want: 1 },
    { key: 'maxParallelTasks', bad: 99, want: 8 },
    { key: 'retries', bad: '999', want: 5 },
    { key: 'retries', bad: -3, want: 0 },
    { key: 'danmakuOpacity', bad: 5, want: 1 },
    { key: 'danmakuFontScale', bad: 0, want: 0.5 },
    { key: 'danmakuWidth', bad: 0, want: 16 },
    { key: 'danmakuHeight', bad: -100, want: 16 },
    { key: 'defaultQuality', bad: 100000, want: 127 },
  ];
  for (const c of clamped) {
    reset();
    store[c.key] = c.bad;
    const s = await loadSettings();
    const v = s[c.key];
    ok(`${c.key}=${JSON.stringify(c.bad)} → 钳制为 ${c.want}（不得透传）`,
      Number.isFinite(v) && v === c.want, String(v));
  }

  // 4.3 合法字符串数字仍规整为数字（不误伤）
  reset();
  store.concurrency = '12';
  store.retries = '0'; // 0 是合法值，不能被 `|| 默认` 吞掉
  const okStr = await loadSettings();
  ok("concurrency='12' → 12", okStr.concurrency === 12 && typeof okStr.concurrency === 'number', String(okStr.concurrency));
  ok("retries='0' → 0（0 合法，不得回落默认）", okStr.retries === 0, String(okStr.retries));

  // 4.4 布尔字段：只有字面 true 才是 true，其余一律 false
  const boolBad = ['false', 0, '', '0', null, undefined];
  for (const bad of boolBad) {
    reset();
    store.notifyOnComplete = bad;
    const s = await loadSettings();
    ok(`notifyOnComplete=${JSON.stringify(bad)} → 真实布尔 false`,
      typeof s.notifyOnComplete === 'boolean' && s.notifyOnComplete === false, String(s.notifyOnComplete));
  }
  reset();
  store.notifyOnComplete = true;
  const okTrue = await loadSettings();
  ok('notifyOnComplete=true → 保持 true', okTrue.notifyOnComplete === true, String(okTrue.notifyOnComplete));
  // 其它布尔字段同样强制（防止漏掉某个字段）
  reset();
  store.saveDanmaku = 'yes';
  store.showFloatingButton = 1;
  const okOther = await loadSettings();
  ok('saveDanmaku="yes" → false', okOther.saveDanmaku === false, String(okOther.saveDanmaku));
  ok('showFloatingButton=1 → false', okOther.showFloatingButton === false, String(okOther.showFloatingButton));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 设置枚举校验自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
