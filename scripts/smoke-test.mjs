// 无头冒烟测试：用 jsdom 加载真实页面，验证启动、检索、落点、列表与相对位置
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve('.');
const readJson = async (p) => JSON.parse(await fs.readFile(path.join(root, p), 'utf8'));

const geo = await readJson('data/geo/beijing.json');
const poi = await readJson('data/places/beijing.json');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => errors.push(err.message));
virtualConsole.on('error', (msg) => errors.push(String(msg)));

const html = await fs.readFile(path.join(root, 'src/index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: pathToFileURL(path.join(root, 'src/index.html')).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.phototrack = {
      loadBootstrap: async () => ({ geo, poi }),
      loadPlaces: async () => [],
      savePlaces: async () => true
    };
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 1024, bottom: 700, width: 1024, height: 700 };
    window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { ...rect, toJSON: () => rect };
    };
  }
});

const { window } = dom;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => window.document.querySelector(sel);

await new Promise((resolve) => window.addEventListener('load', resolve));
await sleep(400);

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

// 1. 启动
check('启动后地点数为 0', $('#place-count')?.textContent === '0 个地点', $('#place-count')?.textContent);
check('空状态提示可见', !$('#hint')?.classList.contains('hidden'));
check('地图生成了市界轮廓', ($('#layer-map .city-outline')?.getAttribute('d')?.length ?? 0) > 1000);
check('地图生成了区界线', ($('#layer-map .district-lines')?.getAttribute('d')?.length ?? 0) > 1000);

// 2. 检索
const search = window.PTSearch;
const top = search.query(poi.places, '颐和园', 5);
check('检索「颐和园」首位命中', top[0]?.name === '颐和园', top.map((p) => p.name).join(','));
const pinyinHit = search.query(poi.places, 'yhy', 5);
check('拼音首字母 yhy 命中颐和园', pinyinHit[0]?.name === '颐和园', pinyinHit.map((p) => p.name).join(','));
const tiananmen = search.query(poi.places, '天安门', 5);
check('检索「天安门」命中', tiananmen.some((p) => p.name.includes('天安门')), tiananmen.map((p) => p.name).join(','));

// 3. 通过界面添加：输入 -> 候选 -> 回车
const input = $('#add-input');
input.value = '颐和园';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(50);
const resultCount = $('#add-results').querySelectorAll('.result').length;
check('输入后出现候选列表', resultCount > 0, `候选 ${resultCount} 条`);
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(100);
check('回车后地点加入列表', $('#place-list').querySelectorAll('.place-item').length === 1);

// 4. 演示数据 + 相对位置
const seeded = window.__seedDemo();
check('演示地点全部命中库', seeded.every((s) => !String(s).startsWith('MISS')), seeded.join(' '));
await sleep(100);

const places = window.__state ? window.__state.places : null;
void places;

const items = [...$('#place-list').querySelectorAll('.place-item')];
check('列表渲染出全部地点', items.length === 11, `实际 ${items.length}`);

function pos(name) {
  const el = [...$('#layer-marker').querySelectorAll('.marker')].find(
    (m) => m.querySelector('.marker-label').textContent === name
  );
  if (!el) return null;
  const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el.getAttribute('transform') || '');
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

const yhy = pos('颐和园');
const ym = pos('圆明园');
const tam = pos('天安门广场');
const pku = pos('北京大学');
const xs = pos('香山公园');
const art = pos('798艺术区');
const south = pos('北京南站');

check('标注点都已定位', [yhy, ym, tam, pku, xs, art, south].every(Boolean));

if (yhy && ym && tam && pku && xs && art && south) {
  check('颐和园在天安门西侧', yhy.x < tam.x, `${yhy.x.toFixed(0)} < ${tam.x.toFixed(0)}`);
  check('颐和园在天安门北侧', yhy.y < tam.y, `${yhy.y.toFixed(0)} < ${tam.y.toFixed(0)}`);
  check('圆明园在颐和园东侧', ym.x > yhy.x, `${ym.x.toFixed(0)} > ${yhy.x.toFixed(0)}`);
  const span = Math.abs(art.x - xs.x) || 1; // 香山到 798 的屏幕跨度
  const near = Math.hypot(ym.x - yhy.x, ym.y - yhy.y);
  check('圆明园与颐和园相邻（间距 < 视野的 20%）', near < span * 0.2, `${near.toFixed(0)}px / ${span.toFixed(0)}px`);
  check('北大在圆明园南侧', pku.y > ym.y);
  check('香山在颐和园西侧', xs.x < yhy.x);
  check('798 在天安门东北', art.x > tam.x && art.y < tam.y);
  check('北京南站在天安门南侧', south.y > tam.y);
}

// 5. 选中详情
const firstItem = $('#place-list').querySelector('.place-item');
firstItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(50);
check('点击列表项展开详情卡', !$('#detail').classList.contains('hidden'));
check('详情卡显示名称', ($('#detail-name')?.textContent || '').length > 0, $('#detail-name')?.textContent);

// 6. 区界开关
$('#toggle-districts').checked = true;
$('#toggle-districts').dispatchEvent(new window.Event('change', { bubbles: true }));
check('区界开关生效', $('#layer-map').classList.contains('show-districts'));

// 7. 运行期错误
check('运行期无 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
dom.window.close();
process.exit(failed === 0 ? 0 : 1);
