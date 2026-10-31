/* 地点检索打分：精确 > 别名 > 前缀 > 包含 > 拼音 */
(function () {
  function norm(value) {
    return String(value || '').trim().toLowerCase();
  }

  function scoreOf(place, q) {
    const name = norm(place.name);
    const aliases = (place.aliases || []).map(norm);
    const py = norm(place.py);
    const pyi = norm(place.pyi);

    if (name === q) return 1000;
    if (aliases.includes(q)) return 960;
    if (name.startsWith(q)) return 900 - Math.min(name.length, 40);
    if (aliases.some((a) => a.startsWith(q))) return 820;
    if (name.includes(q)) return 760 - Math.min(name.indexOf(q), 30) * 3;
    if (aliases.some((a) => a.includes(q))) return 640;
    if (py && pyi === q) return 620;
    if (pyi && pyi.startsWith(q)) return 600;
    if (py && py.startsWith(q)) return 560;
    if (pyi && q.length >= 2 && pyi.includes(q)) return 380;
    if (py && q.length >= 2 && py.includes(q)) return 340;
    return 0;
  }

  function query(places, rawQuery, limit = 8) {
    const q = norm(rawQuery);
    if (!q) return [];
    const scored = [];
    for (const place of places) {
      const score = scoreOf(place, q);
      if (score > 0) scored.push({ place, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || (b.place.rank || 0) - (a.place.rank || 0) || a.place.name.localeCompare(b.place.name, 'zh')
    );
    return scored.slice(0, limit).map((s) => s.place);
  }

  function filter(places, rawQuery) {
    const q = norm(rawQuery);
    if (!q) return places;
    return places.filter(
      (p) => norm(p.name).includes(q) || (p.district || '').includes(q) || norm(p.intro).includes(q)
    );
  }

  window.PTSearch = { query, filter };
})();
