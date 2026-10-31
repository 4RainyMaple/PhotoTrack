// 端到端测试：走「本地服务 + 浏览器数据桥」这条真实路径（jsdom 充当浏览器）
// 用法：先 node server.mjs，再 node scripts/smoke-http.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { startTestServer, fetchToken } from './test-server.mjs';

const srv = await startTestServer({ port: 48901, dir: '.test-data-http' });
const BASE = srv.base;
const TOKEN = await fetchToken(BASE);
const tf = (url, opts = {}) => fetch(url, { ...opts, headers: { 'X-PT-Token': TOKEN, ...(opts.headers || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// 鉴权：没有令牌 / 跨站来源都必须被拒绝
const noToken = await fetch(`${BASE}/api/places`);
check('无令牌访问接口被拒绝', noToken.status === 403, `status=${noToken.status}`);
const badOrigin = await tf(`${BASE}/api/places`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
  body: JSON.stringify({ places: [], baseRev: 0 })
});
check('跨站写请求被拒绝', badOrigin.status === 403, `status=${badOrigin.status}`);

const geo = JSON.parse(await fs.readFile(path.resolve('data/geo/beijing.json'), 'utf8'));
const poi = JSON.parse(await fs.readFile(path.resolve('data/places/beijing.json'), 'utf8'));

// 清空历史数据
async function resetPlaces(places = []) {
  const current = await (await tf(`${BASE}/api/places`)).json();
  return tf(`${BASE}/api/places`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ places, baseRev: current.rev })
  });
}
await resetPlaces();

const errors = [];

async function openApp() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push(err.message));
  virtualConsole.on('error', (msg) => errors.push(String(msg)));

  const html = await (await fetch(`${BASE}/`)).text();
  const dom = new JSDOM(html, {
    url: `${BASE}/`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // jsdom 没有 fetch/sendBeacon/原生对话框，这里补上（浏览器里都是原生能力）
      window.fetch = (input, init) => fetch(new URL(input, `${BASE}/`), init);
      window.navigator.sendBeacon = () => true;
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
      const rect = { x: 0, y: 0, left: 0, top: 0, right: 1024, bottom: 700, width: 1024, height: 700 };
      window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
        return { ...rect, toJSON: () => rect };
      };
    }
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await sleep(500);
  return dom;
}

// 1. 首屏
const dom1 = await openApp();
const w1 = dom1.window;
const $1 = (s) => w1.document.querySelector(s);
check('页面启动并渲染空地图', $1('#place-count')?.textContent === '0 个地点', $1('#place-count')?.textContent);
check('地图轮廓已生成', ($1('.city-outline')?.getAttribute('d')?.length ?? 0) > 1000);

// 设置对话框（只读检查，不做真实迁移）
$1('#btn-settings').dispatchEvent(new w1.MouseEvent('click', { bubbles: true }));
await sleep(200);
check('设置对话框打开', $1('#settings-dialog').open === true);
check('显示当前数据目录', ($1('#settings-current').textContent || '').includes('.test-data-http'), $1('#settings-current')?.textContent);
check('默认填入建议路径', ($1('#settings-input').value || '').length > 0, $1('#settings-input')?.value);
$1('#settings-cancel').dispatchEvent(new w1.MouseEvent('click', { bubbles: true }));
await sleep(80);
check('设置对话框可关闭', $1('#settings-dialog').open === false);

