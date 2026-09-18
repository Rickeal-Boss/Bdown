/**
 * 真实接口冒烟测试（需要能访问 api.bilibili.com）。
 * 验证 wbi.js + api.js 的签名与响应归一化是否正确。
 *
 *   node tools/smoke-api.mjs [bvid]
 */

import { BiliApi, pickVideoTrack, pickAudioTrack } from '../src/core/api.js';
import { av2bv, bv2av } from '../src/core/avbv.js';

const bvid = process.argv[2] || 'BV1GJ411x7h7';
let failures = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${msg}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

console.log('\n[1] AV/BV 互转');
const aid = bv2av(bvid);
ok(av2bv(aid) === bvid, `bv2av / av2bv 往返一致`, `${bvid} <-> av${aid}`);

const api = new BiliApi();

console.log('\n[2] 视频信息');
const info = await api.videoInfo({ bvid });
ok(info.bvid === bvid, 'bvid 匹配');
ok(typeof info.title === 'string' && info.title.length > 0, '标题非空', info.title);
ok(Array.isArray(info.pages) && info.pages.length > 0, `分P数量 = ${info.pages.length}`);
ok(info.cid > 0, `cid = ${info.cid}`);

console.log('\n[3] WBI 签名 + playurl');
const play = await api.playurl({ bvid, cid: info.pages[0].cid, qn: 127, mode: 'dash' });
ok(play.mode === 'dash', '返回 DASH 模式');
ok(play.videos.length > 0, `视频轨 ${play.videos.length} 条`);
ok(play.audios.length > 0, `音频轨 ${play.audios.length} 条`);
ok(play.acceptQuality.length > 0, `可选清晰度 [${play.acceptQuality.join(', ')}]`);
ok(play.duration > 0, `时长 ${play.duration.toFixed(1)} 秒`);

const video = pickVideoTrack(play.videos, play.acceptQuality[0], 'avc');
const audio = pickAudioTrack(play.audios);
ok(!!video, `选出视频轨：${video?.quality} / ${video?.codec} / ${video?.width}x${video?.height}`);
ok(!!audio, `选出音轨：${audio?.id} / ${audio?.label} / ${audio?.codecs}`);
ok(video.url.startsWith('https://'), '视频地址已升级为 https');
ok(video.backupUrls.every((u) => u.startsWith('https://')), '备用地址均为 https');

console.log('\n[4] CDN 可达性与 Range 支持');
const res = await fetch(video.url, {
  headers: { Range: 'bytes=0-1023', Referer: 'https://www.bilibili.com/' },
});
ok(res.status === 206, `Range 请求返回 206`, `实际 ${res.status}`);
ok(res.headers.get('access-control-allow-origin') === '*', 'CORS 允许跨域');
const cr = res.headers.get('content-range') || '';
const total = Number(cr.split('/')[1] || 0);
ok(total > 0, `文件总大小 ${total} 字节`);
const head = new Uint8Array(await res.arrayBuffer());
ok(head.length === 1024, '分片长度正确');
const boxType = String.fromCharCode(head[4], head[5], head[6], head[7]);
ok(['ftyp', 'styp', 'free', 'moov', 'sidx'].includes(boxType), `m4s 首个盒子 = ${boxType}`);

console.log('\n[5] 弹幕与字幕接口');
const xml = await api.danmakuXml(info.pages[0].cid);
ok(xml.includes('<i>') && xml.includes('<d p='), '弹幕 XML 可获取', `${(xml.match(/<d p=/g) || []).length} 条`);
try {
  const p2 = await api.playerV2({ bvid, cid: info.pages[0].cid });
  const subs = p2?.subtitle?.subtitles || [];
  ok(Array.isArray(subs), `字幕列表可获取（${subs.length} 条，未登录时通常为 0）`);
} catch (err) {
  ok(false, `playerV2 调用失败：${err.message}`);
}

console.log(`\n${failures ? '\u274c' : '\u2705'} 冒烟测试完成，失败 ${failures} 项\n`);
process.exit(failures ? 1 : 0);
