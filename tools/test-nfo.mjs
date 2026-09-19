/**
 * NFO 元数据模块自检（不联网，纯函数）。
 *
 * 运行：node tools/test-nfo.mjs
 */
import { escapeXml, isoDate, runtimeMinutes, buildNfo, buildTvShowNfo, nfoFilename } from '../src/core/nfo.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

console.log('\n[1] XML 转义（B 站标题/简介里确实有 & 和引号）');
{
  ok('& -> &amp;', escapeXml('A & B') === 'A &amp; B', escapeXml('A & B'));
  ok('< -> &lt;', escapeXml('a<b') === 'a&lt;b');
  ok('> -> &gt;', escapeXml('a>b') === 'a&gt;b');
  ok('" -> &quot;', escapeXml('say "hi"') === 'say &quot;hi&quot;');
  ok("' -> &apos;", escapeXml("it's") === 'it&apos;s');
  ok('null -> 空串', escapeXml(null) === '');
  ok('undefined -> 空串', escapeXml(undefined) === '');
  ok('数字也能处理', escapeXml(2024) === '2024');
}

console.log('\n[2] 日期换算（B 站 pubdate 是 Unix 秒）');
{
  ok('0 -> 空串（不是 1970-01-01）', isoDate(0) === '', isoDate(0));
  ok('负数 -> 空串', isoDate(-5) === '');
  ok('NaN -> 空串', isoDate('abc') === '');
  // 2024-01-02 00:00:00 UTC
  const d = isoDate(1704153600);
  ok('Unix 秒 -> YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(d), d);
  ok('年份正确', d.startsWith('2024'), d);
}

console.log('\n[3] 时长换算（Jellyfin 的 runtime 单位是分钟）');
{
  ok('0 -> 0', runtimeMinutes(0) === 0);
  ok('负数 -> 0', runtimeMinutes(-10) === 0);
  ok('125 秒 -> 2 分钟', runtimeMinutes(125) === 2, String(runtimeMinutes(125)));
  ok('60 秒 -> 1 分钟', runtimeMinutes(60) === 1);
  ok('非法 -> 0', runtimeMinutes('x') === 0);
}

console.log('\n[4] movie 形态（普通 / 单P）');
{
  const nfo = buildNfo({
    kind: 'movie',
    title: '测试视频',
    plot: '简介 & 内容',
    pubdate: 1704153600,
    duration: 754,
    cover: 'https://i0.hdslb.com/cover.jpg',
    owner: { name: '某UP', mid: 123 },
    genre: '知识',
    bvid: 'BV1xx411c7mD',
  });
  ok('根节点是 movie', nfo.includes('<movie>') && nfo.includes('</movie>'));
  ok('有 XML 声明', nfo.startsWith('<?xml'));
  ok('标题已写入', nfo.includes('<title>测试视频</title>'));
  ok('简介里的 & 被转义', nfo.includes('简介 &amp; 内容'), nfo);
  ok('runtime = 13 分钟（754 秒）', nfo.includes('<runtime>13</runtime>'), nfo);
  ok('有 premiered', nfo.includes('<premiered>2024'));
  ok('year = 2024', nfo.includes('<year>2024</year>'));
  ok('studio = bilibili', nfo.includes('<studio>bilibili</studio>'));
  ok('UP 主放进 actor', nfo.includes('<actor>') && nfo.includes('<name>某UP</name>'));
  ok('封面写入 thumb', nfo.includes('aspect="poster"'));
  ok('BV 号写入 id 与 uniqueid', nfo.includes('<id>BV1xx411c7mD</id>') && nfo.includes('type="bilibili"'));
}

console.log('\n[5] episode 形态（番剧 / 多P）');
{
  const nfo = buildNfo({
    kind: 'episode',
    title: '总标题 - 第二集',
    showTitle: '总标题',
    season: 1,
    episode: 2,
    duration: 600,
    bvid: 'BV1xx411c7mD',
  });
  ok('根节点是 episodedetails', nfo.includes('<episodedetails>'));
  ok('有 showtitle', nfo.includes('<showtitle>总标题</showtitle>'));
  ok('有 season', nfo.includes('<season>1</season>'));
  ok('有 episode', nfo.includes('<episode>2</episode>'));
}

console.log('\n[6] 缺字段不写空标签（Jellyfin 对空值容忍度差）');
{
  const nfo = buildNfo({ title: '只有标题' });
  ok('没有空的 plot', !nfo.includes('<plot></plot>'));
  ok('没有空的 year', !nfo.includes('<year></year>'));
  ok('没有空的 runtime', !nfo.includes('<runtime></runtime>'));
  ok('没有空的 thumb', !nfo.includes('<thumb'));
  ok('仍然有 title', nfo.includes('<title>只有标题</title>'));
  ok('完全空输入也不崩', typeof buildNfo() === 'string' && buildNfo().includes('<movie>'));
  ok('空对象也不崩', buildNfo({}).includes('<movie>'));
}

console.log('\n[7] tvshow 形态');
{
  const nfo = buildTvShowNfo({ title: '合集', plot: 'x', pubdate: 1704153600, bvid: 'BV1xx411c7mD' });
  ok('根节点是 tvshow', nfo.includes('<tvshow>') && nfo.includes('</tvshow>'));
  ok('有 title', nfo.includes('<title>合集</title>'));
  ok('有 premiered', nfo.includes('<premiered>2024'));
  ok('空输入不崩', buildTvShowNfo({}).includes('<tvshow>'));
}

console.log('\n[8] 文件名（与媒体文件同基名，多P 不互相覆盖）');
{
  ok('x.mp4 -> x.nfo', nfoFilename('x.mp4') === 'x.nfo', nfoFilename('x.mp4'));
  ok('标题.P01.mkv -> 标题.P01.nfo', nfoFilename('标题.P01.mkv') === '标题.P01.nfo');
  ok('无扩展名也能处理', nfoFilename('abc') === 'abc.nfo');
  ok('空 -> movie.nfo', nfoFilename('') === 'movie.nfo');
  ok('undefined -> movie.nfo', nfoFilename() === 'movie.nfo');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} NFO 模块自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
