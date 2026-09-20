/**
 * 清晰度挑选 + 课程 fnval 的回归测试（不联网）。
 *
 * 背景：曾经「非会员只下到 360P」，我们先后改了三次 qn（127 -> 80 -> 0），
 * 全都**没触达病根**。实测证明 **DASH 下 qn 无效**——传 0 / 80 / 125 / 127
 * 返回的 dash.video 集合完全一致，清晰度必须由客户端从返回轨道里挑。
 *
 * 真正的 bug 在 pickVideoTrack：排序只看 codec 与 bandwidth，**完全没排清晰度**，
 * 于是低清轨只要码率更高就会被选中。
 *
 * 运行：node tools/test-quality-pick.mjs
 */
import { pickVideoTrack, FNVAL_PUGV, FNVAL_DASH } from '../src/core/api.js';

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

/**
 * 复刻踩坑现场：480P(32) 与 360P(16) 同时在返回里，
 * 但 **360P 的码率更高**（旧实现按码率取最大 -> 会误选 360P）。
 */
const VIDEOS = [
  { quality: 16, id: 16, codecid: 7, bandwidth: 900000 },  // 360P，码率最高 <- 陷阱
  { quality: 32, id: 32, codecid: 7, bandwidth: 500000 },  // 480P，码率较低 <- 正确答案
  { quality: 16, id: 16, codecid: 12, bandwidth: 700000 },
  { quality: 32, id: 32, codecid: 12, bandwidth: 400000 },
];

console.log('\n[1] 清晰度必须优先于码率（360P 码率更高的陷阱场景）');
{
  const pick = (q) => pickVideoTrack(VIDEOS, q, 'avc');
  ok('auto（qn<=0）挑最高可用 480P，而不是码率最高的 360P', pick(0)?.quality === 32, `得到 ${pick(0)?.quality}`);
  ok('指定 1080P(80) -> 回退到不超过它的最高档 480P', pick(80)?.quality === 32, `得到 ${pick(80)?.quality}`);
  ok('指定 8K(127) -> 同样回退到 480P', pick(127)?.quality === 32, `得到 ${pick(127)?.quality}`);
  ok('指定 480P(32) -> 480P', pick(32)?.quality === 32, `得到 ${pick(32)?.quality}`);
  ok('指定 360P(16) -> 尊重用户选择，给 360P', pick(16)?.quality === 16, `得到 ${pick(16)?.quality}`);
  ok('挑中的轨道编码符合偏好（avc -> codecid 7）', pick(0)?.codecid === 7, `得到 ${pick(0)?.codecid}`);
}

console.log('\n[2] 同清晰度内仍按编码偏好与码率挑选');
{
  const v = [
    { quality: 80, id: 80, codecid: 12, bandwidth: 100 },
    { quality: 80, id: 80, codecid: 7, bandwidth: 100 },
    { quality: 80, id: 80, codecid: 13, bandwidth: 100 },
  ];
  ok('preferCodec=avc -> 选 codecid 7', pickVideoTrack(v, 80, 'avc')?.codecid === 7);
  ok('preferCodec=hevc -> 选 codecid 12', pickVideoTrack(v, 80, 'hevc')?.codecid === 12);
  ok('preferCodec=av1 -> 选 codecid 13', pickVideoTrack(v, 80, 'av1')?.codecid === 13);
}

console.log('\n[3] 边界');
{
  ok('空轨道列表 -> null', pickVideoTrack([], 80, 'avc') === null);
  const only = [{ quality: 16, id: 16, codecid: 7, bandwidth: 1 }];
  ok('只有一条轨道时返回它', pickVideoTrack(only, 127, 'avc')?.quality === 16);
  ok('缺少 quality 字段时回退用 id', pickVideoTrack([{ id: 64, codecid: 7, bandwidth: 1 }], 0, 'avc')?.id === 64);
}

console.log('\n[4] 课程（pugv）的 fnval 与 yt-dlp 对齐');
{
  ok('FNVAL_PUGV === 16（yt-dlp 对 pugv 写死的值）', FNVAL_PUGV === 16, `得到 ${FNVAL_PUGV}`);
  ok('课程不再沿用 ugc 的 4048（含未经验证的 HDR/4K/杜比/8K 位）', FNVAL_PUGV !== FNVAL_DASH);
}

