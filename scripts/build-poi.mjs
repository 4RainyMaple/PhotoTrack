// 构建北京地点库：从 OpenStreetMap（Overpass API）抓取带名称的地点，
// 清洗后转成离线可用的 places.json（名称 / 别名 / 坐标 / 所属区 / 排序权重）
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const GEO_FILE = path.resolve('data/geo/beijing.json');
const OUT_FILE = path.resolve('data/places/beijing.json');
const RAW_DIR = path.resolve('data/raw');

const BBOX = { s: 39.44, w: 115.42, n: 41.07, e: 117.52 };
const COLS = 4;
const ROWS = 4;

const ENDPOINTS = [
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const HEADERS = {
  'User-Agent': 'PhotoTrack/0.1 (offline photo organizer; build script)',
  Accept: 'application/json'
};

// ---------------------------------------------------------------- 抓取

const CATEGORY_FILTERS = [
  ['tourism', '^(attraction|museum|viewpoint|zoo|theme_park|gallery|artwork|picnic_site)$'],
  ['leisure', '^(park|garden|nature_reserve)$'],
  ['historic', '^(memorial|monument|palace|castle|ruins|fort|citywalls|tomb|archaeological_site)$'],
  ['amenity', '^(university|college|library|theatre|cinema|marketplace|place_of_worship)$'],
  ['railway', '^(station|halt)$'],
  ['shop', '^(mall|department_store)$'],
  ['place', '^(suburb|quarter|neighbourhood|town)$']
];

function buildQuery(s, w, n, e) {
  const body = CATEGORY_FILTERS.map(([key, re]) => `  nwr["${key}"~"${re}"](${s},${w},${n},${e});`).join('\n');
  return `[out:json][timeout:150][maxsize:1073741824];\n(\n${body}\n);\nout center tags;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheKey = (b) =>
  `overpass_${b.s.toFixed(3)}_${b.w.toFixed(3)}_${b.n.toFixed(3)}_${b.e.toFixed(3)}.json`;

async function fetchTile(box, depth = 0) {
  const file = path.join(RAW_DIR, cacheKey(box));
  try {
    const cached = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(cached);
    return parsed.elements ?? [];
  } catch {
    /* 无缓存 */
  }

  const query = buildQuery(box.s, box.w, box.n, box.e);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    try {
      const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(180000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      await fs.mkdir(RAW_DIR, { recursive: true });
      await fs.writeFile(file, JSON.stringify(json), 'utf8');
      console.log(
        `[poi] tile(${box.s.toFixed(2)},${box.w.toFixed(2)}) depth=${depth} 元素 ${json.elements?.length ?? 0}`
      );
      return json.elements ?? [];
    } catch (err) {
      console.warn(
        `[poi] 第 ${attempt} 次失败 ${box.w.toFixed(2)},${box.s.toFixed(2)} @${new URL(endpoint).host}: ${err.message}`
      );
      await sleep(2000 * attempt);
    }
  }

  if (depth >= 3) {
    console.warn('[poi] 放弃子区块', JSON.stringify(box));
    return [];
  }
  // 失败则四分后重试
  const midLat = (box.s + box.n) / 2;
  const midLon = (box.w + box.e) / 2;
  const quads = [
    { s: box.s, w: box.w, n: midLat, e: midLon },
    { s: box.s, w: midLon, n: midLat, e: box.e },
    { s: midLat, w: box.w, n: box.n, e: midLon },
    { s: midLat, w: midLon, n: box.n, e: box.e }
  ];
  const out = [];
  for (const q of quads) out.push(...(await fetchTile(q, depth + 1)));
  return out;
}

// ---------------------------------------------------------------- 清洗

const CJK = /[\u3400-\u9fff]/;
const BAD_NAME =
  /(停车场|停车场出入口|公厕|洗手间|卫生间|出入口|无障碍|售票处|游客中心$|游客服务中心|管理用房|门卫|配电室|垃圾|施工|围挡|临时)/;

const CATEGORY_INFO = {
  attraction: ['景点', 100],
  palace: ['古迹', 96],
  museum: ['博物馆', 94],
  viewpoint: ['观景', 88],
  zoo: ['动物园', 92],
  theme_park: ['乐园', 90],
  gallery: ['展馆', 82],
  artwork: ['景观', 60],
  picnic_site: ['休闲', 50],
  park: ['公园', 86],
  garden: ['园林', 84],
  nature_reserve: ['自然保护区', 80],
  historic: ['古迹', 78],
  university: ['高校', 88],
  college: ['院校', 80],
  station: ['车站', 90],
  halt: ['车站', 72],
  library: ['图书馆', 70],
  theatre: ['剧场', 70],
  cinema: ['影院', 62],
  marketplace: ['市场', 66],
  mall: ['商场', 76],
  department_store: ['百货', 66],
  place_of_worship: ['宗教场所', 68],
  suburb: ['片区', 64],
  quarter: ['片区', 66],
  neighbourhood: ['街区', 62],
  town: ['城镇', 54],
  pedestrian: ['街区', 60]
};

function classify(tags) {
  if (tags.tourism && CATEGORY_INFO[tags.tourism]) return tags.tourism;
  if (tags.leisure && CATEGORY_INFO[tags.leisure]) return tags.leisure;
  if (tags.historic && CATEGORY_INFO[tags.historic]) return tags.historic;
  if (tags.amenity && CATEGORY_INFO[tags.amenity]) return tags.amenity;
  if (tags.railway && CATEGORY_INFO[tags.railway]) return tags.railway;
  if (tags.shop && CATEGORY_INFO[tags.shop]) return tags.shop;
  if (tags.place && CATEGORY_INFO[tags.place]) return tags.place;
  if (tags.highway === 'pedestrian') return 'pedestrian';
  return null;
}

function pickPoint(el) {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  return null;
}

function collectAliases(tags, primary) {
  const raw = [tags['name:zh'], tags.alt_name, tags.official_name, tags.old_name, tags.short_name, tags['name:en']];
  const set = new Set();
  for (const value of raw) {
    if (!value) continue;
    for (const part of String(value).split(/[;；,，]/)) {
      const v = part.trim();
      if (v && v !== primary && v.length <= 40) set.add(v);
    }
  }
  return [...set].slice(0, 6);
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function districtOf(lon, lat, districts) {
  for (const d of districts) {
    for (const poly of d.polygons) {
      if (!poly.length) continue;
      const [outer, ...holes] = poly;
      if (!pointInRing([lon, lat], outer)) continue;
      if (holes.some((h) => pointInRing([lon, lat], h))) continue;
      return d.name;
    }
  }
  return '';
}

// ---------------------------------------------------------------- 手工兜底的核心地点
// OSM 偶有缺漏，这些地点必须能搜到（坐标为公开地理坐标）
const CORE = [
  ['颐和园', 39.99990, 116.27550, '海淀区', ['颐和园公园', 'Summer Palace']],
  ['圆明园', 40.00830, 116.29770, '海淀区', ['圆明园遗址公园']],
  ['天安门广场', 39.90550, 116.39770, '东城区', ['天安门']],
  ['故宫博物院', 39.91630, 116.39720, '东城区', ['故宫', '紫禁城', 'Forbidden City']],
  ['天坛公园', 39.88220, 116.40660, '东城区', ['天坛']],
  ['八达岭长城', 40.35970, 116.02000, '延庆区', ['八达岭', 'Great Wall']],
  ['北京大学', 39.99250, 116.30580, '海淀区', ['北大', 'Peking University']],
  ['清华大学', 40.00040, 116.32640, '海淀区', ['清华', 'Tsinghua University']],
  ['三里屯', 39.93440, 116.45530, '朝阳区', ['三里屯太古里']],
  ['南锣鼓巷', 39.93700, 116.40330, '东城区', []],
  ['王府井', 39.91460, 116.41090, '东城区', ['王府井大街']],
  ['北京奥林匹克公园', 39.99290, 116.39640, '朝阳区', ['鸟巢', '国家体育场']],
  ['国家游泳中心', 39.99270, 116.39040, '朝阳区', ['水立方']],
  ['雍和宫', 39.94720, 116.41720, '东城区', []],
  ['什刹海', 39.94070, 116.38380, '西城区', ['后海', '前海']],
  ['北海公园', 39.92540, 116.38910, '西城区', ['北海']],
  ['景山公园', 39.92590, 116.39680, '西城区', ['景山']],
  ['中关村', 39.98360, 116.31620, '海淀区', []],
  ['国贸', 39.90870, 116.46060, '朝阳区', ['中国国际贸易中心', 'CBD']],
  ['798艺术区', 39.98470, 116.49560, '朝阳区', ['798']],
  ['香山公园', 39.99390, 116.18770, '海淀区', ['香山']],
  ['北京南站', 39.86520, 116.37860, '丰台区', []],
  ['北京站', 39.90280, 116.42700, '东城区', []],
  ['北京西站', 39.89490, 116.32200, '丰台区', []],
  ['首都国际机场', 40.07250, 116.59750, '顺义区', ['首都机场', 'PEK']],
  ['大兴国际机场', 39.50980, 116.41050, '大兴区', ['大兴机场', 'PKX']],
  ['望京', 39.99630, 116.47090, '朝阳区', []],
  ['五道口', 39.99260, 116.33830, '海淀区', []],
  ['西单', 39.90970, 116.37400, '西城区', ['西单商圈']],
  ['前门大街', 39.89940, 116.39760, '东城区', ['前门', '大栅栏']],
  ['恭王府', 39.93620, 116.38600, '西城区 ', []],
  ['国家博物馆', 39.90420, 116.40130, '东城区', ['中国国家博物馆']],
  ['国家大剧院', 39.90330, 116.38330, '西城区', []],
  ['朝阳公园', 39.94100, 116.47800, '朝阳区', []],
  ['玉渊潭公园', 39.91900, 116.31400, '海淀区', ['玉渊潭']],
  ['奥林匹克森林公园', 40.01700, 116.39000, '朝阳区', ['奥森']],
  ['鲁迅博物馆', 39.92600, 116.36300, '西城区', []],
  ['北京动物园', 39.94000, 116.33200, '西城区', []],
  ['北京环球影城', 39.85600, 116.67600, '通州区', ['环球影城', 'Universal Studios']],
  ['雁栖湖', 40.40600, 116.66400, '怀柔区', []],
  ['慕田峪长城', 40.43100, 116.56400, '怀柔区', []]
];

// ---------------------------------------------------------------- 组装

const geo = JSON.parse(await fs.readFile(GEO_FILE, 'utf8'));
const districts = geo.districts;

const tiles = [];
const latStep = (BBOX.n - BBOX.s) / ROWS;
const lonStep = (BBOX.e - BBOX.w) / COLS;
for (let r = 0; r < ROWS; r += 1) {
  for (let c = 0; c < COLS; c += 1) {
    tiles.push({
      s: BBOX.s + r * latStep,
      w: BBOX.w + c * lonStep,
      n: BBOX.s + (r + 1) * latStep,
      e: BBOX.w + (c + 1) * lonStep
    });
  }
}

const CACHE_ONLY = process.argv.includes('--cache-only');

const elements = [];
if (CACHE_ONLY) {
  // 离线模式：只用 data/raw 里已经抓下来的瓦片（Overpass 不可达时的兜底）
  let files = [];
  try {
    files = (await fs.readdir(RAW_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    console.warn('[poi] 没有可用的缓存瓦片');
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(RAW_DIR, file), 'utf8'));
      elements.push(...(parsed.elements ?? []));
    } catch {
      console.warn(`[poi] 跳过损坏缓存 ${file}`);
    }
  }
  console.log(`[poi] 离线模式：合并 ${files.length} 个缓存瓦片，元素 ${elements.length}`);
} else {
  for (const tile of tiles) elements.push(...(await fetchTile(tile)));
}

let pinyinFn = null;
try {
  const mod = await import('pinyin-pro');
  const pinyin = mod.pinyin ?? mod.default?.pinyin;
  if (typeof pinyin === 'function') pinyinFn = pinyin;
} catch {
  console.warn('[poi] 未安装 pinyin-pro，跳过拼音索引（可选）');
}

const byKey = new Map();
let dropped = 0;

for (const el of elements) {
  const tags = el.tags ?? {};
  const name = (tags.name || tags['name:zh'] || '').trim();
  if (!name || name.length < 2 || name.length > 40) {
    dropped += 1;
    continue;
  }
  if (!CJK.test(name) || BAD_NAME.test(name)) {
    dropped += 1;
    continue;
  }
  const category = classify(tags);
  if (!category) {
    dropped += 1;
    continue;
  }
  const point = pickPoint(el);
  if (!point) {
    dropped += 1;
    continue;
  }
  const [lon, lat] = point;
  if (lon < BBOX.w || lon > BBOX.e || lat < BBOX.s || lat > BBOX.n) {
    dropped += 1;
    continue;
  }

  const [label, rank] = CATEGORY_INFO[category];
  const boost = tags.wikidata || tags.wikipedia ? 6 : 0;
  const key = `${name}|${Math.round(lat * 400)},${Math.round(lon * 400)}`;
  const existing = byKey.get(key);
  if (existing && existing.rank >= rank + boost) continue;

  byKey.set(key, {
    name,
    aliases: collectAliases(tags, name),
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    district: '',
    category: label,
    rank: rank + boost
  });
}

// 手工核心地点：缺则补，有则提升权重并合并别名
for (const [name, lat, lon, district, aliases] of CORE) {
  let hit = null;
  for (const p of byKey.values()) {
    if (p.name === name && Math.abs(p.lat - lat) < 0.01 && Math.abs(p.lon - lon) < 0.01) {
      hit = p;
      break;
    }
  }
  if (hit) {
    hit.rank = Math.max(hit.rank, 120);
    hit.aliases = [...new Set([...hit.aliases, ...aliases])].slice(0, 8);
    if (district.trim()) hit.district = district.trim();
  } else {
    const key = `${name}|${Math.round(lat * 400)},${Math.round(lon * 400)}`;
    byKey.set(key, {
      name,
      aliases: [...new Set(aliases)],
      lat,
      lon,
      district: district.trim(),
      category: '地点',
      rank: 120
    });
  }
}

const places = [...byKey.values()].map((p) => {
  const district = p.district || districtOf(p.lon, p.lat, districts);
  let py = '';
  let pyi = '';
  if (pinyinFn) {
    try {
      const syllables = pinyinFn(p.name, { toneType: 'none', type: 'array' });
      py = syllables.join('').toLowerCase();
      pyi = syllables.map((s) => s[0]).join('').toLowerCase();
    } catch {
      /* 忽略 */
    }
  }
  return {
    id: 'b' + crypto.createHash('sha1').update(`${p.name}@${p.lat},${p.lon}`).digest('hex').slice(0, 10),
    name: p.name,
    aliases: p.aliases,
    lat: p.lat,
    lon: p.lon,
    district,
    category: p.category,
    rank: p.rank,
    py,
    pyi
  };
});

// 只保留落在北京市界内、且能判定所属区的地点
const inCity = (p) => {
  for (const poly of geo.city.polygons) {
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 4) continue;
    if (!pointInRing([p.lon, p.lat], outer)) continue;
    if (holes.some((hole) => pointInRing([p.lon, p.lat], hole))) continue;
    return true;
  }
  return false;
};

const inside = places.filter((p) => p.district && inCity(p));

// 同名近邻合并（同一地点在 OSM 里被重复标注）
const EARTH = 6371000;
const dist = (a, b) => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(s));
};

const byName = new Map();
const deduped = [];
for (const p of inside) {
  const prev = byName.get(p.name);
  if (prev && dist(prev, p) < 1500) {
    if (p.rank > prev.rank) {
      prev.lat = p.lat;
      prev.lon = p.lon;
      prev.rank = p.rank;
      prev.category = p.category;
      if (p.district) prev.district = p.district;
    }
    prev.aliases = [...new Set([...prev.aliases, ...p.aliases])].slice(0, 8);
    continue;
  }
  byName.set(p.name, p);
  deduped.push(p);
}

// 极高频的同名地物（如数量众多的“小断崖”）只保留权重最高的两条
const nameCount = new Map();
for (const p of deduped) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
const kept = new Map();
const finalPlaces = deduped.filter((p) => {
  if ((nameCount.get(p.name) ?? 0) <= 2) return true;
  const used = kept.get(p.name) ?? 0;
  if (used >= 2) return false;
  kept.set(p.name, used + 1);
  return true;
});

const places2 = finalPlaces.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, 'zh'));

const payload = {
  city: '北京',
  generatedAt: new Date().toISOString(),
  source: 'OpenStreetMap / Overpass API（ODbL）',
  count: places2.length,
  places: places2
};

await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
await fs.writeFile(OUT_FILE, JSON.stringify(payload), 'utf8');

const stats = new Map();
for (const p of places2) stats.set(p.category, (stats.get(p.category) ?? 0) + 1);

console.log(`[poi] 原始元素 ${elements.length}，丢弃 ${dropped}，合并去重后 ${places2.length}`);
console.log('[poi] 分类统计', [...stats.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('[poi] 抽查', places2.filter((p) => ['颐和园', '天安门广场', '三里屯', '北京大学'].includes(p.name)).map((p) => `${p.name}(${p.district})`).join(' '));
console.log(`[poi] 写入 ${OUT_FILE}`);
