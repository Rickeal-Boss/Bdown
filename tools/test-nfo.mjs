/**
 * NFO 元数据模块自检（不联网，纯函数）。
 *
 * 运行：node tools/test-nfo.mjs
 */
import {
  escapeXml, truncateText, isoDate, runtimeMinutes,
  buildNfo, buildTvShowNfo, nfoFilename,
} from '../src/core/nfo.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

/**
 * 即使用 Node 内置 DOMParser 也要先做一层轻量校验：
 * 不同实现对"控制字符"的判定不一致（有些会在解析前静默剥离），
 * 直接依赖 parsererror 可能放过 NFO 真正会被 Jellyfin 拒掉的那些字符。
 *
 * Node 22 目前**没有** DOMParser（实测 `new DOMParser()` 抛 ReferenceError），
 * 所以这里提供零依赖的等价校验，CI 一定能跑。
 *
 * ⚠ 这里**不能带 `g` 标志**：带 `g` 的正则配合 `.test()` 是有状态的
 * （每次匹配后推进 lastIndex），多次调用会交替返回 true/false ——
 * 结果就是这个校验**时灵时不灵**，属于典型的测试假阴性陷阱。
 * （`String.replace` 配 `g` 是安全的，因为 replace 结束后会重置 lastIndex。）
 */
const CTRL = new RegExp('['
  + String.fromCharCode(0) + '-' + String.fromCharCode(8)
  + String.fromCharCode(11) + String.fromCharCode(12)
  + String.fromCharCode(14) + '-' + String.fromCharCode(31)
  + String.fromCharCode(127) + ']');

function xmlProblems(xml) {
  const problems = [];
  if (CTRL.test(xml)) problems.push('含 XML 1.0 非法控制字符');
  // 未转义的裸 &（合法转义是 &amp; &lt; &gt; &quot; &apos; &#...;）
  const ampOk = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
  const stripped = xml.replace(ampOk, '');
  if (/&/.test(stripped)) problems.push('存在未转义的 &');
  // 极简配平检查
  for (const tag of ['movie', 'episodedetails', 'tvshow', 'actor']) {
    const open = (xml.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) problems.push(`${tag} 标签未配平 (${open}/${close})`);
  }
  return problems;
}

const hasDOMParser = typeof DOMParser !== 'undefined';

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

console.log('\n[2] 控制字符必须剥离（否则整个 NFO 变成非法 XML，Jellyfin 静默丢弃）');
{
  ok('NUL 被剥离', escapeXml('a' + NUL + 'b') === 'ab', JSON.stringify(escapeXml('a' + NUL + 'b')));
  ok('BEL / ESC / DEL 被剥离', escapeXml('a' + BEL + ESC + DEL + 'b') === 'ab');
  ok('换行与制表符是合法 XML 字符，保留', escapeXml('a\nb\tc') === 'a\nb\tc');
  ok('简介含控制字符时，产出的 NFO 不含它们',
    !buildNfo({ title: 't', plot: 'x' + NUL + 'y' }).includes(NUL));
  ok('标题含控制字符时也不含它们',
    !buildNfo({ title: 't' + BEL }).includes(BEL));
}

console.log('\n[3] 超长简介截断（B 站简介可达数万字符）');
{
  ok('短文本原样返回', truncateText('abc', 10) === 'abc');
  ok('超长被截断并带省略号', truncateText('a'.repeat(100), 10).endsWith('…'));
  ok('截断后长度 = max + 1（省略号）', truncateText('a'.repeat(100), 10).length === 11);
  ok('默认上限 10000', truncateText('a'.repeat(20000)).length === 10001);
  ok('null -> 空串', truncateText(null) === '');
  const nfo = buildNfo({ title: 't', plot: 'x'.repeat(20000) });
  ok('NFO 里的简介确实被截断', nfo.length < 20000, `len=${nfo.length}`);
}

