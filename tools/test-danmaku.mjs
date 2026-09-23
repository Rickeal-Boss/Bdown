/**
 * 弹幕模块自检（不联网）。
 *
 * 为什么需要它：`danmaku.js` 此前**零测试覆盖**，而它处理的是**完全不可控的用户输入**
 * （B 站弹幕文本）。ASS 格式里 `{` `}` `\` 是控制字符（`{\...}` 是 override tag，
 * `\N` 是强制换行），弹幕里出现这些字符很常见（颜文字、代码片段、`{\an8}` 之类）。
 * 一旦转义漏掉，产出的是**结构损坏的 ASS** —— 播放器可能整段不显示，或显示出控制字符。
 *
 * 覆盖不到：`parseDanmakuXml()` 依赖浏览器 `DOMParser`，Node 环境无此 API，
 * 故本套件只测**导出与过滤**这些纯函数。XML 解析的健壮性需另用 mock DOM 验证。
 *
 * 运行：node tools/test-danmaku.mjs
 */
import { danmakuToAss, danmakuToSrt, danmakuToText, filterDanmaku } from '../src/core/danmaku.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const mk = (time, text, mode = 1) => ({ time, text, mode, fontSize: 25, color: 0xffffff });
const OPTS = {
  width: 1920,
  height: 1080,
  opacity: 0.85,
  fontScale: 1,
  fontName: 'Microsoft YaHei',
  title: '测试标题',
};

/** 取出 ASS 的 Dialogue 事件行。 */
function dialogueLines(ass) {
  return ass.slice(ass.indexOf('[Events]')).split('\n').filter((l) => l.startsWith('Dialogue:'));
}

/** 取 Dialogue 行的 Text 字段：ASS 规定前 9 个逗号后剩下的全部算 Text。 */
function textField(line) {
  const withoutPrefix = line.replace(/^Dialogue:\s*/, '');
  const parts = withoutPrefix.split(',');
  return parts.slice(9).join(',');
}

console.log('\n[1] ASS 基础结构');
{
  const list = [mk(1, '第一条'), mk(2, '第二条')];
  const ass = danmakuToAss(list, OPTS);
  ok('含 [Script Info]', ass.includes('[Script Info]'));
  ok('含 [V4+ Styles]', ass.includes('[V4+ Styles]'));
  ok('含 [Events]', ass.includes('[Events]'));
  ok('每个弹幕都生成了 Dialogue 行', dialogueLines(ass).length === list.length,
    `得到 ${dialogueLines(ass).length}，期望 ${list.length}`);
}

console.log('\n[2] ★ ASS 控制字符必须被转义（弹幕文本完全不可控）');
{
  const hostile = [
    mk(1, '花括号 { 测试'),
    mk(2, '右花括号 } 测试'),
    mk(3, '反斜杠 \\ 测试'),
    mk(4, '字面换行 \\N 测试'),
    mk(5, '字面硬空格 \\h 测试'),
    mk(6, '组合 {\\an8\\fs99} 测试'),
  ];
  const ass = danmakuToAss(hostile, OPTS);
  const lines = dialogueLines(ass);
  ok('全部事件都生成了（没有因转义而丢事件）', lines.length === hostile.length,
    `得到 ${lines.length}，期望 ${hostile.length}`);

  // 关键：用户文本里的 { } 必须被转义成 `\{` `\}`。
  //
  // 注意断言的写法：转义后的 `\{` 本身**含有** `{` 字符，所以不能简单
  // 判断"是否含 { }" —— 那会把正确转义误判成失败。真正要排除的是
  // **未被反斜杠转义的裸花括号**（它会开闭 ASS 的 override 块）。
  const BARE_BRACE = /(?<!\\)[{}]/; // 前面没有反斜杠的 { 或 }
  const offenders = [];
  for (const line of lines) {
    const text = textField(line);
    // 去掉生成器自己加在开头的 override 块（形如 {\pos(...)\fn...}）
    const afterTags = text.replace(/^\{[^}]*\}/, '');
    if (BARE_BRACE.test(afterTags)) offenders.push(afterTags);
  }
  ok('用户文本中的 { } 已被转义（无裸花括号，不会意外开闭 override 块）',
    offenders.length === 0, offenders.length ? JSON.stringify(offenders[0]) : '');
}

