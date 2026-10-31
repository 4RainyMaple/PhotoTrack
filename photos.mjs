// 照片/视频库：原始文件与缩略图落盘、索引带回收站标记
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm'
};

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm']);

export class NotFoundError extends Error {
  constructor(message = '照片不存在') {
    super(message);
    this.code = 'NOT_FOUND';
  }
}

/** 只认真正的图片文件，避免把任意文件塞进照片库 */
export function detectExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  if (buf.length > 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.length > 2 && buf.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  return null;
}

/** 识别视频容器：MP4 / MOV（ftyp 品牌）、WebM（EBML 头） */
export function detectVideoExt(buf) {
  if (buf.length > 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand === 'qt  ') return 'mov';
    return 'mp4';
  }
  if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

/** 综合识别：先按图片认，再按视频认 */
export function detectMedia(buf) {
  const image = detectExt(buf);
  if (image) return { ext: image, kind: 'image' };
  const video = detectVideoExt(buf);
  if (video) return { ext: video, kind: 'video' };
  return null;
}

export const isVideoExt = (ext) => VIDEO_EXT.has(ext);

export function createPhotoStore(userDir) {
  const originals = path.join(userDir, 'photos');
  const thumbs = path.join(userDir, 'thumbs');
  const indexFile = path.join(userDir, 'photos.json');

  let items = [];
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function writeIndex() {
    await fs.mkdir(userDir, { recursive: true });
    const tmp = `${indexFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
    await fs.rename(tmp, indexFile);
  }

  const byId = (id) => items.find((p) => p.id === id);
  const alive = (p) => !p.deletedAt;

  return {
    async init() {
      try {
        const raw = await fs.readFile(indexFile, 'utf8');
        const data = JSON.parse(raw);
        items = Array.isArray(data.items) ? data.items : [];
      } catch {
        items = [];
      }
    },

    list({ placeId, deleted = false } = {}) {
      // 固定按导入顺序（新的在前），不做时间排序
      return items
        .filter((p) => (placeId ? p.placeId === placeId : true))
        .filter((p) => (deleted ? Boolean(p.deletedAt) : alive(p)))
        .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
    },

    counts() {
      const map = {};
      for (const p of items) {
        if (!alive(p)) continue;
        map[p.placeId] = (map[p.placeId] ?? 0) + 1;
      }
      return map;
    },

    /** 每个地点的照片数 + 封面（最新一张） */
    summary() {
      const map = {};
      for (const p of items) {
        if (!alive(p)) continue;
        const entry = map[p.placeId] ?? (map[p.placeId] = { count: 0, coverId: null });
        entry.count += 1;
        if (!entry.coverId) entry.coverId = p.id;
      }
      return map;
    },

    get(id) {
      const photo = byId(id);
      if (!photo) throw new NotFoundError();
      return photo;
    },

    countForPlace(placeId) {
      return items.filter((p) => p.placeId === placeId && alive(p)).length;
    },

    add({ placeId, buffer, origName, width, height, takenAt }) {
      return exclusive(async () => {
        const media = detectMedia(buffer);
        if (!media) {
          throw Object.assign(new Error('不支持的文件格式（支持 JPEG / PNG / WebP / GIF / MP4 / WebM / MOV）'), {
            code: 'BAD_IMAGE'
          });
        }
        const id = 'p' + crypto.randomBytes(8).toString('hex');
        await fs.mkdir(originals, { recursive: true });
        await fs.writeFile(path.join(originals, `${id}.${media.ext}`), buffer);

        const cleanName = String(origName || `文件.${media.ext}`).slice(0, 200);
        const photo = {
          id,
          placeId: String(placeId),
          kind: media.kind,
          ext: media.ext,
          origName: cleanName,
          title: cleanName.replace(/\.[^.]+$/, ''),
          note: '',
          width: Number(width) || 0,
          height: Number(height) || 0,
          duration: 0,
          size: buffer.length,
          takenAt: takenAt || null,
          addedAt: new Date().toISOString(),
          deletedAt: null,
          hasThumb: false
        };
        items.unshift(photo);
        await writeIndex();
        return photo;
      });
    },

    /** 服务端已把上传流落到临时文件，这里只做登记与移动 */
    addFromFile({ placeId, tempPath, size, origName, width, height, duration, takenAt, ext, kind }) {
      return exclusive(async () => {
        const id = 'p' + crypto.randomBytes(8).toString('hex');
        await fs.mkdir(originals, { recursive: true });
        await fs.rename(tempPath, path.join(originals, `${id}.${ext}`));

        const cleanName = String(origName || `文件.${ext}`).slice(0, 200);
        const photo = {
          id,
          placeId: String(placeId),
          kind: kind === 'video' ? 'video' : 'image',
          ext,
          origName: cleanName,
          title: cleanName.replace(/\.[^.]+$/, ''),
          note: '',
          width: Number(width) || 0,
          height: Number(height) || 0,
          duration: Number(duration) || 0,
          size: Number(size) || 0,
          takenAt: takenAt || null,
          addedAt: new Date().toISOString(),
          deletedAt: null,
          hasThumb: false
        };
        items.unshift(photo);
        await writeIndex();
        return photo;
      });
    },

    setThumb(id, buffer) {
      return exclusive(async () => {
        const photo = this.get(id);
        await fs.mkdir(thumbs, { recursive: true });
        await fs.writeFile(path.join(thumbs, `${id}.jpg`), buffer);
        photo.hasThumb = true;
        await writeIndex();
        return photo;
      });
    },

    update(id, patch) {
      return exclusive(async () => {
        const photo = this.get(id);
        for (const key of ['title', 'note', 'takenAt']) {
          if (patch[key] !== undefined) photo[key] = patch[key];
        }
        if (patch.placeId !== undefined) photo.placeId = String(patch.placeId);
        await writeIndex();
        return photo;
      });
    },

    softDelete(id) {
      return exclusive(async () => {
        const photo = this.get(id);
        photo.deletedAt = new Date().toISOString();
        await writeIndex();
        return photo;
      });
    },

    restore(id) {
      return exclusive(async () => {
        const photo = this.get(id);
        photo.deletedAt = null;
        await writeIndex();
        return photo;
      });
    },

    purge(id) {
      return exclusive(async () => {
        const photo = byId(id);
        if (!photo) return { removed: false };
        items = items.filter((p) => p.id !== id);
        await fs.rm(path.join(originals, `${id}.${photo.ext}`), { force: true });
        await fs.rm(path.join(thumbs, `${id}.jpg`), { force: true });
        await writeIndex();
        return { removed: true };
      });
    },

    /** 删除地点时清理其名下所有照片（客户端已保证只在无照片时允许删地点） */
    purgePlace(placeId) {
      return exclusive(async () => {
        const doomed = items.filter((p) => p.placeId === placeId);
        items = items.filter((p) => p.placeId !== placeId);
        for (const photo of doomed) {
          await fs.rm(path.join(originals, `${photo.id}.${photo.ext}`), { force: true });
          await fs.rm(path.join(thumbs, `${photo.id}.jpg`), { force: true });
        }
        await writeIndex();
        return doomed.length;
      });
    },

    filePath(id) {
      const photo = this.get(id);
      return path.join(originals, `${photo.id}.${photo.ext}`);
    },

    thumbPath(id) {
      const photo = this.get(id);
      if (!photo.hasThumb) throw new NotFoundError('缩略图未生成');
      return path.join(thumbs, `${photo.id}.jpg`);
    },

    mimeOf(id) {
      const photo = this.get(id);
      return EXT_MIME[photo.ext] ?? 'application/octet-stream';
    }
  };
}