console.log('\n[5] buildPlan 的清晰度降级不能静默掉到最低档（360P 事故）');
{
  const { buildPlan } = await import('../src/core/engine.js');
  const mk = (qs) => qs.map((q) => ({
    quality: q, id: q, codecid: 7, bandwidth: 1000 + q, url: 'https://cdn/v', backupUrls: [], size: 1000,
  }));
  const audio = [{ quality: 30280, id: 30280, codecid: 0, url: 'https://cdn/a', backupUrls: [], size: 100 }];
  const SET = { downloadMode: 'merge', preferCodec: 'avc', audioPreference: 'normal' };
  const plan = (pi, spec) => buildPlan({ mode: 'dash', videos: [], audios: audio, ...pi }, SET, spec);

  const auto = plan({ acceptQuality: [], videos: mk([16, 32]) }, { quality: 0 });
  ok('accept 为空 + 自动 -> 取实际最高档 32，而不是 videos[0] 的 16',
    auto.quality === 32 && auto.video?.quality === 32, 'quality=' + auto.quality + ' track=' + auto.video?.quality);

  const hi = plan({ acceptQuality: [32, 16], videos: mk([32, 16]) }, { quality: 125 });
  ok('请求 125（不可得）-> 降到不超过它的最高档 32，而不是最低档 16',
    hi.video?.quality === 32, 'track=' + hi.video?.quality);

  const lo = plan({ acceptQuality: [80, 64], videos: mk([80, 64]) }, { quality: 16 });
  ok('请求 16（低于全部档位）-> 取最接近的 64，不是末位', lo.video?.quality === 64, 'track=' + lo.video?.quality);

  const fake = plan({ acceptQuality: [125, 116, 80, 64, 32, 16], videos: mk([32, 16]) }, { quality: 0 });
  ok('宣称 125 但实际只有 32/16 -> 取 32（不虚报）', fake.video?.quality === 32, 'track=' + fake.video?.quality);
}

console.log('\n[6] settings.defaultQuality 是字符串 "0" 时仍能走自动（360P 事故的根因）');
{
  const { buildPlan } = await import('../src/core/engine.js');
  const mk = (qs) => qs.map((q) => ({
    quality: q, id: q, codecid: 7, bandwidth: 1000 + q, url: 'https://cdn/v', backupUrls: [], size: 1000,
  }));
  const audio = [{ quality: 30280, id: 30280, codecid: 0, url: 'https://cdn/a', backupUrls: [], size: 100 }];
  const SET_BASE = { downloadMode: 'merge', preferCodec: 'avc', audioPreference: 'normal' };
  const plan = (pi, spec, set) => buildPlan({ mode: 'dash', videos: [], audios: audio, ...pi }, { ...SET_BASE, ...(set || {}) }, spec);

  // 复刻事故现场：用户选"自动"，但 storage 里 defaultQuality 是**字符串 "0"**
  // （options.js 老版本 patch[key] = el.value 不转 number）。
  // JS 里 !"0" === false（字符串是 truthy），所以旧的 `spec.quality || settings.defaultQuality`
  // 会把字符串 "0" 当作 truthy，跳过自动分支，走降级 → accept 最小档 = 16 → 360P。
  const stringy = plan(
    { acceptQuality: [116, 80, 64, 32, 16], videos: mk([80, 64, 32, 16]) },
    { quality: 0 },
    { defaultQuality: '0' },  // 字符串 "0" —— 关键！
  );
  ok('settings.defaultQuality="0"（字符串）+ spec.quality=0 → 仍走自动选 80',
    stringy.video?.quality === 80,
    `track=${stringy.video?.quality}（期待 80；如果这是 16，就是 360P 事故）`);
  ok('settings.defaultQuality="0"（字符串）不应被误判为请求 0',
    stringy.video?.quality !== 16 && stringy.video?.quality !== 32,
    `track=${stringy.video?.quality}`);

  // 同时验证数字 0 也照常工作（不回归）
  const numeric = plan(
    { acceptQuality: [116, 80, 64, 32, 16], videos: mk([80, 64, 32, 16]) },
    { quality: 0 },
    { defaultQuality: 0 },
  );
  ok('settings.defaultQuality=0（数字）+ spec.quality=0 → 选 80',
    numeric.video?.quality === 80, `track=${numeric.video?.quality}`);
}