// 2. 通过界面添加地点（走 bridge -> HTTP -> 服务端）
const input = $1('#add-input');
input.value = '颐和园';
input.dispatchEvent(new w1.Event('input', { bubbles: true }));
await sleep(60);
check('输入后有候选', $1('#add-results').querySelectorAll('.result').length > 0);
input.dispatchEvent(new w1.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(150);
check('回车后加入列表', $1('#place-list').querySelectorAll('.place-item').length === 1);

// 3. 服务端确实收到了
await sleep(500);
const stored = await (await tf(`${BASE}/api/places`)).json();
check(
  '地点已写入磁盘',
  stored.places.length === 1 && stored.places[0].name === '颐和园',
  JSON.stringify(stored.places.map((p) => p.name))
);

// 4. 演示数据与相对位置
const seeded = w1.__seedDemo();
check('演示地点全部命中', seeded.every((s) => !String(s).startsWith('MISS')), seeded.length + ' 个');
await sleep(600);

function pos(win, name) {
  const el = [...win.document.querySelectorAll('#layer-marker .marker')].find(
    (m) => m.querySelector('.marker-label').textContent === name
  );
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el?.getAttribute('transform') || '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

const yhy = pos(w1, '颐和园');
const ym = pos(w1, '圆明园');
const tam = pos(w1, '天安门广场');
const xs = pos(w1, '香山公园');
const art = pos(w1, '798艺术区');
const south = pos(w1, '北京南站');
check('标注点齐全', [yhy, ym, tam, xs, art, south].every(Boolean));
if (yhy && ym && tam && xs && art && south) {
  check('颐和园在天安门西北', yhy.x < tam.x && yhy.y < tam.y);
  check('圆明园在颐和园东侧', ym.x > yhy.x);
  check('香山在颐和园西侧', xs.x < yhy.x);
  check('798 在天安门东北', art.x > tam.x && art.y < tam.y);
  check('北京南站在天安门南侧', south.y > tam.y);
}

// 4.5 视图回归：滚轮缩放 / 大幅拖动后画面不能"飞走"
const svg = $1('#map');
check('比例尺已显示', /(m|km)$/.test(($1('#scalebar .scalebar-label')?.textContent || '').trim()), $1('#scalebar .scalebar-label')?.textContent);
for (let i = 0; i < 3; i += 1) {
  svg.dispatchEvent(new w1.WheelEvent('wheel', { deltaY: -120, clientX: 480, clientY: 380, bubbles: true, cancelable: true }));
}
await sleep(80);
const mapObj = w1.__map;
check('滚轮后变换值仍然有效', Number.isFinite(mapObj.k) && mapObj.k > 0 && Number.isFinite(mapObj.tx));
const onScreen = [...w1.document.querySelectorAll('#layer-marker .marker')].filter((m) => {
  const r = /translate\(([-\d.e+]+) ([-\d.e+]+)\)/.exec(m.getAttribute('transform') || '');
  if (!r) return false;
  const x = Number(r[1]);
  const y = Number(r[2]);
  return x > 0 && x < 1024 && y > 0 && y < 700;
}).length;
check('滚轮缩放后标注仍在视野内', onScreen >= 1, `${onScreen} 个`);

const drag = (type, x, y) => {
  const ev = new w1.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  (type === 'pointerdown' ? svg : w1).dispatchEvent(ev);
};
for (let i = 0; i < 8; i += 1) {
  drag('pointerdown', 300, 300);
  drag('pointermove', 2300, 300);
  drag('pointerup', 2300, 300);
}
await sleep(60);
const cityLeft = mapObj.worldBox.x1 * mapObj.k + mapObj.tx;
const cityRight = mapObj.worldBox.x2 * mapObj.k + mapObj.tx;
check('疯狂拖动后地图仍在视野内', cityRight > 0 && cityLeft < 1024, `左 ${cityLeft.toFixed(0)} 右 ${cityRight.toFixed(0)}`);

$1('#btn-fit').dispatchEvent(new w1.MouseEvent('click', { bubbles: true }));
await sleep(80);
const backOnScreen = [...w1.document.querySelectorAll('#layer-marker .marker')].filter((m) => {
  const r = /translate\(([-\d.e+]+) ([-\d.e+]+)\)/.exec(m.getAttribute('transform') || '');
  if (!r) return false;
  return Number(r[1]) > 0 && Number(r[1]) < 1024 && Number(r[2]) > 0 && Number(r[2]) < 700;
}).length;
check('适应窗口后标注全部回来', backOnScreen >= 5, `${backOnScreen} 个`);

// 5. 选中 + 重命名（走对话框）
$1('#place-list .place-item').dispatchEvent(new w1.MouseEvent('click', { bubbles: true }));
await sleep(50);
check('点击列表项展开详情卡', !$1('#detail').classList.contains('hidden'));
$1('#detail-rename').dispatchEvent(new w1.MouseEvent('click', { bubbles: true }));
await sleep(50);
check('重命名对话框已打开', $1('#ask').open === true);
check('对话框预填当前名称', $1('#ask-input').value === '颐和园', $1('#ask-input').value);
$1('#ask-input').value = '颐和园东宫门';
$1('#ask-ok').dispatchEvent(new w1.MouseEvent('click', { bubbles: true }));
await sleep(500);
const renamed = await (await tf(`${BASE}/api/places`)).json();
check(
  '重命名已落盘',
  renamed.places.length === 11 && renamed.places[0].name === '颐和园东宫门',
  `${renamed.places.length} 条，首条 ${renamed.places[0]?.name}`
);

// 6. 重开一个页面，验证持久化（整份列表应当原样读回）
const dom2 = await openApp();
const $2 = (s) => dom2.window.document.querySelector(s);
const items = [...$2('#place-list').querySelectorAll('.place-item .name')].map((el) => el.textContent);
check('重新打开后地点仍在', items.length === 11 && items[0] === '颐和园东宫门', `${items.length} 条`);
check('两个页面均无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

// 7. 数据目录设置：读取 / 校验 / 迁移（restart:false，避免把测试服务真的重启掉）
const cfgPath = path.resolve('phototrack.local.json');
const cfgBefore = await fs.readFile(cfgPath, 'utf8').catch(() => null);
const moveTarget = '.test-data-moved';
try {
  const settings = await (await tf(`${BASE}/api/settings`)).json();
  check('能读到当前数据目录', (settings.dataDir || '').includes('.test-data-http'), settings.dataDir);

  const same = await tf(`${BASE}/api/settings/data-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: settings.dataDir })
  });
  check('拒绝迁移到相同目录', same.status === 400, `status=${same.status}`);

  const empty = await tf(`${BASE}/api/settings/data-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: '   ' })
  });
  check('拒绝空路径', empty.status === 400, `status=${empty.status}`);

  const moved = await tf(`${BASE}/api/settings/data-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: moveTarget, restart: false })
  });
  const movedJson = await moved.json();
  check('迁移接口返回成功', moved.status === 200 && movedJson.ok === true, JSON.stringify(movedJson));

  const copied = await fs
    .access(path.join(moveTarget, 'places.json'))
    .then(() => true)
    .catch(() => false);
  check('数据已复制到新目录', copied);

  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  check('写入了本机配置文件', String(cfg.dataDir).includes('test-data-moved'), cfg.dataDir);
} finally {
  if (cfgBefore !== null) await fs.writeFile(cfgPath, cfgBefore, 'utf8');
  else await fs.rm(cfgPath, { force: true });
  await fs.rm(moveTarget, { recursive: true, force: true });
}

// 清理
await resetPlaces();
dom1.window.close();
dom2.window.close();
await srv.stop();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
void geo;
void poi;
process.exit(failed === 0 ? 0 : 1);


