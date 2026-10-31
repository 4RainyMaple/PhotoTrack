// 照片功能端到端测试：真实 HTTP + 真实落盘 + 页面交互（jsdom 充当浏览器）
// 用法：先 node server.mjs，再 node scripts/smoke-photos.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { startTestServer, fetchToken } from './test-server.mjs';

const srv = await startTestServer({ port: 48902, dir: '.test-data-photos' });
const BASE = srv.base;
const TOKEN = await fetchToken(BASE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// 1x1 红点 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// 最小 MP4 头（ftyp + isom 品牌），用于验证服务端按文件头识别视频
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2', 'ascii'),
  Buffer.alloc(48)
]);

async function api(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, {
    ...options,
    headers: { 'X-PT-Token': TOKEN, ...(options.headers || {}) }
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

async function uploadPhoto(placeId, name) {
  return api('/api/photos', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-Place-Id': placeId,
      'X-File-Name': encodeURIComponent(name),
      'X-Width': '1',
      'X-Height': '1',
      'X-Taken-At': '2024-05-01T10:00:00.000Z'
    },
    body: PNG
  });
}

// ------------------------------------------------------------ 准备一个地点
const PLACE_ID = 'u_photo_test';
const initial = await api('/api/places');
const place = {
  id: PLACE_ID,
  name: '照片测试点',
  lat: 39.99,
  lon: 116.28,
  district: '海淀区',
  category: '地点',
  source: 'poi',
  intro: '测试简介：从北宫门进，沿西堤走一圈。',
  createdAt: Date.now()
};
const created = await api('/api/places', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ places: [place], baseRev: initial.data.rev })
});
check('创建测试地点', created.status === 200, `rev=${created.data?.rev}`);

// ------------------------------------------------------------ 上传与读取
const up1 = await uploadPhoto(PLACE_ID, '颐和园-春天.png');
check('上传 PNG 成功', up1.status === 200 && up1.data?.id, up1.data?.id || JSON.stringify(up1.data));
const photoId = up1.data.id;

const listed = await api(`/api/photos?placeId=${PLACE_ID}`);
check('按地点列出照片', listed.data.length === 1 && listed.data[0].title === '颐和园-春天', `${listed.data.length} 张`);

const counts = await api('/api/photos/counts');
check('地点照片计数正确', counts.data[PLACE_ID] === 1, JSON.stringify(counts.data));

const file = await fetch(`${BASE}/api/photos/${photoId}/file`, { headers: { 'X-PT-Token': TOKEN } });
const fileBuf = Buffer.from(await file.arrayBuffer());
check('原图可读取且字节一致', file.status === 200 && fileBuf.equals(PNG), `${fileBuf.length} 字节`);

const notImage = await api('/api/photos', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'X-Place-Id': PLACE_ID, 'X-File-Name': 'bad.txt' },
  body: Buffer.from('这不是图片')
});
check('非图片文件被拒绝', notImage.status === 415, `status=${notImage.status}`);