console.log('\n[7] accept_quality 顺序不可信：不能靠 accept[0] 取最高档');
{
  const { buildPlan } = await import('../src/core/engine.js');
  const mk = (qs) => qs.map((q) => ({
    quality: q, id: q, codecid: 7, bandwidth: 1000 + q, url: 'https://cdn/v', backupUrls: [], size: 1000,
  }));
  const audio = [{ quality: 30280, id: 30280, codecid: 0, url: 'https://cdn/a', backupUrls: [], size: 100 }];
  const SET = { downloadMode: 'merge', preferCodec: 'avc', audioPreference: 'normal' };
  const plan = (pi, spec) => buildPlan({ mode: 'dash', videos: [], audios: audio, ...pi }, SET, spec);

  // 实测 4 个视频的 accept_quality 都是降序（[116,80,64,32,16] 等），但这不是接口契约。
  // 若某天变成升序，旧实现 accept[0] 会取到**最低档** → 又是 360P。
  const asc = plan({ acceptQuality: [16, 32, 64, 80], videos: mk([80, 64, 32, 16]) }, { quality: 0 });
  ok('accept_quality 升序 [16,32,64,80] + 自动 → 仍取最高档 80（不能取 accept[0]=16）',
    asc.video?.quality === 80, `track=${asc.video?.quality}`);

  const shuffled = plan({ acceptQuality: [64, 16, 80, 32], videos: mk([80, 64, 32, 16]) }, { quality: 0 });
  ok('accept_quality 乱序 [64,16,80,32] + 自动 → 仍取最高档 80',
    shuffled.video?.quality === 80, `track=${shuffled.video?.quality}`);

  // 边界：accept 为空数组时必须回退到实际轨道最高档（不能因 Math.max() 得 -Infinity）
  const emptyAccept = plan({ acceptQuality: [], videos: mk([80, 64, 32, 16]) }, { quality: 0 });
  ok('accept_quality 为空 + 自动 → 回退实际最高档 80（Math.max 空数组边界）',
    emptyAccept.video?.quality === 80, `track=${emptyAccept.video?.quality}`);
}

console.log('\n[8] ★ pickExactTrack：UI 可用性判定必须精确匹配（"弹窗显示 1080P、下到 360P"的成因）');
{
  const { pickExactTrack, pickVideoTrack: pick } = await import('../src/core/api.js');
  const mk = (qs) => qs.map((q, i) => ({ quality: q, id: q, codecid: 7, bandwidth: 1000 + i }));

  // 复刻真实响应：accept_quality 宣称 [116,80,64,32,16]，dash.video 只有 [32,32,16,16]
  const tracks = mk([32, 32, 16, 16]);

  ok('pickExactTrack(116) === null（1080P60 并不存在，不能被标成"可用"）',
    pickExactTrack(tracks, 116, 'avc') === null, JSON.stringify(pickExactTrack(tracks, 116, 'avc')));
  ok('pickExactTrack(80) === null（1080P 并不存在）',
    pickExactTrack(tracks, 80, 'avc') === null);
  ok('pickExactTrack(64) === null（720P 并不存在）',
    pickExactTrack(tracks, 64, 'avc') === null);
  ok('pickExactTrack(32) 返回 480P 轨道',
    pickExactTrack(tracks, 32, 'avc')?.quality === 32);
  ok('pickExactTrack(16) 返回 360P 轨道',
    pickExactTrack(tracks, 16, 'avc')?.quality === 16);

  // 反证：这正是旧实现踩的坑 —— pickVideoTrack 对 116 会回退到 32 并返回非空
  ok('反证：pickVideoTrack(116) 会回退返回 32（非空 → 旧实现据此误判"116 可用"）',
    pick(tracks, 116, 'avc')?.quality === 32,
    '若这里变成 null，说明 pickVideoTrack 语义被改了，本测试的前提失效');

  // 同档多编码时按编码偏好挑
  const multi = [
    { quality: 80, id: 80, codecid: 12, bandwidth: 100 },
    { quality: 80, id: 80, codecid: 7, bandwidth: 100 },
  ];
  ok('同档多编码 → pickExactTrack 按 preferCodec 挑（avc → codecid 7）',
    pickExactTrack(multi, 80, 'avc')?.codecid === 7);
  ok('同档多编码 → preferCodec=hevc → codecid 12',
    pickExactTrack(multi, 80, 'hevc')?.codecid === 12);

  // 边界
  ok('空轨道列表 → null', pickExactTrack([], 80, 'avc') === null);
  ok('quality 非数字 → null', pickExactTrack(tracks, undefined, 'avc') === null);
}