console.log('\n[4] 日期换算（B 站 pubdate 是 Unix 秒；必须按北京时间）');
{
  ok('0 -> 空串（不是 1970-01-01）', isoDate(0) === '', isoDate(0));
  ok('负数 -> 空串', isoDate(-5) === '');
  ok('NaN -> 空串', isoDate('abc') === '');
  ok('格式是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(isoDate(1704153600)), isoDate(1704153600));
  // 2024-01-01 17:00 UTC = 2024-01-02 01:00 北京时间。
  // 按 UTC 会得到 2024-01-01（差一天），按北京时间才是 2024-01-02。
  ok('★ 跨日时刻按北京时区取日期', isoDate(1704067200 + 17 * 3600) === '2024-01-02', isoDate(1704067200 + 17 * 3600));
}

console.log('\n[5] 时长换算（Jellyfin 的 runtime 单位是分钟）');
{
  ok('0 -> 0', runtimeMinutes(0) === 0);
  ok('负数 -> 0', runtimeMinutes(-10) === 0);
  ok('125 秒 -> 2 分钟', runtimeMinutes(125) === 2, String(runtimeMinutes(125)));
  ok('60 秒 -> 1 分钟', runtimeMinutes(60) === 1);
  ok('非法 -> 0', runtimeMinutes('x') === 0);
}

console.log('\n[6] movie 形态（普通视频，含多P 也是 movie）');
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
    aid: 2,
  });
  ok('根节点是 movie', nfo.includes('<movie>') && nfo.includes('</movie>'));
  ok('有 XML 声明', nfo.startsWith('<?xml'));
  ok('标题已写入', nfo.includes('<title>测试视频</title>'));
  ok('简介里的 & 被转义', nfo.includes('简介 &amp; 内容'), nfo);
  ok('runtime = 13 分钟（754 秒）', nfo.includes('<runtime>13</runtime>'), nfo);
  ok('year = 2024', nfo.includes('<year>2024</year>'));
  ok('UP 主放进 actor', nfo.includes('<actor>') && nfo.includes('<name>某UP</name>'));
  ok('封面写入 thumb', nfo.includes('aspect="poster"'));
  ok('BV 号写入 id 与 uniqueid', nfo.includes('<id>BV1xx411c7mD</id>') && nfo.includes('type="bilibili"'));
  ok('aid 写入 uniqueid type="avid"', nfo.includes('type="avid">2<'), nfo);
  ok('有 source', nfo.includes('<source>Bilibili</source>'));
  ok('有 website（回链到原视频）', nfo.includes('<website>https://www.bilibili.com/video/BV1xx411c7mD</website>'));
  ok('不写 streamdetails（不覆盖 Jellyfin 自己的探测）', !nfo.includes('streamdetails'));
}

console.log('\n[7] episode 形态（番剧 / 课程）');
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

console.log('\n[8] 缺字段不写空标签（Jellyfin 对空值容忍度差）');
{
  const nfo = buildNfo({ title: '只有标题' });
  // 断言统一收紧为「元素完全不出现」而不是「不出现空标签」。
  // 因为缺陷的实际形态往往是 <x>0</x> 或 <x> </x>（非空标签），
  // 只查空标签会正好绕开 —— vStage 那次就是这个病的原型。
  ok('没有 plot 元素', !nfo.includes('<plot'), nfo);
  ok('没有 year 元素', !nfo.includes('<year'), nfo);
  ok('没有 runtime 元素', !nfo.includes('<runtime'), nfo);
  ok('没有 thumb 元素', !nfo.includes('<thumb'), nfo);
  ok('没有 website 元素', !nfo.includes('<website'), nfo);
  // 注意断言要带闭合尖括号：根元素 <episodedetails> 本身就含子串 "<episode"，
  // 写成 includes('<episode') 会永远为真（假阳性），必须写 '<episode>'
  const zero = buildNfo({ title: 'x', duration: 0 });
  ok('★ runtime 为 0 时整个元素省略（Jellyfin 会当成"片长 0 分钟"）',
    !zero.includes('<runtime>'), zero);
  const zeroEp = buildNfo({ kind: 'episode', title: 'x', season: 0, episode: 0 });
  ok('★ season 为 0 时省略', !zeroEp.includes('<season>'), zeroEp);
  ok('★ episode 为 0 时省略', !zeroEp.includes('<episode>'), zeroEp);
  ok('仍然有 title', nfo.includes('<title>只有标题</title>'));
  ok('完全空输入也不崩', typeof buildNfo() === 'string' && buildNfo().includes('<movie>'));
  ok('空对象也不崩', buildNfo({}).includes('<movie>'));

  // ★ <title> 是 Jellyfin/Kodi 的必需字段：没有它条目无法入库，整个 NFO 白写。
  //   必须硬断言「一定存在且非空」，只查 '未知标题' 的邻近字符不算数。
  ok('★ 空输入也一定有非空 title', buildNfo().includes('<title>未知标题</title>'), buildNfo());
  ok('★ 空输入也一定有非空 title（硬断言：元素存在）', buildNfo().includes('<title>'), buildNfo());
  ok('title 缺失时回退到 bvid',
    buildNfo({ bvid: 'BV1xx411c7mD' }).includes('<title>BV1xx411c7mD</title>'),
    buildNfo({ bvid: 'BV1xx411c7mD' }));
  ok('title 与 bvid 都缺时回退到 av 号',
    buildNfo({ aid: 2 }).includes('<title>av2</title>'), buildNfo({ aid: 2 }));
  ok('tvshow 也保证非空 title', buildTvShowNfo({}).includes('<title>未知标题</title>'));
}

