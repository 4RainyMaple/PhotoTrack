/* 照片视图：某个地点下的照片浏览、导入、编辑、移动、回收站 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const api = () => window.phototrack;

  const S = {
    placeId: null,
    place: null,
    photos: [],
    trashMode: false,
    selected: new Set(),
    anchorId: null,
    filter: '',
    introOpen: true,
    lightboxId: null,
    busy: false,
    deps: null
  };

  // ------------------------------------------------------------ 工具

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setSub(text) {
    $('#pv-sub').textContent = text;
  }

  function defaultSub() {
    const n = S.photos.length;
    if (S.trashMode) {
      setSub(`回收站 · ${S.photos.length} 张`);
      return;
    }
    setSub(n === 0 ? '还没有照片' : `${n} 张照片`);
  }

  // ------------------------------------------------------------ 加载与渲染

  async function load() {
    const list = await api().listPhotos(S.placeId, S.trashMode);
    S.photos = Array.isArray(list) ? list : [];
    S.selected.clear();
    S.anchorId = null;
    render();
  }

  function visiblePhotos() {
    const q = S.filter.trim().toLowerCase();
    if (!q) return S.photos;
    return S.photos.filter(
      (p) => (p.title || '').toLowerCase().includes(q) || (p.origName || '').toLowerCase().includes(q)
    );
  }

  function render() {
    const grid = $('#pv-grid');
    grid.textContent = '';
    const list = visiblePhotos();

    for (const photo of list) {
      const fig = document.createElement('figure');
      fig.className = 'ph' + (S.selected.has(photo.id) ? ' is-selected' : '');
      fig.dataset.id = photo.id;
      fig.tabIndex = 0;
      fig.title = photo.title || photo.origName;

      const isVideo = photo.kind === 'video';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = photo.title || '';
      img.src = api().photoUrl(photo.id, 'thumb');
      img.addEventListener('error', function onError() {
        img.removeEventListener('error', onError);
        if (isVideo) {
          // 没有封面帧的视频：不显示破图，交给占位样式
          img.remove();
          fig.classList.add('ph-no-thumb');
          return;
        }
        img.src = api().photoUrl(photo.id, 'file');
      });

      const check = document.createElement('span');
      check.className = 'ph-check';
      check.textContent = '✓';

      const cap = document.createElement('figcaption');
      const title = document.createElement('span');
      title.className = 'ph-title';
      title.textContent = photo.title || photo.origName;
      const date = document.createElement('span');
      date.className = 'ph-date';
      date.textContent = isVideo && photo.duration ? formatDuration(photo.duration) : formatDate(photo.takenAt || photo.addedAt);
      cap.append(title, date);

      fig.append(img, check, cap);

      if (isVideo) {
        const play = document.createElement('span');
        play.className = 'ph-play';
        play.textContent = '▶';
        fig.append(play);
      }

      if (S.trashMode) {
        const restore = document.createElement('button');
        restore.className = 'ph-del ph-del-restore';
        restore.title = '恢复';
        restore.textContent = '↺';
        restore.addEventListener('click', async (event) => {
          event.stopPropagation();
          await api().restorePhoto(photo.id);
          await load();
          refreshCounts();
          S.deps.toast('已恢复 1 张');
        });
        fig.appendChild(restore);

        const purge = document.createElement('button');
        purge.className = 'ph-del ph-purge';
        purge.title = '永久删除（不可恢复）';
        purge.textContent = '🗑';
        purge.addEventListener('click', async (event) => {
          event.stopPropagation();
          const ok = await S.deps.confirm({
            title: '永久删除这个文件？',
            desc: '文件会从硬盘上删掉，无法恢复。',
            confirmText: '永久删除',
            danger: true
          });
          if (!ok) return;
          await api().purgePhoto(photo.id);
          await load();
          refreshCounts();
          S.deps.toast('已永久删除');
        });
        fig.appendChild(purge);
      } else {
        const del = document.createElement('button');
        del.className = 'ph-del';
        del.title = '移入回收站';
        del.textContent = '×';
        del.addEventListener('click', async (event) => {
          event.stopPropagation();
          await api().deletePhoto(photo.id);
          await load();
          refreshCounts();
          S.deps.toast('已移入回收站');
        });
        fig.appendChild(del);
      }

      grid.appendChild(fig);
    }

    $('#pv-empty').classList.toggle('hidden', list.length > 0);
    $('#pv-empty').querySelector('.pv-empty-title').textContent = S.trashMode ? '回收站是空的' : '这里还没有照片';
    $('#pv-empty').querySelector('.pv-empty-sub').textContent = S.trashMode
      ? '删除的照片会先放在这里，可以恢复'
      : '把图片拖进来，或点右上角「导入照片」';
    $('#pv-trash').classList.toggle('btn-primary', S.trashMode);
    $('#pv-trash').classList.toggle('btn-ghost', !S.trashMode);
    $('#pv-trash').textContent = S.trashMode ? '返回照片' : '回收站';
    $('#pv-import').classList.toggle('hidden', S.trashMode);
    $('#pv-purge-all').classList.toggle('hidden', !S.trashMode || list.length === 0);

    defaultSub();
    updateBulkBar();
  }

  function updateBulkBar() {
    const bar = $('#pv-bulk');
    const n = S.selected.size;
    bar.classList.toggle('hidden', n === 0 || S.trashMode);
    $('#pv-bulk-open').classList.toggle('hidden', n !== 1);
    if (n > 0) $('#pv-bulk-count').textContent = `已选 ${n} 张 · Ctrl/Shift+点击 可加选`;
  }

  /** 只切换选中样式，不重建 DOM —— 否则双击的第二下会落到新元素上，dblclick 永不触发 */
  function applySelection() {
    for (const card of $('#pv-grid').children) {
      card.classList.toggle('is-selected', S.selected.has(card.dataset.id));
    }
    updateBulkBar();
  }

  function refreshCounts() {
    api()
      .photoSummary()
      .then((summary) => S.deps.onSummary?.(summary))
      .catch(() => {});
  }

  // ------------------------------------------------------------ 选择

  function selectRange(targetId, additive) {
    const ids = visiblePhotos().map((p) => p.id);
    const from = ids.indexOf(S.anchorId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    if (!additive) S.selected.clear();
    for (let i = a; i <= b; i += 1) S.selected.add(ids[i]);
  }

  function toggleSelected(id) {
    if (S.selected.has(id)) S.selected.delete(id);
    else S.selected.add(id);
    S.anchorId = id;
    applySelection();
  }

  function onGridClick(event) {
    const card = event.target.closest('.ph');
    if (!card) return;
    const id = card.dataset.id;

    // 直接点勾选圆点：只切换这一张，不动其他选择
    if (event.target.closest('.ph-check')) {
      toggleSelected(id);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      toggleSelected(id);
      return;
    }

    if (event.shiftKey && S.anchorId) {
      selectRange(id, false);
      applySelection();
      return;
    }

    // 点击已选中的唯一一张时保持选中（方便紧接着双击打开大图）
    if (S.selected.size === 1 && S.selected.has(id)) return;

    S.selected.clear();
    S.selected.add(id);
    S.anchorId = id;
    applySelection();
  }

  // ------------------------------------------------------------ 大图

  function openLightbox(id) {
    const photo = S.photos.find((p) => p.id === id);
    if (!photo) return;
    S.lightboxId = id;

    const img = $('#lb-img');
    const video = $('#lb-video');
    const isVideo = photo.kind === 'video';

    if (isVideo) {
      img.classList.add('hidden');
      img.removeAttribute('src');
      video.classList.remove('hidden');
      video.src = api().photoUrl(id, 'file');
    } else {
      video.pause?.();
      video.classList.add('hidden');
      video.removeAttribute('src');
      img.classList.remove('hidden');
      img.src = api().photoUrl(id, 'file');
    }

    $('#lb-title').value = photo.title || '';
    $('#lb-note').value = photo.note || '';
    $('#lb-meta').textContent = [
      formatDate(photo.takenAt || photo.addedAt),
      photo.width && photo.height ? `${photo.width}×${photo.height}` : '',
      isVideo && photo.duration ? formatDuration(photo.duration) : '',
      formatSize(photo.size),
      photo.origName
    ]
      .filter(Boolean)
      .join('\n');
    $('#lb-delete').classList.toggle('hidden', S.trashMode);
    $('#lb-save').classList.toggle('hidden', S.trashMode);
    $('#lightbox').classList.remove('hidden');
    document.body.classList.add('lightbox-open');
  }

  function closeLightbox() {
    S.lightboxId = null;
    $('#lightbox').classList.add('hidden');
    $('#lb-img').src = '';
    const video = $('#lb-video');
    if (video) {
      video.pause?.();
      video.removeAttribute('src');
      video.load?.();
      video.classList.add('hidden');
    }
    $('#lb-img').classList.remove('hidden');
    document.body.classList.remove('lightbox-open');
  }

  function stepLightbox(delta) {
    const list = visiblePhotos();
    const index = list.findIndex((p) => p.id === S.lightboxId);
    if (index < 0) return;
    const next = list[(index + delta + list.length) % list.length];
    if (next) openLightbox(next.id);
  }

  async function saveLightbox() {
    if (!S.lightboxId) return;
    const photo = await api().updatePhoto(S.lightboxId, {
      title: $('#lb-title').value.trim(),
      note: $('#lb-note').value.trim()
    });
    const local = S.photos.find((p) => p.id === photo.id);
    if (local) Object.assign(local, photo);
    closeLightbox();
    render();
    S.deps.toast('已保存');
  }

  // ------------------------------------------------------------ 导入

  async function decodeImage(file) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return bitmap;
    } catch {
      return null;
    }
  }

  async function makeThumbBlob(bitmap, max = 640) {
    try {
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    } catch {
      return null;
    }
  }

  /** 视频：取时长、分辨率，并抽一帧当封面 */
  async function prepareVideo(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('读取视频元数据超时')), 8000);
        video.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject(new Error('无法解码这个视频'));
        };
      });

      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;

      let poster = null;
      try {
        video.currentTime = duration ? Math.min(1, duration / 2) : 0.1;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          video.onseeked = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        const scale = Math.min(1, 640 / Math.max(width || 1, height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((width || 640) * scale));
        canvas.height = Math.max(1, Math.round((height || 360) * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        poster = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      } catch {
        /* 抽帧失败就只保留原文件 */
      }

      return { width, height, duration, poster };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
  const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;

  async function importFiles(fileList) {
    if (S.busy || S.trashMode) return;
    const files = [...fileList].filter(
      (f) => /^image\//.test(f.type) || /^video\//.test(f.type) || IMAGE_RE.test(f.name) || VIDEO_RE.test(f.name)
    );
    if (!files.length) {
      S.deps.toast('没有可导入的文件（支持图片和 MP4 / WebM / MOV 视频）');
      return;
    }

    S.busy = true;
    let ok = 0;
    let failed = 0;
    const failures = [];
    const undecodable = [];

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setSub(`正在导入 ${i + 1}/${files.length}…`);
      try {
        const isVideo = /^video\//.test(file.type) || VIDEO_RE.test(file.name);

        if (isVideo) {
          const meta = await prepareVideo(file).catch((err) => {
            console.warn('视频元数据读取失败', file.name, err);
            undecodable.push(file.name);
            return null;
          });
          const photo = await api().uploadPhoto(
            S.placeId,
            file,
            {
              kind: 'video',
              width: meta?.width ?? 0,
              height: meta?.height ?? 0,
              duration: meta?.duration ?? 0
            },
            (pct) => setSub(`正在导入 ${i + 1}/${files.length} · ${pct}%`)
          );
          setSub(`正在生成封面 ${i + 1}/${files.length}…`);
          if (meta?.poster) await api().uploadThumb(photo.id, meta.poster);
        } else {
          const bitmap = await decodeImage(file);
          const photo = await api().uploadPhoto(
            S.placeId,
            file,
            {
              kind: 'image',
              width: bitmap?.width ?? 0,
              height: bitmap?.height ?? 0
            },
            (pct) => setSub(`正在导入 ${i + 1}/${files.length} · ${pct}%`)
          );
          setSub(`正在生成缩略图 ${i + 1}/${files.length}…`);
          if (bitmap) {
            const thumb = await makeThumbBlob(bitmap);
            if (thumb) await api().uploadThumb(photo.id, thumb);
            bitmap.close?.();
          }
        }
        ok += 1;
      } catch (err) {
        failed += 1;
        const reason =
          err.status === 403
            ? '服务已重启，请刷新页面后再试'
            : err.status === 415
              ? '不支持的格式（需要 MP4 / WebM / MOV）'
              : err.status === 413
                ? '文件过大'
                : err.message || '未知错误';
        failures.push(`${file.name}：${reason}`);
        console.error('导入失败', file.name, err);
      }
    }

    S.busy = false;
    await load();
    refreshCounts();
    if (failed) {
      S.deps.toast(`已导入 ${ok} 个，${failed} 个失败 —— ${failures[0]}`, 6000);
    } else if (undecodable.length) {
      S.deps.toast(
        `已导入 ${ok} 个，但 ${undecodable.length} 个视频无法预览（编码不受支持，如 H.265/HEVC），看不了就转成 H.264 的 MP4`,
        7000
      );
    } else {
      S.deps.toast(`已导入 ${ok} 个文件`);
    }
  }

  // ------------------------------------------------------------ 批量操作

  async function deleteSelected() {
    const ids = [...S.selected];
    if (!ids.length) return;
    const ok = await S.deps.confirm({
      title: `把 ${ids.length} 张照片移入回收站？`,
      desc: '照片会先放到回收站，可以恢复；清空回收站才会真正删除文件。',
      confirmText: '移入回收站',
      danger: true
    });
    if (!ok) return;
    for (const id of ids) await api().deletePhoto(id);
    await load();
    refreshCounts();
    S.deps.toast(`已移入回收站 ${ids.length} 张`);
  }

  function choosePlaceDialog(excludeId) {
    const dialog = $('#move-dialog');
    const select = $('#move-select');
    select.textContent = '';
    const options = S.deps.getPlaces().filter((p) => p.id !== excludeId);
    if (!options.length) {
      S.deps.toast('没有其他地点可以移动');
      return Promise.resolve(null);
    }
    for (const place of options) {
      const option = document.createElement('option');
      option.value = place.id;
      option.textContent = place.district ? `${place.name} · ${place.district}` : place.name;
      select.appendChild(option);
    }
    return new Promise((resolve) => {
      const done = (value) => {
        dialog.close();
        $('#move-ok').removeEventListener('click', onOk);
        $('#move-cancel').removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onCancel);
        resolve(value);
      };
      const onOk = () => done(select.value);
      const onCancel = (event) => {
        event?.preventDefault?.();
        done(null);
      };
      $('#move-ok').addEventListener('click', onOk);
      $('#move-cancel').addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
    });
  }

  async function moveSelected() {
    const ids = [...S.selected];
    if (!ids.length) return;
    const target = await choosePlaceDialog(S.placeId);
    if (!target) return;
    for (const id of ids) await api().updatePhoto(id, { placeId: target });
    await load();
    refreshCounts();
    const place = S.deps.getPlaces().find((p) => p.id === target);
    S.deps.toast(`已移动 ${ids.length} 张到「${place?.name ?? '其他地点'}」`);
  }

  // ------------------------------------------------------------ 打开 / 关闭

  // ------------------------------------------------------------ 简介栏

  function renderIntro() {
    const intro = (S.place?.intro || '').trim();
    const box = $('#pvi-text');
    box.textContent = intro || '还没有简介。点下面的「编辑简介」写几句。';
    box.classList.toggle('is-empty', !intro);
  }

  function applyIntroState() {
    $('#pv-intro').classList.toggle('hidden', !S.introOpen);
    const toggle = $('#pv-intro-toggle');
    toggle.classList.toggle('btn-primary', S.introOpen);
    toggle.classList.toggle('btn-ghost', !S.introOpen);
  }

  async function editIntro() {
    if (!S.place) return;
    const text = await S.deps.askMultiline({
      title: `「${S.place.name}」的简介`,
      desc: '只记文字：门票、开放时间、去过几次、拍了什么都可以。Ctrl+Enter 保存。',
      value: S.place.intro || '',
      placeholder: '随手写几句…',
      confirmText: '保存',
      maxLength: 800
    });
    if (text === null) return;
    S.deps.saveIntro(S.place.id, text);
    S.place.intro = text;
    renderIntro();
    S.deps.toast(text ? '简介已保存' : '简介已清空');
  }

  async function open(placeId) {
    S.placeId = placeId;
    S.place = S.deps.getPlaces().find((p) => p.id === placeId) ?? null;
    S.trashMode = false;
    S.filter = '';
    $('#pv-search').value = '';
    $('#pv-title').textContent = S.place ? S.place.name : '照片';
    renderIntro();
    applyIntroState();
    $('#photo-view').classList.remove('hidden');
    try {
      await load();
    } catch (err) {
      S.deps.toast(`加载照片失败：${err.message}`);
    }
    refreshCounts();
  }

  function close() {
    closeLightbox();
    $('#photo-view').classList.add('hidden');
    S.placeId = null;
    S.photos = [];
    S.selected.clear();
    S.deps.onClose?.();
  }

  function isOpen() {
    return !$('#photo-view').classList.contains('hidden');
  }

  // ------------------------------------------------------------ 事件绑定

  function bind() {
    $('#pv-back').addEventListener('click', close);
    $('#pv-intro-toggle').addEventListener('click', () => {
      S.introOpen = !S.introOpen;
      applyIntroState();
    });
    $('#pvi-collapse').addEventListener('click', () => {
      S.introOpen = false;
      applyIntroState();
    });
    $('#pvi-edit').addEventListener('click', editIntro);
    $('#pv-import').addEventListener('click', () => $('#pv-file').click());
    $('#pv-file').addEventListener('change', async (event) => {
      const files = event.target.files;
      event.target.value = '';
      if (files?.length) await importFiles(files);
    });

    $('#pv-trash').addEventListener('click', async () => {
      S.trashMode = !S.trashMode;
      S.selected.clear();
      await load();
    });

    $('#pv-search').addEventListener('input', (event) => {
      S.filter = event.target.value;
      render();
    });

    $('#pv-grid').addEventListener('click', onGridClick);
    $('#pv-grid').addEventListener('dblclick', (event) => {
      const card = event.target.closest('.ph');
      if (card) openLightbox(card.dataset.id);
    });

    $('#pv-purge-all').addEventListener('click', async () => {
      const count = S.photos.length;
      if (!count) return;
      const ok = await S.deps.confirm({
        title: `清空回收站里的 ${count} 个文件？`,
        desc: '这些文件会从硬盘上永久删除，无法恢复。',
        confirmText: '全部永久删除',
        danger: true
      });
      if (!ok) return;
      for (const photo of [...S.photos]) await api().purgePhoto(photo.id);
      await load();
      refreshCounts();
      S.deps.toast(`已永久删除 ${count} 个文件`);
    });

    $('#pv-bulk-open').addEventListener('click', () => {
      const [id] = [...S.selected];
      if (id) openLightbox(id);
    });
    $('#pv-bulk-delete').addEventListener('click', deleteSelected);
    $('#pv-bulk-move').addEventListener('click', moveSelected);
    $('#pv-bulk-clear').addEventListener('click', () => {
      S.selected.clear();
      render();
    });

    // 拖拽导入
    const view = $('#photo-view');
    let dragDepth = 0;
    view.addEventListener('dragenter', (event) => {
      if (S.trashMode) return;
      event.preventDefault();
      dragDepth += 1;
      $('#pv-drop-name').textContent = S.place?.name ?? '';
      $('#pv-drop').classList.remove('hidden');
    });
    view.addEventListener('dragover', (event) => {
      if (S.trashMode) return;
      event.preventDefault();
    });
    view.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#pv-drop').classList.add('hidden');
    });
    view.addEventListener('drop', async (event) => {
      event.preventDefault();
      dragDepth = 0;
      $('#pv-drop').classList.add('hidden');
      if (S.trashMode) return;
      if (event.dataTransfer?.files?.length) await importFiles(event.dataTransfer.files);
    });

    $('#lb-close').addEventListener('click', closeLightbox);
    $('#lb-prev').addEventListener('click', () => stepLightbox(-1));
    $('#lb-next').addEventListener('click', () => stepLightbox(1));
    $('#lb-save').addEventListener('click', saveLightbox);
    $('#lb-delete').addEventListener('click', async () => {
      if (!S.lightboxId) return;
      const id = S.lightboxId;
      await api().deletePhoto(id);
      closeLightbox();
      await load();
      refreshCounts();
      S.deps.toast('已移入回收站');
    });

    document.addEventListener('keydown', (event) => {
      if (S.lightboxId) {
        if (event.key === 'Escape') closeLightbox();
        else if (event.key === 'ArrowLeft') stepLightbox(-1);
        else if (event.key === 'ArrowRight') stepLightbox(1);
        return;
      }
      if (!isOpen()) return;
      if (event.key === 'Escape') {
        if (S.selected.size) {
          S.selected.clear();
          render();
        } else {
          close();
        }
      }
    });
  }

  function init(deps) {
    S.deps = deps;
    bind();
  }

  window.PTPhotos = { init, open, close, isOpen, refreshCounts };
})();