console.log('\n[9] pickVideoTrack 无可用档时取"最接近的高档"，不是全表最高');
{
  const { pickVideoTrack: pick } = await import('../src/core/api.js');
  const mk = (qs) => qs.map((q, i) => ({ quality: q, id: q, codecid: 7, bandwidth: 1000 + i }));

  // 用户明确选 360P，但该视频最低只有 720P/1080P
  const v = mk([80, 64]);
  ok('请求 16 但只有 [80,64] → 取最接近的 64，而不是最高的 80',
    pick(v, 16, 'avc')?.quality === 64, `得到 ${pick(v, 16, 'avc')?.quality}`);

  const v2 = mk([80, 64, 32]);
  ok('请求 16 但只有 [80,64,32] → 取最接近的 32',
    pick(v2, 16, 'avc')?.quality === 32, `得到 ${pick(v2, 16, 'avc')?.quality}`);
}

console.log('\n[10] buildPlan 的候选档位 = accept ∪ 实际轨道（防虚报 / 防漏报）');
{
  const { buildPlan } = await import('../src/core/engine.js');
  const mk = (qs) => qs.map((q) => ({
    quality: q, id: q, codecid: 7, bandwidth: 1000 + q, url: 'https://cdn/v', backupUrls: [], size: 1000,
  }));
  const audio = [{ quality: 30280, id: 30280, codecid: 0, url: 'https://cdn/a', backupUrls: [], size: 100 }];
  const SET = { downloadMode: 'merge', preferCodec: 'avc', audioPreference: 'normal' };
  const plan = (pi, spec) => buildPlan({ mode: 'dash', videos: [], audios: audio, ...pi }, SET, spec);

  // 防"漏报"：accept 说只有 16，但轨道里明明有 80 → 自动应取 80
  const under = plan({ acceptQuality: [16], videos: mk([80, 64, 16]) }, { quality: 0 });
  ok('accept 漏报（只列 16）但轨道有 80 → 自动取 80（并集生效）',
    under.video?.quality === 80, `track=${under.video?.quality}`);

  // 防"虚报"：accept 说 116，轨道最大只有 32 → 自动的目标档是 116，但实际落到 32
  const over = plan({ acceptQuality: [116, 80, 64, 32, 16], videos: mk([32, 16]) }, { quality: 0 });
  ok('accept 虚报（列 116）但轨道最大 32 → 实际落到 32（不虚报）',
    over.video?.quality === 32, `track=${over.video?.quality}`);

  // 用户明确选 720P 且确实存在 → 精确使用
  const exact = plan({ acceptQuality: [116, 80, 64], videos: mk([80, 64]) }, { quality: 64 });
  ok('明确选 720P(64) 且存在 → 精确用 64（不升到 80）',
    exact.video?.quality === 64, `track=${exact.video?.quality}`);
}

console.log('\n' + (fail === 0 ? '✅ 清晰度挑选测试完成，失败 0 项' : '❌ 清晰度挑选测试完成，失败 ' + fail + ' 项') + '（通过 ' + pass + '）' + '\n');
process.exit(fail === 0 ? 0 : 1);