// ------------------------------------------------------------ 编辑与移动
const patched = await api(`/api/photos/${photoId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '颐和园·春', note: '昆明湖边' })
});
check('修改标题与备注', patched.data.title === '颐和园·春' && patched.data.note === '昆明湖边');

const blocked = await api(`/api/places/${PLACE_ID}`, { method: 'DELETE' });
check('有照片时禁止删除地点', blocked.status === 409 && blocked.data.count === 1, `status=${blocked.status}`);

// ------------------------------------------------------------ 回收站
await api(`/api/photos/${photoId}`, { method: 'DELETE' });
const alive = await api(`/api/photos?placeId=${PLACE_ID}`);
const trashed = await api(`/api/photos?placeId=${PLACE_ID}&deleted=1`);
check('删除后进入回收站', alive.data.length === 0 && trashed.data.length === 1);

await api(`/api/photos/${photoId}/restore`, { method: 'POST' });
const restored = await api(`/api/photos?placeId=${PLACE_ID}`);
check('从回收站恢复', restored.data.length === 1);

// ------------------------------------------------------------ 页面交互
const geo = JSON.parse(await fs.readFile(path.resolve('data/geo/beijing.json'), 'utf8'));
void geo;
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.message));

const html = await (await fetch(`${BASE}/`)).text();
const dom = new JSDOM(html, {
  url: `${BASE}/`,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(input, `${BASE}/`), init);
    // jsdom 没有实现媒体播放 API，补桩避免误判为页面异常
    window.HTMLMediaElement.prototype.pause = function pause() {};
    window.HTMLMediaElement.prototype.load = function load() {};
    window.HTMLMediaElement.prototype.play = function play() {
      return Promise.resolve();
    };
    window.HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
      this.open = true;
    };
    window.HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
      this.open = false;
      this.dispatchEvent(new window.Event('close'));
    };
    window.Element.prototype.setPointerCapture = () => {};
    window.Element.prototype.releasePointerCapture = () => {};
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 };
    window.Element.prototype.getBoundingClientRect = function () {
      return { ...rect, toJSON: () => rect };
    };
  }
});

const { window } = dom;
await new Promise((r) => window.addEventListener('load', r));
await sleep(600);

const w = window;
const $ = (sel) => w.document.querySelector(sel);
check('页面读到地点与照片数', ($('#place-list .place-item .sub')?.textContent || '').includes('1 张'), $('#place-list .place-item .sub')?.textContent);

$('#place-list .place-item').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(150);
const badgeCount = w.document.querySelectorAll('#layer-marker .marker-badge').length;
check('地图标注不再显示数量徽标', badgeCount === 0, `找到 ${badgeCount} 个`);
check('详情卡显示封面缩略图', ($('#detail-cover')?.getAttribute('src') || '').includes('/thumb'), $('#detail-cover')?.getAttribute('src'));

w.PTPhotos.open(PLACE_ID);
await sleep(500);
check('照片视图打开', !$('#photo-view').classList.contains('hidden'));
check('照片页显示简介栏', !$('#pv-intro').classList.contains('hidden'));
check('简介内容正确', ($('#pvi-text').textContent || '').includes('测试简介'), $('#pvi-text')?.textContent);

$('#pv-intro-toggle').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(80);
check('简介栏可收起', $('#pv-intro').classList.contains('hidden'));
$('#pv-intro-toggle').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(80);
check('简介栏可再展开', !$('#pv-intro').classList.contains('hidden'));

$('#pvi-edit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(120);
check('简介编辑框打开', $('#ask').open === true);
$('#ask-textarea').value = '更新后的简介：秋天更好看。';
$('#ask-ok').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(500);
const afterIntro = await api('/api/places');
check('简介已保存到地点', afterIntro.data.places[0]?.intro === '更新后的简介：秋天更好看。', afterIntro.data.places[0]?.intro);
check('简介栏同步更新', ($('#pvi-text').textContent || '').includes('秋天更好看'), $('#pvi-text')?.textContent);
check('网格渲染出 1 张', $('#pv-grid').querySelectorAll('.ph').length === 1);

// 大图：先单击选中，再双击打开（点击不再重建 DOM，dblclick 才可能触发）
$('#pv-grid .ph').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
$('#pv-grid .ph').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
await sleep(250);
check('双击打开大图', !$('#lightbox').classList.contains('hidden'));

// 翻页（只有一张时是自我循环，放到 3 张之后再验）
$('#lb-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(100);

// 重新打开并改标题
$('#pv-grid .ph').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
$('#pv-grid .ph').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
await sleep(200);
check('大图打开', !$('#lightbox').classList.contains('hidden'));
$('#lb-title').value = '颐和园·夏日';
$('#lb-save').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(400);
const afterSave = await api(`/api/photos?placeId=${PLACE_ID}`);
check('页面改标题已落盘', afterSave.data.some((p) => p.title === '颐和园·夏日'), JSON.stringify(afterSave.data.map((p) => p.title)));

// 再传两张，检查网格刷新
await uploadPhoto(PLACE_ID, '第二张.png');
await uploadPhoto(PLACE_ID, '第三张.png');
w.PTPhotos.close();
w.PTPhotos.open(PLACE_ID);
await sleep(600);
check('重新进入看到 3 张', $('#pv-grid').querySelectorAll('.ph').length === 3, `${$('#pv-grid').querySelectorAll('.ph').length} 张`);

// 大图翻页（3 张时才有意义）
$('#pv-grid .ph').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
await sleep(200);
const firstSrc = $('#lb-img').getAttribute('src');
$('#lb-next').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(150);
check('大图可翻页', $('#lb-img').getAttribute('src') !== firstSrc, $('#lb-img').getAttribute('src'));
$('#lb-prev').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(150);
check('大图可翻回上一张', $('#lb-img').getAttribute('src') === firstSrc);
$('#lb-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(100);

// 多选：普通点击 + Ctrl 点击 + 勾选圆点
const cards = () => [...$('#pv-grid').querySelectorAll('.ph')];
cards()[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(50);
check('单击选中 1 张', cards().filter((c) => c.classList.contains('is-selected')).length === 1);
check('选中一张时出现「查看大图」', !$('#pv-bulk-open').classList.contains('hidden'));
$('#pv-bulk-open').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(200);
check('批量条也能打开大图', !$('#lightbox').classList.contains('hidden'));
$('#lb-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(100);

cards()[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
await sleep(50);
check('Ctrl 点击可加选', cards().filter((c) => c.classList.contains('is-selected')).length === 2);
check('批量操作条出现', !$('#pv-bulk').classList.contains('hidden'), $('#pv-bulk-count').textContent);

cards()[2].querySelector('.ph-check').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(50);
check('点勾选圆点可再加一张', cards().filter((c) => c.classList.contains('is-selected')).length === 3);

cards()[2].querySelector('.ph-check').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(50);
check('再点勾选圆点可取消', cards().filter((c) => c.classList.contains('is-selected')).length === 2);

$('#pv-bulk-clear').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(50);
check('取消选择后批量条隐藏', $('#pv-bulk').classList.contains('hidden'));

// 单张删除
$('#pv-grid .ph .ph-del').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(600);
check('单张删除后剩 2 张', $('#pv-grid').querySelectorAll('.ph').length === 2, `${$('#pv-grid').querySelectorAll('.ph').length} 张`);
check('页面无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

// ------------------------------------------------------------ 视频
const upV = await api('/api/photos', {
  method: 'POST',
  headers: {
    'Content-Type': 'video/mp4',
    'X-Place-Id': PLACE_ID,
    'X-File-Name': encodeURIComponent('测试视频.mp4'),
    'X-Kind': 'video',
    'X-Duration': '12',
    'X-Width': '1920',
    'X-Height': '1080'
  },
  body: MP4
});
check('上传 MP4 成功并识别为视频', upV.status === 200 && upV.data?.kind === 'video' && upV.data?.ext === 'mp4', JSON.stringify(upV.data?.kind));
check('视频时长已记录', upV.data?.duration === 12, String(upV.data?.duration));

const range = await fetch(`${BASE}/api/photos/${upV.data.id}/file`, {
  headers: { 'X-PT-Token': TOKEN, Range: 'bytes=0-3' }
});
const rangeBuf = Buffer.from(await range.arrayBuffer());
check(
  '视频支持分段请求（可拖进度条）',
  range.status === 206 && rangeBuf.length === 4 && (range.headers.get('content-range') || '').startsWith('bytes 0-3/'),
  `${range.status} ${range.headers.get('content-range')}`
);

w.PTPhotos.close();
w.PTPhotos.open(PLACE_ID);
await sleep(500);
check('视频出现在网格中', $('#pv-grid').querySelectorAll('.ph').length === 3, `${$('#pv-grid').querySelectorAll('.ph').length} 个`);
check('视频卡片带播放标记', Boolean($('#pv-grid .ph-play')));

// ------------------------------------------------------------ 回收站永久删除
await api(`/api/photos/${upV.data.id}`, { method: 'DELETE' });
$('#pv-trash').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(400);
const trashCount = $('#pv-grid').querySelectorAll('.ph').length;
check('回收站里能看到已删除项', trashCount === 2, `${trashCount} 个`);
check('出现「清空回收站」按钮', !$('#pv-purge-all').classList.contains('hidden'));

// 单张永久删除
$('#pv-grid .ph-purge').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(200);
check('永久删除前弹确认框', $('#ask').open === true);
$('#ask-ok').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(600);
const afterOne = await api(`/api/photos?placeId=${PLACE_ID}&deleted=1`);
check('单张永久删除生效', afterOne.data.length === 1, `${afterOne.data.length} 个`);
const goneFile = await fetch(`${BASE}/api/photos/${upV.data.id}/file`, { headers: { 'X-PT-Token': TOKEN } });
check('原文件已从磁盘删除', goneFile.status === 404, `status=${goneFile.status}`);

// 清空回收站
$('#pv-purge-all').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(200);
check('清空前弹确认框', $('#ask').open === true);
$('#ask-ok').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(600);
const trashLeft = await api(`/api/photos?placeId=${PLACE_ID}&deleted=1`);
check('清空后回收站为空', trashLeft.data.length === 0, `${trashLeft.data.length} 个`);
check('清空后按钮自动隐藏', $('#pv-purge-all').classList.contains('hidden'));

$('#pv-trash').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(400);

// ------------------------------------------------------------ 清理
const all = await api(`/api/photos?placeId=${PLACE_ID}`);
for (const p of all.data) await api(`/api/photos/${p.id}?permanent=1`, { method: 'DELETE' });
const trash = await api(`/api/photos?placeId=${PLACE_ID}&deleted=1`);
for (const p of trash.data) await api(`/api/photos/${p.id}?permanent=1`, { method: 'DELETE' });
const removed = await api(`/api/places/${PLACE_ID}`, { method: 'DELETE' });
check('清空照片后可删除地点', removed.status === 200, `status=${removed.status}`);

dom.window.close();
await srv.stop();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
