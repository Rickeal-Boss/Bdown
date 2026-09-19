/**
 * 章节（chapters）模块自检（不联网）。
 *
 * 运行：node tools/test-chapters.mjs
 */
import {
  parseViewPoints,
  chaptersToTxt,
  chaptersToVtt,
  formatTimestamp,
  formatVttTimestamp,
} from '../src/core/chapters.js';

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n[1] 输入容错（脏数据不能崩）');
{
  for (const v of [null, undefined, '', 0, {}, [], [null], [''], [{}], 'not-an-array']) {
    ok(`parseViewPoints(${JSON.stringify(v)}) -> []`, eq(parseViewPoints(v), []));
  }
  ok('条目缺 content 被丢弃', eq(parseViewPoints([{ from: 1 }]), []));
  ok('条目缺时间被丢弃', eq(parseViewPoints([{ content: 'x' }]), []));
  ok('负数时间被丢弃', eq(parseViewPoints([{ from: -5, content: 'x' }]), []));
}

console.log('\n[2] 字段名兼容（B 站未公开文档，社区有多种写法）');
{
  ok('from/to/content 写法', eq(parseViewPoints([{ from: 0, to: 10, content: 'A' }]), [{ start: 0, end: 10, content: 'A' }]));
  ok('start/end/title 写法', eq(parseViewPoints([{ start: 3, end: 9, title: 'B' }]), [{ start: 3, end: 9, content: 'B' }]));
  ok('time/text 写法', eq(parseViewPoints([{ time: 5, text: 'C' }]), [{ start: 5, end: null, content: 'C' }]));
  // B 站 view_points 用秒；超过 1e6 才当成毫秒兜底（正常视频不会到 11 天）
  ok('超大值按毫秒换算', parseViewPoints([{ from: 1200000, content: 'D' }])[0].start === 1200);
  ok('普通值就是秒，不被换算', parseViewPoints([{ from: 83, content: 'D' }])[0].start === 83);
}

console.log('\n[3] 排序与 end 补全');
{
  const raw = [
    { from: 83, to: 200, content: '主题一' },
    { from: 0, content: '开场' },
    { from: 3725, content: '结尾' },
  ];
  const ch = parseViewPoints(raw, { duration: 3800 });
  ok('按 start 升序', eq(ch.map((c) => c.start), [0, 83, 3725]));
  ok('缺 end 的用下一条 start 补', ch[0].end === 83);
  ok('已给 end 的保留原值', ch[1].end === 200);
  ok('最后一条用总时长补', ch[2].end === 3800);
  const noDur = parseViewPoints(raw);
  ok('没给时长时最后一条 end 为 null', noDur[2].end === null);
}

console.log('\n[4] 时间戳格式');
{
  ok('0 -> 0:00', formatTimestamp(0) === '0:00');
  ok('83 -> 1:23', formatTimestamp(83) === '1:23');
  ok('605 -> 10:05', formatTimestamp(605) === '10:05');
  ok('3725 -> 1:02:05', formatTimestamp(3725) === '1:02:05');
  ok('vtt: 0 -> 00:00:00.000', formatVttTimestamp(0) === '00:00:00.000');
  ok('vtt: 83 -> 00:01:23.000', formatVttTimestamp(83) === '00:01:23.000');
  ok('vtt 含毫秒', formatVttTimestamp(1.5) === '00:00:01.500');
}

console.log('\n[5] 导出格式');
{
  const ch = [{ start: 0, end: 83, content: '开场' }, { start: 83, end: 200, content: '主题一' }];
  const txt = chaptersToTxt(ch);
  ok('txt 是 YouTube 风格两行', eq(txt, '0:00 开场\n1:23 主题一\n'), JSON.stringify(txt));
  const vtt = chaptersToVtt(ch);
  ok('vtt 以 WEBVTT 开头', vtt.startsWith('WEBVTT'));
  ok('vtt 含时间区间行', vtt.includes('00:00:00.000 --> 00:01:23.000'));
  ok('vtt 含章节标题', vtt.includes('主题一'));
  ok('空列表 txt -> 空串', chaptersToTxt([]) === '');
  ok('空列表 vtt -> WEBVTT\\n', chaptersToVtt([]) === 'WEBVTT\n');
  ok('非数组输入不崩', chaptersToTxt(null) === '' && chaptersToVtt(undefined) === 'WEBVTT\n');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 章节模块自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
