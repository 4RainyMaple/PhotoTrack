// 构建地图数据：北京市界轮廓 + 16 区边界
// 数据来源：DataV.GeoAtlas（公开行政区划边界数据）
import fs from 'node:fs/promises';
import path from 'node:path';

const CITY_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/110000.json';
const DISTRICT_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/110000_full.json';
const OUT_FILE = path.resolve('data/geo/beijing.json');

const PRECISION = 1e5; // 约 1 米，足够展示
const round = (v) => Math.round(v * PRECISION) / PRECISION;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PhotoTrack/0.1 (local build script)' },
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** 统一成 MultiPolygon 的 [[ring, ...], ...] 形式，并压缩重复点 */
function normalizeGeometry(geom) {
  const polys =
    geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : null;
  if (!polys) throw new Error(`不支持的几何类型: ${geom.type}`);

  return polys
    .map((poly) =>
      poly
        .map((ring) => {
          const out = [];
          for (const [lon, lat] of ring) {
            const p = [round(lon), round(lat)];
            const last = out[out.length - 1];
            if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
          }
          return out;
        })
        .filter((ring) => ring.length >= 4)
    )
    .filter((poly) => poly.length > 0);
}

function bboxOf(polys) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polys)
    for (const ring of poly)
      for (const [lon, lat] of ring) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
  return [round(w), round(s), round(e), round(n)];
}

const cityRaw = await getJson(CITY_URL);
const districtRaw = await getJson(DISTRICT_URL);

const cityFeature = cityRaw.features[0];
const cityPolys = normalizeGeometry(cityFeature.geometry);

const districts = districtRaw.features.map((f) => ({
  adcode: f.properties.adcode,
  name: f.properties.name,
  center: f.properties.center,
  polygons: normalizeGeometry(f.geometry)
}));

const bbox = bboxOf(cityPolys);
const pointCount = cityPolys.reduce((acc, p) => acc + p.reduce((a, r) => a + r.length, 0), 0);
const districtPoints = districts.reduce(
  (acc, d) => acc + d.polygons.reduce((a, p) => a + p.reduce((b, r) => b + r.length, 0), 0),
  0
);

const payload = {
  city: {
    adcode: cityFeature.properties.adcode,
    name: cityFeature.properties.name,
    bbox,
    polygons: cityPolys
  },
  districts: districts.map((d) => ({ adcode: d.adcode, name: d.name, center: d.center, polygons: d.polygons })),
  meta: {
    source: 'DataV.GeoAtlas',
    builtAt: new Date().toISOString(),
    cityPoints: pointCount,
    districtPoints
  }
};

await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
await fs.writeFile(OUT_FILE, JSON.stringify(payload), 'utf8');

const sizeKb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);
console.log(`[geo] 写入 ${OUT_FILE}`);
console.log(`[geo] 市界点 ${pointCount}，区界点 ${districtPoints}，体积 ${sizeKb} KB`);
console.log(`[geo] 范围 ${bbox.join(', ')}；区数 ${districts.length}`);