console.log('\n[8b] 换行处理：title 折叠成空格，plot 保留换行');
{
  const nfo = buildNfo({ title: '标题\n第二行', plot: '第一行\n第二行' });
  const titleLine = (nfo.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const plotLine = (nfo.match(/<plot>([\s\S]*?)<\/plot>/) || [])[1] || '';
  ok('title 的换行被折叠成空格', !titleLine.includes('\n') && titleLine.includes(' '), titleLine);
  ok('title 仍保留两行内容', titleLine.includes('标题') && titleLine.includes('第二行'), titleLine);
  ok('plot **保留**换行（正常的段落分隔）', plotLine.includes('\n'), plotLine);
  // 两者互锁：确认不是"全都折叠"或"全都不折叠"
  ok('两者行为确实不同（互锁，防止一起改坏）',
    !titleLine.includes('\n') && plotLine.includes('\n'));
}

console.log('\n[9] tvshow 形态');
{
  const nfo = buildTvShowNfo({ title: '合集', plot: 'x', pubdate: 1704153600, bvid: 'BV1xx411c7mD' });
  ok('根节点是 tvshow', nfo.includes('<tvshow>') && nfo.includes('</tvshow>'));
  ok('有 title', nfo.includes('<title>合集</title>'));
  ok('有 premiered', nfo.includes('<premiered>2024'));
  ok('空输入不崩', buildTvShowNfo({}).includes('<tvshow>'));
}

console.log('\n[10] 文件名（与媒体文件同基名，多P 不互相覆盖）');
{
  ok('x.mp4 -> x.nfo', nfoFilename('x.mp4') === 'x.nfo', nfoFilename('x.mp4'));
  ok('标题.P01.mkv -> 标题.P01.nfo', nfoFilename('标题.P01.mkv') === '标题.P01.nfo');
  ok('无扩展名也能处理', nfoFilename('abc') === 'abc.nfo');
  ok('空 -> movie.nfo', nfoFilename('') === 'movie.nfo');
  ok('undefined -> movie.nfo', nfoFilename() === 'movie.nfo');
}

console.log('\n[11] 产物可被 XML 解析器解析（有 DOMParser 就用，否则用零依赖校验）');
{
  const movie = buildNfo({
    kind: 'movie', title: '测试 & 视频', plot: '简介 <b>粗体</b>',
    pubdate: 1704153600, duration: 754, cover: 'https://x/c.jpg',
    owner: { name: '某UP' }, genre: '知识', bvid: 'BV1xx411c7mD', aid: 2,
  });
  const episode = buildNfo({
    kind: 'episode', title: 'E1', showTitle: 'S', season: 1, episode: 1, bvid: 'BV1xx411c7mD',
  });
  const tv = buildTvShowNfo({ title: 'S', bvid: 'BV1xx411c7mD' });

  for (const [label, xml] of [['movie', movie], ['episode', episode], ['tvshow', tv]]) {
    const problems = xmlProblems(xml);
    ok(`${label}：轻量校验无问题（控制字符 / 裸 & / 标签配平）`,
      problems.length === 0, problems.join('; '));
  }

  if (hasDOMParser) {
    const doc = new DOMParser().parseFromString(movie, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    ok('DOMParser：movie 解析无错', !err, err && err.textContent);
    ok('DOMParser：根元素 = movie', doc.documentElement.nodeName === 'movie', doc.documentElement.nodeName);
    ok('DOMParser：能查到 title', doc.getElementsByTagName('title').length === 1);
  } else {
    console.log('  · 本环境无 DOMParser，已用零依赖校验覆盖（CI 一定能跑）');
  }

  // 控制字符是本项目踩过的坑：修复前会让整个 XML 解析失败
  const dirty = buildNfo({ title: 't', plot: 'x' + NUL + 'y' });
  ok('含控制字符的简介不会破坏 XML 合法性',
    xmlProblems(dirty).length === 0, xmlProblems(dirty).join('; '));
}

console.log('\n[12] 空白字符串不能绕过回退链 / 判空（qa-lead 复核发现的漏网形态）');
{
  // A1：title 只含换行/空白时，回退链必须生效
  const nl = buildNfo({ title: '\n', bvid: 'BV1xx411c7mD' });
  ok('★ title 只含换行时回退到 bvid', nl.includes('<title>BV1xx411c7mD</title>'), nl);
  const sp = buildNfo({ title: '   ', aid: 2 });
  ok('★ title 只含空格时回退到 av 号', sp.includes('<title>av2</title>'), sp);
  const both = buildNfo({ title: '\n\t  ' });
  ok('★ title 只含空白且无 bvid/aid 时 -> 未知标题',
    both.includes('<title>未知标题</title>'), both);
  ok('★ 任何情况下都有非空 title 元素',
    [nl, sp, both, buildNfo(), buildNfo({})].every((x) => /<title>[^<]+<\/title>/.test(x)));

  // A2：genre 只有空白 -> 不输出（Jellyfin 会当成奇怪的分类）
  const g = buildNfo({ title: 'x', genre: '   ' });
  ok('genre 只有空白时不输出', !g.includes('<genre'), g);
  const g2 = buildNfo({ title: 'x', genre: ' 知识 ' });
  ok('genre 有内容时保留（不误杀）', g2.includes('<genre>'), g2);

  // A3：tvshow 同病
  const tv = buildTvShowNfo({ title: '\n', bvid: 'BV1xx411c7mD' });
  ok('tvshow 的 title 只含换行时也回退到 bvid',
    tv.includes('<title>BV1xx411c7mD</title>'), tv);
}

console.log('\n[13] 校验器本身必须无状态（防 lastIndex 陷阱）');
{
  const clean = buildNfo({ title: 'a', plot: 'b', bvid: 'BV1xx411c7mD' });
  const dirty = buildNfo({ title: 'a', plot: 'x' + NUL + 'y', bvid: 'BV1xx411c7mD' });
  // 交替调用：若 CTRL 正则带 g 标志，这里会时灵时不灵
  const r1 = xmlProblems(clean).length;
  const r2 = xmlProblems(dirty).length;
  const r3 = xmlProblems(clean).length;
  const r4 = xmlProblems(dirty).length;
  ok('干净文档连续两次结果一致', r1 === r3, `${r1} vs ${r3}`);
  ok('脏文档连续两次结果一致', r2 === r4, `${r2} vs ${r4}`);
  ok('干净文档 = 0 问题', r1 === 0, String(r1));
  ok('脏文档 = 有问题（控制字符被检出）', r2 > 0, String(r2));
}

console.log('\n[14] 标签白名单（避免"测试抄实现"的循环论证）');
{
  // 不从实现里抄黑名单 —— 先列出**允许出现**的标签，再断言没有越界的。
  // 这样新增标签时会失败并提醒确认，而不是被一个抄来的黑名单悄悄放过。
  const ALLOWED = new Set([
    'movie', 'episodedetails', 'tvshow',
    'title', 'showtitle', 'season', 'episode', 'plot',
    'year', 'premiered', 'aired', 'runtime', 'genre',
    'actor', 'name', 'role', 'thumb',
    'source', 'website', 'id', 'uniqueid',
  ]);
  for (const [label, fn] of [['movie', buildNfo], ['tvshow', buildTvShowNfo]]) {
    for (const meta of [
      { title: 't', plot: 'p', pubdate: 1704153600, duration: 754, cover: 'https://x/c.jpg',
        owner: { name: 'u', face: 'https://x/f.jpg' }, genre: '知识', bvid: 'BV1xx411c7mD', aid: 2 },
      { kind: 'episode', title: 'e', showTitle: 's', season: 1, episode: 3, bvid: 'BV1xx411c7mD' },
      {},
    ]) {
      const xml = fn(meta);
      const tags = [...xml.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]);
      const unknown = tags.filter((t) => !ALLOWED.has(t));
      ok(`${label} 只输出白名单内的标签（${JSON.stringify(meta).slice(0, 24)}…）`,
        unknown.length === 0, `越界标签: ${[...new Set(unknown)].join(', ')}`);
    }
  }
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} NFO 模块自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
