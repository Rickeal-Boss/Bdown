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

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 设置枚举校验自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
