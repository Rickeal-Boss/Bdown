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

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 清晰度挑选测试${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);

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

console.log('\n' + (fail === 0 ? '✅ 清晰度挑选测试完成，失败 0 项' : '❌ 清晰度挑选测试完成，失败 ' + fail + ' 项') + '（通过 ' + pass + '）' + '\n');
process.exit(fail === 0 ? 0 : 1);
