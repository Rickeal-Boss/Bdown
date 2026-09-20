/**
 * 字幕模块自检（不联网）。
 *
 * 为什么需要它：`subtitle.js` 此前**零测试覆盖**，而它和弹幕一样处理
 * **完全不可控的文本**（B 站 AI 生成字幕）。弹幕那边有 `escapeAss` 兜底，
 * 字幕这边却直接把 content 拼进 ASS Dialogue 行 —— 一旦内容含
 * `{` `}` `\N` 或真换行，产出的 ASS 结构就坏了。
 *
 * 运行：node tools/test-subtitle.mjs
 */
import {
  parseSubtitleJson,
  subtitleToAss,
  subtitleToSrt,
  subtitleToText,
  pickSubtitle,
} from '../src/core/subtitle.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, msg = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name} — ${msg}`); }
};

const item = (from, to, content) => ({ from, to, location: 2, content });
const SUB = (items) => ({ lan: 'zh-CN', lanDoc: '中文', items });
const OPTS = { title: '测试', width: 1920, height: 1080 };

/** 取出 ASS 的 Dialogue 事件行。 */
function dialogueLines(ass) {
  return ass.slice(ass.indexOf('[Events]')).split('\n').filter((l) => l.startsWith('Dialogue:'));
}

/** 取 Dialogue 行的 Text 字段（前 9 个逗号后的全部内容）。 */
function textField(line) {
  return line.replace(/^Dialogue:\s*/, '').split(',').slice(9).join(',');
}

console.log('\n[1] parseSubtitleJson 健壮性');
{
  ok('body 缺失 → 空 items', parseSubtitleJson({}).items.length === 0);
  ok('body 非数组 → 空 items', parseSubtitleJson({ body: 'x' }).items.length === 0);
  ok('null → 空 items', parseSubtitleJson(null).items.length === 0);

  const s = parseSubtitleJson({ body: [{ from: 1, to: 2, content: '你好' }] });
  ok('正常解析', s.items.length === 1 && s.items[0].content === '你好');

  const bad = parseSubtitleJson({ body: [{ from: 'abc', to: null, content: undefined }] });
  ok('非法字段不产生 NaN', Number.isFinite(bad.items[0].from) && Number.isFinite(bad.items[0].to),
    JSON.stringify(bad.items[0]));
  ok('content 缺失 → 空串而不是 "undefined"', bad.items[0].content === '', JSON.stringify(bad.items[0].content));

  const meta = parseSubtitleJson({ body: [] }, { lan: 'ai-zh', lanDoc: '中文（自动识别）' });
  ok('语言元信息透传', meta.lan === 'ai-zh' && meta.lanDoc === '中文（自动识别）');
}

console.log('\n[2] ★ ASS：字幕文本必须转义（与弹幕同规格）');
{
  const hostile = [
    item(1, 2, '普通字幕'),
    item(3, 4, '花括号 { 和 }'),
    item(5, 6, '反斜杠 \\ 结尾'),
    item(7, 8, '字面换行 \\N 标记'),
    item(9, 10, '带逗号,的字幕'),
  ];
  const ass = subtitleToAss(SUB(hostile), OPTS);
  const lines = dialogueLines(ass);
  ok('全部字幕都生成了事件行', lines.length === hostile.length,
    `得到 ${lines.length}，期望 ${hostile.length}`);

  const BARE_BRACE = /(?<!\\)[{}]/;
  const offenders = lines.map(textField).filter((t) => BARE_BRACE.test(t));
  ok('无裸花括号（不会意外开闭 override 块）', offenders.length === 0,
    offenders.length ? JSON.stringify(offenders[0]) : '');
}

console.log('\n[3] ★ ASS：真换行不能把事件行物理切断');
{
  const withNewline = [item(1, 2, '第一行\n第二行'), item(3, 4, '普通')];
  const ass = subtitleToAss(SUB(withNewline), OPTS);
  const lines = dialogueLines(ass);
  ok('事件行数正确（换行没有多产出/吃掉事件）', lines.length === withNewline.length,
    `得到 ${lines.length}，期望 ${withNewline.length}`);
  ok('Text 字段里没有残留物理换行',
    lines.every((l) => !textField(l).includes('\n')),
    JSON.stringify(textField(lines[0] || '').slice(0, 30)));
}

