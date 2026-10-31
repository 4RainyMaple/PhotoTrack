/* 数据桥：页面与本地服务之间的唯一通道（HTTP + 一次性令牌） */
(function () {
  'use strict';
  if (window.phototrack) return;

  class HttpError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = 'HttpError';
      this.status = status;
      this.payload = payload;
    }
  }

  // 服务启动时注入的一次性令牌：同机其他程序/网页拿不到，无法调用接口
  const TOKEN = document.querySelector('meta[name="pt-token"]')?.content || '';

  const authHeaders = (extra = {}) => ({ 'X-PT-Token': TOKEN, ...extra });

  async function request(url, options = {}) {
    const res = await fetch(url, { ...options, headers: authHeaders(options.headers || {}) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 120) };
    }
    if (!res.ok) {
      throw new HttpError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data);
    }
    return data;
  }

  /** 图片地址要拼上令牌（img 标签没法带请求头） */
  function photoUrl(id, kind = 'thumb') {
    return `/api/photos/${id}/${kind}?t=${encodeURIComponent(TOKEN)}`;
  }

  const jsonHeaders = { 'Content-Type': 'application/json' };

  window.phototrack = {
    photoUrl,
    loadBootstrap: () => request('/api/bootstrap'),

    getSettings: () => request('/api/settings'),
    setDataDir: (dir) =>
      request('/api/settings/data-dir', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ dir })
      }),

    loadPlaces: () => request('/api/places'),
    savePlaces: (places, baseRev) =>
      request('/api/places', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ places, baseRev }) }),
    deletePlace: (id) => request(`/api/places/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listPhotos: (placeId, deleted = false) =>
      request(`/api/photos?placeId=${encodeURIComponent(placeId)}${deleted ? '&deleted=1' : ''}`),
    photoCounts: () => request('/api/photos/counts'),
    photoSummary: () => request('/api/photos/summary'),

    /** 上传文件；onProgress(0-100) 用于显示进度（fetch 拿不到上传进度，这里用 XHR） */
    uploadPhoto: (placeId, file, meta = {}, onProgress) => {
      const headers = {
        'Content-Type': file.type || 'application/octet-stream',
        'X-PT-Token': TOKEN,
        'X-Place-Id': placeId,
        'X-File-Name': encodeURIComponent(file.name),
        'X-Taken-At': file.lastModified ? new Date(file.lastModified).toISOString() : '',
        'X-Kind': meta.kind || 'image',
        'X-Duration': String(Math.round(meta.duration || 0)),
        'X-Width': String(meta.width || 0),
        'X-Height': String(meta.height || 0)
      };

      if (typeof XMLHttpRequest === 'function') {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/photos', true);
          for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);

          if (onProgress && xhr.upload) {
            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
            };
          }

          xhr.onload = () => {
            let data = null;
            try {
              data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
            } catch {
              data = { error: String(xhr.responseText).slice(0, 120) };
            }
            if (xhr.status >= 200 && xhr.status < 300) resolve(data);
            else reject(new HttpError(data?.message || data?.error || `HTTP ${xhr.status}`, xhr.status, data));
          };
          xhr.onerror = () => reject(new HttpError('上传中断', 0, null));
          xhr.onabort = () => reject(new HttpError('上传已取消', 0, null));
          xhr.send(file);
        });
      }

      return request('/api/photos', { method: 'POST', headers, body: file });
    },

    uploadThumb: (id, blob) =>
      request(`/api/photos/${id}/thumb`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob
      }),

    updatePhoto: (id, patch) =>
      request(`/api/photos/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) }),
    deletePhoto: (id) => request(`/api/photos/${id}`, { method: 'DELETE' }),
    purgePhoto: (id) => request(`/api/photos/${id}?permanent=1`, { method: 'DELETE' }),
    restorePhoto: (id) => request(`/api/photos/${id}/restore`, { method: 'POST' })
  };

  // 心跳：窗口关掉后心跳停止，本地服务会自动退出
  const ping = () => {
    fetch('/api/ping', { method: 'POST', keepalive: true, headers: authHeaders() }).catch(() => {});
  };
  ping();
  setInterval(ping, 15000);
})();