console.log('\n[3] ★ 真换行不能截断 ASS 事件（换行必须转成 \\N）');
{
  const withNewline = [mk(1, '第一行\n第二行'), mk(2, '普通')];
  const ass = danmakuToAss(withNewline, OPTS);
  const lines = dialogueLines(ass);
  ok('含真换行的弹幕不会多出/少掉事件行', lines.length === withNewline.length,
    `得到 ${lines.length}，期望 ${withNewline.length}`);
  const first = lines[0] || '';
  ok('换行被转成 \\N（而不是原样嵌入物理换行）',
    first.includes('\\N') && !textField(first).replace(/^\{[^}]*\}/, '').includes('\n'),
    JSON.stringify(textField(first).slice(0, 40)));
  ok('所有 Dialogue 行都还在同一"逻辑行"上（没有物理换行切断事件）',
    lines.every((l) => !l.includes('\r')), '存在裸 CR');
}

console.log('\n[4] 逗号安全（ASS 用逗号分隔字段）');
{
  const withComma = [mk(1, '逗号,逗号,逗号')];
  const ass = danmakuToAss(withComma, OPTS);
  const line = dialogueLines(ass)[0] || '';
  // ASS 规定第 9 个逗号之后的全部内容都是 Text，所以文本里的逗号是安全的
  ok('文本含逗号时 Text 字段仍完整包含全部逗号',
    textField(line).includes('逗号,逗号,逗号'), JSON.stringify(textField(line)));
}

console.log('\n[5] SRT 结构');
{
  const list = [mk(1, '第一条'), mk(2, '第二条'), mk(3, '含逗号,的')];
  const srt = danmakuToSrt(list);
  const blocks = srt.trim().split(/\n\s*\n/).filter(Boolean);
  ok('块数与弹幕数一致', blocks.length === list.length, `得到 ${blocks.length}`);
  ok('每块首行是序号', blocks.every((b, i) => b.trim().split('\n')[0].trim() === String(i + 1)));
  ok('每块第二行是 时间 --> 时间',
    blocks.every((b) => /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(b.split('\n')[1])),
    JSON.stringify(blocks[0]?.split('\n')[1]));
  ok('SRT 用毫秒（3 位），与 ASS 的厘秒（2 位）区分开',
    /\d{2}:\d{2}:\d{2},\d{3}/.test(srt), 'SRT 时间格式应为 00:00:01,000');
}

console.log('\n[6] TXT 结构');
{
  const list = [mk(1, '第一条'), mk(65, '一分钟后')];
  const txt = danmakuToText(list);
  ok('包含全部弹幕文本', txt.includes('第一条') && txt.includes('一分钟后'));
  ok('默认带时间戳', /\[\d+:\d{2}/.test(txt) || /\[\d/.test(txt), JSON.stringify(txt.slice(0, 60)));
}

console.log('\n[7] 过滤逻辑');
{
  const dup = [mk(1.0, '重复'), mk(1.4, '重复'), mk(2.0, '不同')];
  const out = filterDanmaku(dup, { maxLength: 100, dedupe: true });
  ok('去重生效（同一秒内的重复被合并）', out.length === 2, `得到 ${out.length}`);

  const long = [mk(1, '短'), mk(2, 'x'.repeat(200))];
  const out2 = filterDanmaku(long, { maxLength: 10, dedupe: true });
  ok('超长弹幕被过滤', out2.length === 1 && out2[0].text === '短', JSON.stringify(out2.map((o) => o.text)));

  ok('空列表不崩', filterDanmaku([], { maxLength: 100, dedupe: true }).length === 0);
}

console.log('\n[8] 边界：空输入与异常时间');
{
  ok('空列表生成合法 ASS（不抛错）', typeof danmakuToAss([], OPTS) === 'string');
  ok('空列表生成空 SRT', danmakuToSrt([]).trim() === '');

  const zero = [mk(0, '零秒')];
  ok('time=0 不崩', dialogueLines(danmakuToAss(zero, OPTS)).length === 1);

  const neg = [mk(-5, '负时间')];
  let assNeg = null;
  let threw = false;
  try { assNeg = danmakuToAss(neg, OPTS); } catch { threw = true; }
  ok('负时间不抛错（被 clamp 到 0）', !threw && !!assNeg);
}

console.log('\n[9] Title 头部换行安全（v1.4.28 修复的回归守卫：UP 主可控标题不得破坏 ASS 结构）');
{
  const ass = danmakuToAss([mk(1, '普通弹幕')], { ...OPTS, title: '恶意标题\n第二行' });
  const titleLines = ass.split('\n').filter((l) => l.startsWith('Title:'));
  ok('Title: 行只有一条（换行没有制造第二个头部字段）', titleLines.length === 1,
    JSON.stringify(ass.split('\n').slice(0, 6)));
  const titleLine = titleLines[0] || '';
  ok('Title: 行内无裸换行（换行被折叠成空格）',
    titleLine.includes('恶意标题') && !titleLine.includes('\n'), JSON.stringify(titleLine));
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 弹幕模块自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
