/* 地图渲染：墨卡托投影 + SVG 轮廓 + 标注层（标注不随缩放变大） */
(function () {
  const R = 6378137; // 地球半径（Web 墨卡托）
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * 经纬度 -> 世界坐标（墨卡托）。
   * y 取负值，让北在上，符合 SVG/屏幕的向下坐标系。
   */
  function project(lon, lat) {
    const x = (R * lon * Math.PI) / 180;
    const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    return [x, -y];
  }

  function unproject(x, y) {
    const lon = ((x / R) * 180) / Math.PI;
    const lat = ((2 * Math.atan(Math.exp(-y / R)) - Math.PI / 2) * 180) / Math.PI;
    return [lon, lat];
  }

  function ringPath(ring, sink) {
    for (let i = 0; i < ring.length; i += 1) {
      const [lon, lat] = ring[i];
      const [x, y] = project(lon, lat);
      sink.push(i === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : `L${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    sink.push('Z');
  }

  function polysPath(polys) {
    const out = [];
    for (const poly of polys) for (const ring of poly) ringPath(ring, out);
    return out.join('');
  }

  function textWidth(text) {
    let w = 0;
    for (const ch of text) w += /[\u3400-\u9fff]/.test(ch) ? 13 : 7.4;
    return w;
  }

  class MapView {
    constructor(svg, stage) {
      this.svg = svg;
      this.stage = stage;
      this.mapLayer = svg.querySelector('#layer-map');
      this.markerLayer = svg.querySelector('#layer-marker');
      this.geo = null;
      this.places = [];
      this.selectedId = null;
      this.markerEls = new Map();
      this.baseK = 1;
      this.k = 1;
      this.tx = 0;
      this.ty = 0;
      this.userAdjusted = false;
      this.handlers = {};
      this.pickMode = false;
      this.bindInteractions();
      window.addEventListener('resize', () => this.onResize());
    }

    on(event, cb) {
      this.handlers[event] = cb;
    }

    emit(event, payload) {
      this.handlers[event]?.(payload);
    }

    setGeo(geo) {
      this.geo = geo;
      this.mapLayer.textContent = '';

      const cityPath = document.createElementNS(SVG_NS, 'path');
      cityPath.setAttribute('d', polysPath(geo.city.polygons));
      cityPath.setAttribute('class', 'city-outline');
      cityPath.setAttribute('fill-rule', 'evenodd');
      this.mapLayer.appendChild(cityPath);

      const districtPath = document.createElementNS(SVG_NS, 'path');
      districtPath.setAttribute('d', geo.districts.map((d) => polysPath(d.polygons)).join(''));
      districtPath.setAttribute('class', 'district-lines');
      districtPath.setAttribute('fill', 'none');
      districtPath.setAttribute('fill-rule', 'evenodd');
      this.mapLayer.appendChild(districtPath);

      const [w, s, e, n] = geo.city.bbox;
      const [x1, y1] = project(w, n);
      const [x2, y2] = project(e, s);
      this.worldBox = { x1, y1, x2, y2 };
      this.userAdjusted = false;
      this.fit();
    }

    setDistrictsVisible(visible) {
      this.mapLayer.classList.toggle('show-districts', Boolean(visible));
    }

    size() {
      const rect = this.stage.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    }

    fit() {
      if (!this.worldBox) return;
      const { w, h } = this.size();
      this.baseK = this.cityK();

      // 有地点时优先把地点框进视野，否则显示整个北京
      const points = this.places.map((p) => project(p.lon, p.lat));
      if (points.length >= 2) {
        const pad = 90;
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const [x, y] of points) {
          x1 = Math.min(x1, x);
          y1 = Math.min(y1, y);
          x2 = Math.max(x2, x);
          y2 = Math.max(y2, y);
        }
        const bw = Math.max(x2 - x1, 3000);
        const bh = Math.max(y2 - y1, 3000);
        const raw = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
        this.k = Math.max(this.baseK * 0.9, Math.min(raw, this.baseK * 60));
        this.tx = w / 2 - ((x1 + x2) / 2) * this.k;
        this.ty = h / 2 - ((y1 + y2) / 2) * this.k;
        this.userAdjusted = false;
        this.apply();
        return;
      }

      if (points.length === 1) {
        this.k = this.baseK * 6;
        this.tx = w / 2 - points[0][0] * this.k;
        this.ty = h / 2 - points[0][1] * this.k;
        this.userAdjusted = false;
        this.apply();
        return;
      }

      this.fitCity();
    }

    cityK() {
      const { w, h } = this.size();
      const bw = this.worldBox.x2 - this.worldBox.x1;
      const bh = this.worldBox.y2 - this.worldBox.y1;
      return Math.min(w / bw, h / bh) * 0.86;
    }

    fitCity() {
      const { w, h } = this.size();
      const k = this.cityK();
      this.baseK = k;
      this.k = k;
      this.tx = w / 2 - ((this.worldBox.x1 + this.worldBox.x2) / 2) * k;
      this.ty = h / 2 - ((this.worldBox.y1 + this.worldBox.y2) / 2) * k;
      this.userAdjusted = false;
      this.apply();
    }

    onResize() {
      if (!this.geo) return;
      if (this.userAdjusted) this.apply();
      else this.fit();
    }

    /**
     * 限制平移范围：保证地图与视口始终有足够重叠。
     * 注意要用「内容在屏幕上的实际位置」来判断（世界坐标是 1.29e7 量级，
     * 直接拿内容宽度当边界会把视图甩到空白区域）。
     */
    clampView() {
      const { w, h } = this.size();
      const keep = 140;
      const box = this.worldBox;

      const spanX = (box.x2 - box.x1) * this.k;
      if (spanX <= w - keep * 2) {
        // 比视口窄：居中，不让它被拖出画面
        this.tx = (w - spanX) / 2 - box.x1 * this.k;
      } else {
        const minTx = keep - box.x2 * this.k; // 右边缘至少进到 keep
        const maxTx = w - keep - box.x1 * this.k; // 左边缘不能越过 w - keep
        this.tx = Math.min(maxTx, Math.max(minTx, this.tx));
      }

      const spanY = (box.y2 - box.y1) * this.k;
      if (spanY <= h - keep * 2) {
        this.ty = (h - spanY) / 2 - box.y1 * this.k;
      } else {
        const minTy = keep - box.y2 * this.k;
        const maxTy = h - keep - box.y1 * this.k;
        this.ty = Math.min(maxTy, Math.max(minTy, this.ty));
      }
    }

    zoomAt(px, py, factor) {
      // 最大放大到「一屏约 700 米」，最小缩到整个北京
      const maxK = this.baseK * 300;
      const next = Math.max(this.baseK * 0.85, Math.min(maxK, this.k * factor));
      if (Math.abs(next - this.k) < 1e-9) return;
      const wx = (px - this.tx) / this.k;
      const wy = (py - this.ty) / this.k;
      this.k = next;
      this.tx = px - wx * this.k;
      this.ty = py - wy * this.k;
      this.userAdjusted = true;
      this.clampView();
      this.apply();
    }

    screenOf(lon, lat) {
      const [x, y] = project(lon, lat);
      return [x * this.k + this.tx, y * this.k + this.ty];
    }

    geoAt(px, py) {
      const [lon, lat] = unproject((px - this.tx) / this.k, (py - this.ty) / this.k);
      return { lon, lat };
    }

    setPlaces(places) {
      this.places = places;
      const alive = new Set();
      for (const place of places) {
        alive.add(place.id);
        let el = this.markerEls.get(place.id);
        if (!el) {
          el = this.createMarker(place);
          this.markerEls.set(place.id, el);
          this.markerLayer.appendChild(el);
        }
        el.querySelector('.marker-label').textContent = place.name;
        const titleEl = el.querySelector('title');
        if (titleEl) titleEl.textContent = place.name;
      }
      for (const [id, el] of this.markerEls) {
        if (!alive.has(id)) {
          el.remove();
          this.markerEls.delete(id);
        }
      }
      this.apply();
    }

    createMarker(place) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'marker');
      g.dataset.id = place.id;

      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = place.name;
      g.appendChild(title);

      const halo = document.createElementNS(SVG_NS, 'circle');
      halo.setAttribute('class', 'marker-hit');
      halo.setAttribute('r', '14');
      g.appendChild(halo);

      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'marker-dot');
      dot.setAttribute('r', '5');
      g.appendChild(dot);

      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('class', 'marker-ring');
      ring.setAttribute('r', '5');
      g.appendChild(ring);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'marker-label');
      label.setAttribute('x', '11');
      label.setAttribute('y', '4.2');
      g.appendChild(label);

      g.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.beginMarkerDrag(place.id, event);
      });

      return g;
    }

    beginMarkerDrag(id, event) {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      const onMove = (e) => {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) moved = true;
        if (!moved) return;
        const rect = this.stage.getBoundingClientRect();
        const geo = this.geoAt(e.clientX - rect.left, e.clientY - rect.top);
        this.emit('marker-move', { id, lon: geo.lon, lat: geo.lat });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) this.emit('marker-moved', { id });
        else this.emit('marker-click', { id });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    setSelected(id) {
      this.selectedId = id;
      for (const [markerId, el] of this.markerEls) {
        el.classList.toggle('is-selected', markerId === id);
      }
    }

    setPickMode(on) {
      this.pickMode = on;
      this.svg.classList.toggle('is-picking', on);
    }

    bindInteractions() {
      this.svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = this.stage.getBoundingClientRect();
        this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0016));
      }, { passive: false });

      this.svg.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target.closest('.marker')) return;
        const rect = this.stage.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const originTx = this.tx;
        const originTy = this.ty;
        let moved = false;
        this.svg.setPointerCapture(event.pointerId);

        const onMove = (e) => {
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (!moved && Math.hypot(dx, dy) > 3) moved = true;
          if (!moved) return;
          this.tx = originTx + dx;
          this.ty = originTy + dy;
          this.userAdjusted = true;
          this.clampView();
          this.apply();
        };
        const onUp = (e) => {
          this.svg.releasePointerCapture?.(e.pointerId);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (moved) return;
          const geo = this.geoAt(e.clientX - rect.left, e.clientY - rect.top);
          if (this.pickMode) this.emit('pick', geo);
          else this.emit('background-click', geo);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });

      this.svg.addEventListener('dblclick', (event) => {
        const rect = this.stage.getBoundingClientRect();
        this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, 1.8);
      });
    }

    apply() {
      if (!this.worldBox) return;
      this.mapLayer.setAttribute('transform', `translate(${this.tx} ${this.ty}) scale(${this.k})`);
      this.layoutMarkers();
      const { w, h } = this.size();
      const [, lat] = unproject((w / 2 - this.tx) / this.k, (h / 2 - this.ty) / this.k);
      this.emit('view', {
        k: this.k,
        metersPerPixel: Math.abs(Math.cos((lat * Math.PI) / 180) / this.k)
      });
    }

    layoutMarkers() {
      const placed = [];
      const order = [...this.markerEls.entries()];
      for (const [id, g] of order) {
        const place = this.places.find((p) => p.id === id);
        if (!place) continue;
        const [sx, sy] = this.screenOf(place.lon, place.lat);
        g.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);

        const label = g.querySelector('.marker-label');
        const text = place.name;
        const width = textWidth(text) + 6;
        const height = 16;
        const candidates = [
          { x: 11, y: 4.2, anchor: 'start', box: [sx + 8, sy - 9, sx + 8 + width, sy - 9 + height] },
          { x: -11, y: 4.2, anchor: 'end', box: [sx - 8 - width, sy - 9, sx - 8, sy - 9 + height] },
          { x: 0, y: -11, anchor: 'middle', box: [sx - width / 2, sy - 11 - height + 3, sx + width / 2, sy - 11 + 3] },
          { x: 0, y: 19, anchor: 'middle', box: [sx - width / 2, sy + 19, sx + width / 2, sy + 19 + height] }
        ];

        let chosen = null;
        for (const c of candidates) {
          const [bx1, by1, bx2, by2] = c.box;
          const hit = placed.some((r) => bx1 < r[2] && bx2 > r[0] && by1 < r[3] && by2 > r[1]);
          if (!hit) {
            chosen = c;
            break;
          }
        }
        if (!chosen) {
          g.classList.add('no-label');
          continue;
        }
        g.classList.remove('no-label');
        placed.push(chosen.box);
        label.setAttribute('x', chosen.x);
        label.setAttribute('y', chosen.y);
        label.setAttribute('text-anchor', chosen.anchor);
      }
    }
  }

  window.PTMap = { MapView, project, unproject };
})();