console.log('\n[4] ★ SRT：字幕文本里的空行不能切断块结构');
{
  // SRT 以空行分隔块。字幕文本若含 "\n\n"，会被解析成两个块 → 结构损坏
  const tricky = [item(1, 2, '普通'), item(3, 4, '第一段\n\n第二段'), item(5, 6, '结尾')];
  const srt = subtitleToSrt(SUB(tricky));
  const blocks = srt.trim().split(/\n\s*\n/).filter(Boolean);
  ok('块数与字幕条数一致（文本内空行未切断块）', blocks.length === tricky.length,
    `得到 ${blocks.length}，期望 ${tricky.length}`);
  ok('每块首行是序号', blocks.every((b, i) => b.trim().split('\n')[0].trim() === String(i + 1)),
    JSON.stringify(blocks.map((b) => b.trim().split('\n')[0])));
}

console.log('\n[5] SRT 基础结构');
{
  const list = [item(1, 2, '第一'), item(65, 70, '一分后')];
  const srt = subtitleToSrt(SUB(list));
  const blocks = srt.trim().split(/\n\s*\n/).filter(Boolean);
  ok('块数正确', blocks.length === 2, `得到 ${blocks.length}`);
  ok('时间格式为 00:00:00,000（毫秒 3 位）',
    /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(blocks[0]),
    JSON.stringify(blocks[0]?.split('\n')[1]));
  ok('超过 1 分钟的时间正确进位', blocks[1].includes('00:01:05,000'), JSON.stringify(blocks[1]?.split('\n')[1]));
}

console.log('\n[6] TXT 导出');
{
  const list = [item(1, 2, '第一'), item(3, 4, '第二')];
  const txt = subtitleToText(SUB(list));
  ok('只包含字幕文本（无时间轴）', !txt.includes('-->'), JSON.stringify(txt));
  ok('包含全部内容', txt.includes('第一') && txt.includes('第二'));
}

console.log('\n[7] pickSubtitle 语言匹配');
{
  const list = [
    { lan: 'en-US', lanDoc: 'English' },
    { lan: 'ai-zh', lanDoc: '中文（自动识别）' },
    { lan: 'zh-CN', lanDoc: '中文（中国）' },
  ];
  ok('精确匹配优先（zh-CN 胜过 ai-zh）', pickSubtitle(list, 'zh-CN').lan === 'zh-CN');

  // 用户明确指定 en-US 时，就该给 en-US —— 精确匹配的分值高于"中文加分"，
  // 否则用户设置就失效了。（我第一版断言写反了，误以为中文应无条件优先）
  ok('偏好 en-US 时精确命中 en-US（不因中文加分而抢走）',
    pickSubtitle(list, 'en-US').lan === 'en-US', pickSubtitle(list, 'en-US')?.lan);

  // 偏好没命中任何条目时，中文应靠 startsWith('zh') 加分胜出
  const noMatch = [{ lan: 'en-US', lanDoc: 'English' }, { lan: 'ai-zh', lanDoc: '中文（自动识别）' }];
  ok('偏好未命中时中文胜出（zh 加分）', pickSubtitle(noMatch, 'fr-FR').lan === 'ai-zh',
    pickSubtitle(noMatch, 'fr-FR')?.lan);
  ok('空列表 → null', pickSubtitle([], 'zh-CN') === null);
  ok('undefined → null', pickSubtitle(undefined, 'zh-CN') === null);

  const aiOnly = [{ lan: 'ai-zh', lanDoc: '中文（自动识别）' }];
  ok('只有 AI 字幕时也能选到（不返回 null）', pickSubtitle(aiOnly, 'zh-CN')?.lan === 'ai-zh');
}

console.log('\n[8] 边界');
{
  ok('空 items 生成合法 ASS', typeof subtitleToAss(SUB([]), OPTS) === 'string');
  ok('空 items → 空 SRT', subtitleToSrt(SUB([])).trim() === '');
  ok('空 items → 空 TXT', subtitleToText(SUB([])) === '');

  // 时间倒挂（to < from）不应产出负时长
  const bad = [item(5, 1, '倒挂')];
  let ass = null;
  let threw = false;
  try { ass = subtitleToAss(SUB(bad), OPTS); } catch { threw = true; }
  ok('to < from 不抛错', !threw && !!ass);

  // 缺少 opts 时用默认值
  ok('不给 opts 也能生成（用默认分辨率）', typeof subtitleToAss(SUB([item(1, 2, 'x')])) === 'string');
}

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} 字幕模块自检${fail === 0 ? '完成，失败 0 项' : `完成，失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? 0 : 1);
