"""几何预览：用与应用相同的墨卡托投影和数据，渲染「地图轮廓 + 标注」的 PNG。

用途：在没有图形环境（沙箱里无法启动 Chromium）时，核对市界轮廓形状、
以及各地点落点的相对位置是否正确。这只是坐标/几何校验图，不是应用真实界面。
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
W, H = 1200, 780
PAD = 100  # 与应用一致：给标注留出边距

geo = json.loads((ROOT / "data" / "geo" / "beijing.json").read_text(encoding="utf-8"))
poi = json.loads((ROOT / "data" / "places" / "beijing.json").read_text(encoding="utf-8"))
places = {p["name"]: p for p in poi["places"]}

DEMO = [
    "颐和园", "圆明园", "天安门广场", "北京大学", "清华大学",
    "三里屯", "798艺术区", "香山公园", "北京南站", "雍和宫",
]

R = 6378137  # 地球半径（Web 墨卡托）


def project(lon, lat):
    x = R * lon * math.pi / 180
    y = R * math.log(math.tan(math.pi / 4 + lat * math.pi / 360))
    return x, -y  # y 取负：北在上


def polys_paths(polys):
    return [[project(lon, lat) for lon, lat in ring] for poly in polys for ring in poly]


demo_pts = []
for name in DEMO:
    p = places.get(name)
    if not p:
        print("miss:", name)
        continue
    demo_pts.append((name, p))

city_paths = polys_paths(geo["city"]["polygons"])
district_paths = [p for d in geo["districts"] for p in polys_paths(d["polygons"])]

# 视野：优先框住所有标注点（与应用的「适应窗口」一致）
if len(demo_pts) >= 2:
    xs = [project(p["lon"], p["lat"])[0] for _, p in demo_pts]
    ys = [project(p["lon"], p["lat"])[1] for _, p in demo_pts]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    scale = min((W - 2 * PAD) / max(maxx - minx, 3000), (H - 2 * PAD) / max(maxy - miny, 3000))
else:
    xs = [x for path in city_paths for x, _ in path]
    ys = [y for path in city_paths for _, y in path]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    scale = min(W / (maxx - minx), H / (maxy - miny)) * 0.86

ox = W / 2 - (minx + maxx) / 2 * scale
oy = H / 2 - (miny + maxy) / 2 * scale

S = 2  # 2x 超采样
img = Image.new("RGB", (W * 2, H * 2), "white")
draw = ImageDraw.Draw(img)


def screen(pt):
    x, y = pt
    return (x * scale + ox) * S, (y * scale + oy) * S


for path in district_paths:
    draw.line([screen(pt) for pt in path], fill=(236, 231, 223), width=1)

for path in city_paths:
    pts = [screen(pt) for pt in path]
    if len(pts) > 2:
        draw.polygon(pts, fill=(255, 255, 255))
        draw.line(pts + [pts[0]], fill=(42, 45, 49), width=3, joint="curve")

font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 15 * S)
occ = []

for name, p in demo_pts:
    x, y = screen(project(p["lon"], p["lat"]))
    r = 5 * S
    draw.ellipse([x - r - 2, y - r - 2, x + r + 2, y + r + 2], fill=(255, 255, 255))
    draw.ellipse([x - r, y - r, x + r, y + r], fill=(192, 57, 43))

    bbox = draw.textbbox((0, 0), name, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cand = [
        (x + 11 * S, y - th / 2),
        (x - 11 * S - tw, y - th / 2),
        (x - tw / 2, y - 13 * S - th),
        (x - tw / 2, y + 13 * S),
    ]
    for tx, ty in cand:
        box = (tx, ty, tx + tw, ty + th)
        if not any(box[0] < o[2] and box[2] > o[0] and box[1] < o[3] and box[3] > o[1] for o in occ):
            occ.append(box)
            draw.text((tx, ty - bbox[1]), name, font=font, fill=(31, 35, 40),
                      stroke_width=3 * S, stroke_fill="white")
            break

img = img.resize((W, H), Image.LANCZOS)
out = ROOT / "artifacts" / "geometry-preview.png"
out.parent.mkdir(exist_ok=True)
img.save(out)
print("wrote", out, "places:", len(poi["places"]))
