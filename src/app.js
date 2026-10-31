/* PhotoTrack 渲染层：北京地图 + 地点增删改 + 本地持久化 */
(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const state = {
    geo: null,
    poi: [],
    places: [],
    placesRev: 0,
    counts: {},
    summary: {},
    selectedId: null,
    filter: '',
    pickMode: false,
    adding: false
  };

  const map = new PTMap.MapView($('#map'), $('#stage'));
  window.__map = map;
  window.__state = state;
  let saveTimer = null;
  let activeResult = -1;

  // ------------------------------------------------------------ 工具

  function newId() {
    return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function distanceMeters(a, b) {
    const dx = (a.lon - b.lon) * 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const dy = (a.lat - b.lat) * 110540;
    return Math.hypot(dx, dy);
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

  function districtOf(lon, lat) {
    if (!state.geo) return '';
    for (const district of state.geo.districts) {
      for (const poly of district.polygons) {
        if (!poly.length) continue;
        const [outer, ...holes] = poly;
        if (!pointInRing([lon, lat], outer)) continue;
        if (holes.some((hole) => pointInRing([lon, lat], hole))) continue;
        return district.name;
      }
    }
    return '';
  }

  function toast(message, ms = 2200) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  // ------------------------------------------------------------ 持久化

  function persist(immediate = false) {
    clearTimeout(saveTimer);
    const run = async () => {
      try {
        const res = await window.phototrack.savePlaces(state.places, state.placesRev);
        if (typeof res?.rev === 'number') state.placesRev = res.rev;
      } catch (err) {
        // 另一个窗口先写入了：以服务端为准，避免互相覆盖
        if (err.status === 409 && Array.isArray(err.payload?.places)) {
          state.places = err.payload.places;
          state.placesRev = err.payload.rev ?? state.placesRev;
          state.selectedId = state.places.some((p) => p.id === state.selectedId) ? state.selectedId : null;
          refresh();
          toast('另一个窗口修改了地点，已重新加载', 3200);
          return;
        }
        toast(`保存失败：${err.message}`, 4000);
      }
    };
    if (immediate) run();
    else saveTimer = setTimeout(run, 250);
  }

  // ------------------------------------------------------------ 渲染

  function placeMeta(place) {
    const base = [place.district, place.category].filter(Boolean).join(' · ') || '自定义地点';
    const count = state.counts[place.id] ?? 0;
    return count > 0 ? `${base} · ${count} 张` : base;
  }

  function renderList() {
    const list = $('#place-list');
    const visible = PTSearch.filter(state.places, state.filter);
    list.textContent = '';

    for (const place of visible) {
      const li = document.createElement('li');
      li.className = 'place-item' + (place.id === state.selectedId ? ' is-selected' : '');

      const dot = document.createElement('span');
      dot.className = 'dot';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = place.name;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = placeMeta(place);
      meta.append(name, sub);

      const del = document.createElement('button');
      del.className = 'del';
      del.title = '删除地点';
      del.textContent = '×';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        removePlace(place.id);
      });

      li.append(dot, meta, del);
      li.addEventListener('click', () => {
        selectPlace(place.id, true);
      });
      list.appendChild(li);
    }

    const count = state.places.length;
    $('#place-count').textContent = state.filter ? `${visible.length} / ${count} 个地点` : `${count} 个地点`;
    $('#list-empty').classList.toggle('hidden', visible.length > 0);
    $('#list-empty').textContent = state.places.length === 0 ? '还没有添加地点。点右上角「添加地点」开始。' : '没有匹配的地点';
    $('#hint').classList.toggle('hidden', state.places.length > 0);
  }

  function renderDetail() {
    const card = $('#detail');
    const place = state.places.find((p) => p.id === state.selectedId);
    if (!place) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    $('#detail-name').textContent = place.name;
    $('#detail-meta').textContent = placeMeta(place);
    $('#detail-coords').textContent = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;

    const coverId = state.summary?.[place.id]?.coverId;
    const cover = $('#detail-cover');
    // 视频可能还没生成封面帧，加载失败就退回小圆点
    cover.onerror = () => {
      cover.classList.add('hidden');
      card.classList.remove('has-cover');
    };
    if (coverId) {
      cover.src = window.phototrack.photoUrl(coverId, 'thumb');
      cover.classList.remove('hidden');
      card.classList.add('has-cover');
    } else {
      cover.removeAttribute('src');
      cover.classList.add('hidden');
      card.classList.remove('has-cover');
    }
  }

  function refresh() {
    syncMap();
    map.setSelected(state.selectedId);
    renderList();
    renderDetail();
  }

  /** 地图标注需要知道每个地点有几张照片 */
  function withCounts(list) {
    return list.map((place) => ({ ...place, count: state.counts[place.id] || 0 }));
  }

  function syncMap() {
    map.setPlaces(withCounts(state.places));
  }

  // ------------------------------------------------------------ 地点操作

  function selectPlace(id, center = false) {
    state.selectedId = id;
    map.setSelected(id);
    renderList();
    renderDetail();
    if (center && id) centerOn(id);
    closeAddPanel();
  }

  function centerOn(id) {
    const place = state.places.find((p) => p.id === id);
    if (!place) return;
    const [sx, sy] = map.screenOf(place.lon, place.lat);
    const { w, h } = map.size();
    const margin = 120;
    if (sx > margin && sx < w - margin && sy > margin && sy < h - margin) return;
    map.tx += w / 2 - sx;
    map.ty += h / 2 - sy;
    map.userAdjusted = true;
    map.clampView();
    map.apply();
  }

  function addPlace(place) {
    state.places.push(place);
    refresh();
    selectPlace(place.id, true);
    persist();
    if (state.places.length === 1) map.fit();
    toast(`已添加「${place.name}」`);
  }

  function addFromPoi(poiPlace) {
    const dup = state.places.find((p) => p.name === poiPlace.name && distanceMeters(p, poiPlace) < 300);
    if (dup) {
      selectPlace(dup.id, true);
      toast('这个地点已经在列表里了');
      return;
    }
    addPlace({
      id: newId(),
      name: poiPlace.name,
      lat: poiPlace.lat,
      lon: poiPlace.lon,
      district: poiPlace.district || districtOf(poiPlace.lon, poiPlace.lat),
      category: poiPlace.category,
      source: 'poi',
      poiId: poiPlace.id,
      createdAt: Date.now()
    });
  }

  async function onMapPick({ lon, lat }) {
    cancelPick();
    const district = districtOf(lon, lat);
    const name = await askText({
      title: '这个位置叫什么？',
      desc: `坐标 ${lon.toFixed(5)}, ${lat.toFixed(5)}${district ? ` · ${district}` : ''}。先起个名字，之后随时可以重命名。`,
      placeholder: '例如：公司楼下的咖啡馆',
      value: '',
      confirmText: '添加'
    });
    if (!name) return;
    addPlace({
      id: newId(),
      name,
      lat,
      lon,
      district,
      category: '自定义',
      source: 'click',
      createdAt: Date.now()
    });
  }

  async function renamePlace(id) {
    const place = state.places.find((p) => p.id === id);
    if (!place) return;
    const name = await askText({
      title: '重命名地点',
      desc: '只改显示名称，不会改变位置。',
      value: place.name,
      confirmText: '保存'
    });
    if (!name || name === place.name) return;
    place.name = name;
    persist();
    refresh();
    toast('名称已更新');
  }

  async function removePlace(id) {
    const place = state.places.find((p) => p.id === id);
    if (!place) return;

    const count = state.counts[id] ?? 0;
    if (count > 0) {
      const goTrash = await askConfirm({
        title: `「${place.name}」还有 ${count} 张照片`,
        desc: '有照片的地点不能直接删除。要现在打开它，把照片移动或删掉吗？',
        confirmText: '去处理照片',
        danger: false
      });
      if (goTrash) {
        selectPlace(id);
        window.PTPhotos?.open(id);
      }
      return;
    }

    const ok = await askConfirm({
      title: `删除「${place.name}」？`,
      desc: '这个地点会从地图上移除。',
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;

    try {
      const res = await window.phototrack.deletePlace(id);
      if (typeof res?.rev === 'number') state.placesRev = res.rev;
    } catch (err) {
      if (err.status === 409) {
        toast(`这个地点还有 ${err.payload?.count ?? ''} 张照片，先清空再删`, 3600);
      } else {
        toast(`删除失败：${err.message}`, 4000);
      }
      return;
    }

    state.places = state.places.filter((p) => p.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    refresh();
    if (state.places.length === 0) map.fitCity();
    toast('地点已删除');
  }

  // ------------------------------------------------------------ 添加面板

  function openAddPanel() {
    const panel = $('#add-panel');
    panel.classList.remove('hidden');
    const input = $('#add-input');
    input.value = '';
    input.focus();
    renderResults('');
  }

  function closeAddPanel() {
    $('#add-panel').classList.add('hidden');
    activeResult = -1;
  }

  function renderResults(query) {
    const list = $('#add-results');
    list.textContent = '';
    const items = query.trim()
      ? PTSearch.query(state.poi, query, 8)
      : [...state.poi].sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, 8);

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'result-empty';
      li.textContent = '地点库里没有找到。可以换个说法，或者到地图上点选位置。';
      list.appendChild(li);
      activeResult = -1;
      return;
    }

    items.forEach((poiPlace, index) => {
      const li = document.createElement('li');
      li.className = 'result' + (index === 0 ? ' is-active' : '');
      li.dataset.index = String(index);

      const name = document.createElement('span');
      name.className = 'r-name';
      name.textContent = poiPlace.name;

      const meta = document.createElement('span');
      meta.className = 'r-meta';
      meta.textContent = [poiPlace.district, poiPlace.category].filter(Boolean).join(' · ');

      li.append(name, meta);
      li.addEventListener('mouseenter', () => setActiveResult(index));
      li.addEventListener('click', () => {
        addFromPoi(poiPlace);
        closeAddPanel();
      });
      list.appendChild(li);
    });

    activeResult = 0;
  }

  function setActiveResult(index) {
    const items = [...$('#add-results').children].filter((el) => el.classList.contains('result'));
    if (!items.length) return;
    activeResult = (index + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('is-active', i === activeResult));
  }

  function chooseActiveResult() {
    const items = [...$('#add-results').children].filter((el) => el.classList.contains('result'));
    const el = items[activeResult] ?? items[0];
    if (!el) return;
    const query = $('#add-input').value;
    const results = query.trim()
      ? PTSearch.query(state.poi, query, 8)
      : [...state.poi].sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, 8);
    const poiPlace = results[Number(el.dataset.index)];
    if (!poiPlace) return;
    addFromPoi(poiPlace);
    closeAddPanel();
  }

  // ------------------------------------------------------------ 点选模式

  function startPick() {
    closeAddPanel();
    state.pickMode = true;
    map.setPickMode(true);
    $('#pick-banner').classList.remove('hidden');
  }

  function cancelPick() {
    state.pickMode = false;
    map.setPickMode(false);
    $('#pick-banner').classList.add('hidden');
  }

  // ------------------------------------------------------------ 对话框

  function askText({ title, desc = '', value = '', placeholder = '', confirmText = '确定' }) {
    return openDialog({ title, desc, value, placeholder, confirmText, withInput: true });
  }

  function askMultiline({ title, desc = '', value = '', placeholder = '', confirmText = '保存', maxLength = 800 }) {
    return openDialog({ title, desc, value, placeholder, confirmText, withInput: true, multiline: true, maxLength });
  }

  function askConfirm({ title, desc = '', confirmText = '确定', danger = false }) {
    return openDialog({ title, desc, confirmText, withInput: false, danger });
  }

  function openDialog({
    title,
    desc,
    value = '',
    placeholder = '',
    confirmText,
    withInput,
    multiline = false,
    maxLength = 0,
    danger = false
  }) {
    const dialog = $('#ask');
    const input = $('#ask-input');
    const area = $('#ask-textarea');
    const field = multiline ? area : input;
    const ok = $('#ask-ok');
    const cancel = $('#ask-cancel');

    $('#ask-title').textContent = title;
    $('#ask-desc').textContent = desc;
    $('#ask-desc').classList.toggle('hidden', !desc);
    input.classList.toggle('hidden', !withInput || multiline);
    area.classList.toggle('hidden', !withInput || !multiline);
    field.value = value;
    field.placeholder = placeholder;
    if (maxLength) field.maxLength = maxLength;
    ok.textContent = confirmText;
    ok.classList.toggle('btn-primary', !danger);
    ok.classList.toggle('danger-solid', danger);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        dialog.close();
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        field.removeEventListener('keydown', onKey);
        dialog.removeEventListener('cancel', onCancelEvent);
        resolve(result);
      };
      const onOk = () => finish(withInput ? field.value.trim() : true);
      const onCancel = () => finish(withInput ? null : false);
      const onCancelEvent = (event) => {
        event.preventDefault();
        finish(withInput ? null : false);
      };
      const onKey = (event) => {
        // 多行输入里 Enter 是换行，Ctrl/Cmd+Enter 才提交
        if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          onOk();
        }
      };

      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      field.addEventListener('keydown', onKey);
      dialog.addEventListener('cancel', onCancelEvent);

      dialog.showModal();
      if (withInput) {
        input.focus();
        input.select();
      } else {
        ok.focus();
      }
    });
  }

  function updateScaleBar({ metersPerPixel }) {
    const bar = $('#scalebar');
    if (!bar || !Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return;
    const steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
    let chosen = steps[0];
    for (const meters of steps) {
      if (meters / metersPerPixel <= 150) chosen = meters;
      else break;
    }
    const px = Math.max(28, Math.min(150, chosen / metersPerPixel));
    bar.querySelector('.scalebar-bar').style.width = `${px.toFixed(0)}px`;
    bar.querySelector('.scalebar-label').textContent = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
  }

  /** 点击 +/− 时优先围绕选中/可见标注缩放，避免把它们挤出屏幕 */
  function zoomCenter() {
    const { w, h } = map.size();
    const selected = state.places.find((p) => p.id === state.selectedId);
    if (selected) {
      const [sx, sy] = map.screenOf(selected.lon, selected.lat);
      if (sx > 0 && sx < w && sy > 0 && sy < h) return [sx, sy];
    }
    const pts = state.places
      .map((p) => map.screenOf(p.lon, p.lat))
      .filter(([x, y]) => x > -40 && x < w + 40 && y > -40 && y < h + 40);
    if (!pts.length) return [w / 2, h / 2];
    const sx = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
    const sy = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
    return [sx, sy];
  }

  // ------------------------------------------------------------ 设置（数据目录）

  async function openSettings() {
    const dialog = $('#settings-dialog');
    const current = await window.phototrack.getSettings().catch(() => null);
    $('#settings-current').textContent = current?.dataDir ?? '未知';
    $('#settings-input').value = current?.defaultDir || current?.dataDir || '';
    $('#settings-error').classList.add('hidden');
    dialog.showModal();
    $('#settings-input').focus();
    $('#settings-input').select();
  }

  /** 迁移后服务会自我重启，轮询到新实例起来就刷新页面（令牌会变） */
  function waitForRestart() {
    const started = Date.now();
    const tick = async () => {
      try {
        const res = await fetch('/api/hello', { cache: 'no-store' });
        if (res.ok) {
          location.reload();
          return;
        }
      } catch {
        /* 还没起来 */
      }
      if (Date.now() - started < 20000) setTimeout(tick, 500);
      else toast('服务没有响应，请手动运行 npm run restart', 8000);
    };
    setTimeout(tick, 800);
  }

  async function applyDataDir(dir) {
    const err = $('#settings-error');
    const btn = $('#settings-ok');
    err.classList.add('hidden');
    if (!dir) {
      err.textContent = '请填写目录路径';
      err.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    btn.textContent = '正在迁移…';
    try {
      await window.phototrack.setDataDir(dir);
      $('#settings-dialog').close();
      toast('正在重启服务，稍候页面会自己刷新…', 8000);
      waitForRestart();
    } catch (e) {
      err.textContent = e.message || '迁移失败';
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '迁移并重启';
    }
  }

  // ------------------------------------------------------------ 绑定

  function bindUI() {
    map.on('marker-click', ({ id }) => selectPlace(id));
    map.on('marker-move', ({ id, lon, lat }) => {
      const place = state.places.find((p) => p.id === id);
      if (!place) return;
      place.lat = lat;
      place.lon = lon;
      place.district = districtOf(lon, lat) || place.district;
      syncMap();
      renderDetail();
    });
    map.on('marker-moved', () => {
      persist();
      toast('位置已微调');
    });
    map.on('background-click', () => {
      if (!state.pickMode) selectPlace(null);
    });
    map.on('pick', onMapPick);

    $('#btn-add').addEventListener('click', () => {
      if ($('#add-panel').classList.contains('hidden')) openAddPanel();
      else closeAddPanel();
    });

    $('#add-close').addEventListener('click', closeAddPanel);

    $('#add-input').addEventListener('input', (event) => {
      renderResults(event.target.value);
    });

    $('#add-input').addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveResult(activeResult + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveResult(activeResult - 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        chooseActiveResult();
      } else if (event.key === 'Escape') {
        closeAddPanel();
      }
    });

    $('#pick-start').addEventListener('click', startPick);

    $('#q').addEventListener('input', (event) => {
      state.filter = event.target.value;
      renderList();
    });

    $('#toggle-districts').addEventListener('change', (event) => {
      map.setDistrictsVisible(event.target.checked);
    });

    $('#btn-fit').addEventListener('click', () => map.fit());
    $('#zoom-fit').addEventListener('click', () => map.fit());
    $('#zoom-in').addEventListener('click', () => {
      const [x, y] = zoomCenter();
      map.zoomAt(x, y, 1.5);
    });
    $('#zoom-out').addEventListener('click', () => {
      const [x, y] = zoomCenter();
      map.zoomAt(x, y, 1 / 1.5);
    });
    map.on('view', updateScaleBar);

    $('#btn-settings').addEventListener('click', openSettings);
    $('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
    $('#settings-ok').addEventListener('click', () => applyDataDir($('#settings-input').value.trim()));
    $('#settings-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyDataDir($('#settings-input').value.trim());
      }
    });

    $('#detail-close').addEventListener('click', () => selectPlace(null));
    $('#detail-visit').addEventListener('click', () => {
      if (!state.selectedId) return;
      window.PTPhotos?.open(state.selectedId);
    });
    $('#detail-rename').addEventListener('click', () => {
      if (state.selectedId) renamePlace(state.selectedId);
    });
    $('#detail-delete').addEventListener('click', () => {
      if (state.selectedId) removePlace(state.selectedId);
    });

    document.addEventListener('pointerdown', (event) => {
      const panel = $('#add-panel');
      if (panel.classList.contains('hidden')) return;
      if (panel.contains(event.target) || event.target.closest('#btn-add')) return;
      closeAddPanel();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (state.pickMode) cancelPick();
      else closeAddPanel();
    });

    window.addEventListener('beforeunload', () => persist(true));
  }

  // ------------------------------------------------------------ 启动

  async function boot() {
    bindUI();
    let data;
    try {
      data = await window.phototrack.loadBootstrap();
    } catch (err) {
      toast(`加载失败：${err.message}`, 5000);
      return;
    }
    if (!data.geo) {
      toast('缺少地图数据，请先运行 npm run build:geo', 6000);
      return;
    }
    state.geo = data.geo;
    state.poi = data.poi?.places ?? [];
    const cityName = data.geo.city?.name?.replace(/市$/, '') || '北京';
    document.querySelector('.city-chip').textContent = cityName;
    map.setGeo(data.geo);
    map.setPlaces([]);
    map.setDistrictsVisible(false);

    try {
      const saved = await window.phototrack.loadPlaces();
      state.places = Array.isArray(saved?.places) ? saved.places : [];
      state.placesRev = Number(saved?.rev) || 0;
    } catch {
      state.places = [];
      state.placesRev = 0;
    }

    await refreshCounts();
    refresh();

    window.PTPhotos?.init({
      getPlaces: () => state.places,
      toast,
      confirm: askConfirm,
      askMultiline,
      saveIntro: (placeId, text) => {
        const place = state.places.find((p) => p.id === placeId);
        if (!place) return;
        place.intro = text;
        persist();
        refresh();
      },
      onSummary: (summary) => {
        state.summary = summary ?? {};
        state.counts = Object.fromEntries(Object.entries(state.summary).map(([id, value]) => [id, value.count]));
        renderList();
        renderDetail();
        syncMap();
      },
      onClose: () => refreshCounts().then(() => refresh())
    });

    toast(`已载入 ${state.poi.length} 个北京地点，试试输入「颐和园」`, 3600);
  }

  async function refreshCounts() {
    try {
      const summary = await window.phototrack.photoSummary();
      state.summary = summary || {};
      state.counts = Object.fromEntries(Object.entries(state.summary).map(([id, value]) => [id, value.count]));
    } catch {
      state.summary = state.summary ?? {};
      state.counts = state.counts ?? {};
    }
    return state.counts;
  }

  // ------------------------------------------------------------ 演示数据（仅截图自测）

  window.__seedDemo = function seedDemo() {
    const wanted = ['颐和园', '圆明园', '天安门广场', '北京大学', '清华大学', '三里屯', '798艺术区', '香山公园', '北京南站', '雍和宫'];
    const added = [];
    for (const name of wanted) {
      const hit = state.poi.find((p) => p.name === name);
      if (hit) {
        state.places.push({
          id: newId(),
          name: hit.name,
          lat: hit.lat,
          lon: hit.lon,
          district: hit.district,
          category: hit.category,
          source: 'poi',
          poiId: hit.id,
          createdAt: Date.now()
        });
        added.push(`${hit.name}@${hit.district}`);
      } else {
        added.push(`MISS:${name}`);
      }
    }
    state.selectedId = state.places[0]?.id ?? null;
    refresh();
    map.fit();
    return added;
  };

  boot();
})();
