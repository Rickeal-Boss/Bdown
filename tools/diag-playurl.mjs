/**
 * 临时诊断脚本：模拟一次真实 playurl 调用，看 -400 是哪个参数引起的。
 *
 * 用法：node tools/diag-playurl.mjs [bvid]
 */
import { getMixinKey, signParams } from '../src/core/wbi.js';
import { buildDmParams } from '../src/core/wbi.js';

const BV = process.argv[2] || 'BV1xx411c7mD'; // aid=2 的著名历史视频

async function getNav() {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    credentials: 'include',
  });
  return r.json();
}

async function getCid(bvid) {
  const r = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  );
  const j = await r.json();
  return { cid: j?.data?.cid, aid: j?.data?.aid, title: j?.data?.title };
}

async function probe(label, params) {
  const mixinKey = await getMixinKey(getNav);
  const signed = signParams(params, mixinKey);
  const qs = new URLSearchParams(signed).toString();
  console.log(`\n--- ${label} ---`);
  console.log('QS:', qs.length > 200 ? qs.slice(0, 200) + '…' : qs);
  const r = await fetch(
    `https://api.bilibili.com/x/player/wbi/playurl?${qs}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0',
        Referer: 'https://www.bilibili.com/',
      },
    },
  );
  const j = await r.json();
  console.log('code:', j.code, 'message:', j.message);
  if (j.code === 0) {
    console.log('data.dash:', j.data?.dash ? 'OK' : '(durl 模式)');
    console.log('accept_quality:', j.data?.accept_quality);
  }
  return j;
}

const { cid, aid } = await getCid(BV);
console.log('BV:', BV, 'aid:', aid, 'cid:', cid);

const dm = buildDmParams();

// 方案 A：我们当前的参数（platform=web）
await probe('当前参数（platform=web）', {
  bvid: BV,
  cid,
  qn: 80,
  fnver: 0,
  fnval: 4048,
  fourk: 1,
  otype: 'json',
  platform: 'web',
  high_quality: 1,
  ...dm,
});

// 方案 B：yt-dlp 风格（去掉 otype / fnver / high_quality）
await probe('yt-dlp 极简参数', {
  bvid: BV,
  cid,
  qn: 80,
  fnval: 4048,
  fourk: 1,
  platform: 'web',
  ...dm,
});

// 方案 C：旧 platform=pc（复现用户报告的 -400）
await probe('旧参数 platform=pc', {
  bvid: BV,
  cid,
  qn: 80,
  fnver: 0,
  fnval: 4048,
  fourk: 1,
  otype: 'json',
  platform: 'pc',
  high_quality: 1,
  ...dm,
});