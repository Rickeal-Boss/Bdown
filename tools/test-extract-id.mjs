/**
 * `extractVideoId` 的回归测试（不联网）。
 *
 * 为什么单独给它建套件：它是**每一次下载的入口** —— 悬浮按钮、播放器按钮、
 * 右键菜单、popup 的「粘贴链接」全都先经过它。历史上它**零测试覆盖**，
 * 于是一个真 bug 长期潜伏：课程链接 `/cheese/play/ep123` 会被通用 `/ep(\d+)`
 * 抢先匹配，解析成 `{epId}`（番剧），导致 playurl 打到 /pgc 端点、课程任务必失败。
 * 而代码库的 pugv 支持（FNVAL_PUGV / cheeseSeason / engine 透传 cheeseId）
 * 一直是完整的 —— 唯独入口解析这一环缺失，整条链路从 UI 走不到。
 *
 * 运行：node tools/test-extract-id.mjs
 */
import { extractVideoId } from '../src/core/util.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

/** 断言解析结果。 */
const eq = (input, expected, name) => {
  const got = extractVideoId(input);
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  ok(name || input, g === e, `得到 ${g}，期待 ${e}`);
};

console.log('\n[1] 普通视频（BV / av / aid）');
{
  eq('BV1uv411q7Mv', { bvid: 'BV1uv411q7Mv' });
  eq('https://www.bilibili.com/video/BV1uv411q7Mv', { bvid: 'BV1uv411q7Mv' });
  eq('https://www.bilibili.com/video/BV1uv411q7Mv?p=3&spm_id_from=333.1007', { bvid: 'BV1uv411q7Mv' });
  eq('https://www.bilibili.com/video/av170001', { aid: 170001 });
  eq('av170001', { aid: 170001 });
  eq('https://www.bilibili.com/video/av170001/?p=1', { aid: 170001 });
  eq('https://api.bilibili.com/x/web-interface/view?aid=170001', { aid: 170001 });
  // 裸 BV 号（用户从别处复制）
  eq('  BV1uv411q7Mv  ', { bvid: 'BV1uv411q7Mv' }, '带首尾空格的裸 BV 号');
}

console.log('\n[2] 番剧（ep / ss）');
{
  eq('https://www.bilibili.com/bangumi/play/ep123456', { epId: 123456 });
  eq('https://www.bilibili.com/bangumi/play/ss67890', { seasonId: 67890 });
  eq('https://www.bilibili.com/bangumi/play/ep123456?from=search', { epId: 123456 });
  eq('https://api.bilibili.com/pgc/view/web/season?ep_id=123456', { epId: 123456 });
  eq('https://api.bilibili.com/pgc/view/web/season?season_id=67890', { seasonId: 67890 });
}

console.log('\n[3] ★ 课程（cheese / pugv）—— 本套件存在的主要理由');
{
  // 关键：必须解析成 cheeseId，而不是被通用 /ep 抢走变成 epId。
  // 若这里得到 {epId:...}，说明 /cheese/play/ep 分支被移除或排到了 /ep 之后。
  eq('https://www.bilibili.com/cheese/play/ep123456', { cheeseId: 123456 });
  eq('https://www.bilibili.com/cheese/play/ss67890', { cheeseId: 67890 });
  eq('https://www.bilibili.com/cheese/play/ep123456?csource=common_search', { cheeseId: 123456 });

  // 显式反例：确认它**没有**被当成番剧
  const course = extractVideoId('https://www.bilibili.com/cheese/play/ep123456');
  ok('课程链接不得被解析为 epId（否则会打到 /pgc 错误端点）',
    course && course.epId === undefined, JSON.stringify(course));
  ok('课程链接不得被解析为 seasonId',
    course && course.seasonId === undefined, JSON.stringify(course));

  // 顺序依赖：番剧 ep 仍然正常（不能被 cheese 分支吃掉）
  const bangumi = extractVideoId('https://www.bilibili.com/bangumi/play/ep123456');
  ok('番剧 ep 仍然解析为 epId（cheese 分支没有误吞）',
    bangumi && bangumi.epId === 123456 && bangumi.cheeseId === undefined, JSON.stringify(bangumi));
}

console.log('\n[4] 边界与非视频输入');
{
  ok('空串 → null', extractVideoId('') === null);
  ok('null → null', extractVideoId(null) === null);
  ok('undefined → null', extractVideoId(undefined) === null);
  ok('普通文本 → null', extractVideoId('这是一段说明文字') === null);
  ok('非视频页 URL → null', extractVideoId('https://www.bilibili.com/account/history') === null);
  ok('不完整 BV（长度不足）→ null', extractVideoId('BV1uv411') === null);

  // BV 优先于其它形态（一个链接里同时出现时）
  const mixed = extractVideoId('https://www.bilibili.com/video/BV1uv411q7Mv?aid=999');
  ok('BV 与 aid 同时出现 → 优先 BV',
    mixed && mixed.bvid === 'BV1uv411q7Mv', JSON.stringify(mixed));
}

console.log('\n[5] 真实世界的脏链接（带各种追踪参数）');
{
  eq('https://www.bilibili.com/video/BV1uv411q7Mv/?spm_id_from=333.1007.0.0&vd_source=abc',
    { bvid: 'BV1uv411q7Mv' });
  eq('https://m.bilibili.com/video/BV1uv411q7Mv',
    { bvid: 'BV1uv411q7Mv' }, '移动端域名');
  eq('https://b23.tv/abcdefg', null, 'b23.tv 短链无 ID → null（需跟随重定向后才能解析）');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} extractVideoId 自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
