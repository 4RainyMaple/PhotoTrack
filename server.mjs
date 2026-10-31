// PhotoTrack 本地服务：托管界面 + 地点/照片 API + 单实例 + 以 Edge 应用窗口打开
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlacesStore, ConflictError } from './places.mjs';
import { createPhotoStore, NotFoundError, EXT_MIME, detectMedia } from './photos.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PORT_START = 48765;
const MAX_UPLOAD = 60 * 1024 * 1024;
const MAX_MEDIA = 2 * 1024 * 1024 * 1024; // 视频可能很大，单个上限 2GB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function createApp(root = ROOT, userDirOverride) {
  const srcDir = path.join(root, 'src');
  const dataDir = path.join(root, 'data');
  // 数据目录优先级：环境变量（测试用）> 本机配置 > 用户主目录下的默认位置
  // 默认故意放在仓库之外，这样删掉/重新下载代码文件夹都不会碰到照片
  const userDir = userDirOverride || process.env.PHOTOTRACK_USER_DIR || path.join(os.homedir(), 'PhotoTrackData');
  const places = createPlacesStore(userDir);
  const photos = createPhotoStore(userDir);
  const state = { lastPing: 0 };
  // 每次启动生成一次性令牌，只有本服务返回的页面能拿到，防止同机其他程序/网页调用接口
  const token = crypto.randomBytes(16).toString('hex');

  /** 写日志：服务是隐藏启动的，控制台看不到，失败必须落盘才能排查 */
  async function logLine(line) {
    try {
      await fs.mkdir(userDir, { recursive: true });
      await fs.appendFile(path.join(userDir, 'server.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store'
    });
    res.end(text);
  }

  function readBody(req, limit = MAX_UPLOAD) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error('文件太大'), { code: 'TOO_LARGE' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.join(srcDir, rel);
    if (!file.startsWith(srcDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      if (rel === 'index.html') {
        // 把本次启动的令牌注入页面，别的程序拿不到
        const html = (await fs.readFile(file, 'utf8')).replace(
          '<head>',
          `<head>\n    <meta name="pt-token" content="${token}">`
        );
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-cache'
        });
        res.end(html);
        return;
      }
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  }

  async function servePhotoFile(req, res, id, kind) {
    let file;
    let type;
    try {
      if (kind === 'thumb') {
        file = photos.thumbPath(id);
        type = 'image/jpeg';
      } else {
        file = photos.filePath(id);
        type = photos.mimeOf(id);
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }

    try {
      const stat = await fs.stat(file);
      const range = req.headers.range;
      const common = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable'
      };

      // 视频需要支持分段请求，否则拖不动进度条
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          let start = match[1] ? Number(match[1]) : 0;
          let end = match[2] ? Number(match[2]) : stat.size - 1;
          if (!match[1] && match[2]) {
            start = Math.max(0, stat.size - Number(match[2]));
            end = stat.size - 1;
          }
          if (start >= stat.size || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
            return;
          }
          end = Math.min(end, stat.size - 1);
          res.writeHead(206, {
            ...common,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': end - start + 1
          });
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }

      res.writeHead(200, { ...common, 'Content-Length': stat.size });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  }

  /** 流式接收上传：先落临时文件，再按文件头判断是图片还是视频，避免大视频占内存 */
  async function receiveUpload(req, placeId) {
    const tmpDir = path.join(userDir, 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const tempPath = path.join(tmpDir, `up-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.part`);

    const head = Buffer.alloc(64);
    let headLen = 0;
    let size = 0;
    const out = createWriteStream(tempPath);

    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_MEDIA) {
            reject(Object.assign(new Error('文件过大（上限 2GB）'), { code: 'TOO_LARGE' }));
            req.destroy();
            return;
          }
          if (headLen < 64) {
            const take = Math.min(64 - headLen, chunk.length);
            chunk.copy(head, headLen, 0, take);
            headLen += take;
          }
          if (!out.write(chunk)) {
            req.pause();
            out.once('drain', () => req.resume());
          }
        });
        req.on('end', () => out.end(() => resolve()));
        req.on('error', reject);
        out.on('error', reject);
      });

      const media = detectMedia(head.subarray(0, headLen));
      if (!media) {
        await fs.rm(tempPath, { force: true });
        throw Object.assign(new Error('不支持的文件格式（支持 JPEG / PNG / WebP / GIF / MP4 / WebM / MOV）'), {
          code: 'BAD_IMAGE'
        });
      }

      return await photos.addFromFile({
        placeId,
        tempPath,
        size,
        ext: media.ext,
        kind: media.kind,
        origName: decodeURIComponent(req.headers['x-file-name'] || ''),
        width: Number(req.headers['x-width']) || 0,
        height: Number(req.headers['x-height']) || 0,
        duration: Number(req.headers['x-duration']) || 0,
        takenAt: req.headers['x-taken-at'] || null
      });
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    try {
      if (p === '/api/hello') return json(res, 200, { app: 'phototrack', version: 2 });

      // 令牌校验：除握手外，所有接口都要带本次启动的令牌
      if (p.startsWith('/api/')) {
        const provided = req.headers['x-pt-token'] || url.searchParams.get('t');
        if (provided !== token) return json(res, 403, { error: 'forbidden' });
      }

      // 跨站防护：写操作若带 Origin，必须是本服务自己的来源
      if (req.method !== 'GET' && req.headers.origin) {
        const port = req.socket.localPort;
        const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
        if (!allowed.has(req.headers.origin)) return json(res, 403, { error: 'bad origin' });
      }

      state.lastPing = Date.now();

      // ---------------- 存储位置 ----------------
      if (p === '/api/settings' && req.method === 'GET') {
        return json(res, 200, { dataDir: userDir, defaultDir: path.join(path.dirname(root), 'PhotoTrackData') });
      }

      if (p === '/api/settings/data-dir' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}');
        const target = String(body.dir || '').trim();
        if (!target) return json(res, 400, { error: '请填写目录路径' });

        const abs = path.resolve(root, target);
        if (abs === path.resolve(userDir)) return json(res, 400, { error: '和当前目录相同，无需迁移' });

        const occupied = await fs
          .access(path.join(abs, 'places.json'))
          .then(() => true)
          .catch(() => false);
        if (occupied) return json(res, 409, { error: '目标目录里已经有 PhotoTrack 数据，换一个空目录' });

        try {
          await fs.mkdir(abs, { recursive: true });
          const probe = path.join(abs, `.write-test-${Date.now()}`);
          await fs.writeFile(probe, 'ok', 'utf8');
          await fs.rm(probe, { force: true });
        } catch (err) {
          return json(res, 400, { error: `目标目录不可写：${err.message}` });
        }

        try {
          await fs.cp(userDir, abs, { recursive: true, force: false });
        } catch (err) {
          await logLine(`迁移数据失败 -> ${abs}: ${err.message}`);
          return json(res, 500, { error: `复制数据失败：${err.message}` });
        }

        await fs.writeFile(
          path.join(root, 'phototrack.local.json'),
          JSON.stringify({ dataDir: abs }, null, 2),
          'utf8'
        );
        await logLine(`数据目录已改为 ${abs}`);

        const restart = body.restart !== false;
        json(res, 200, { ok: true, dataDir: abs, restarting: restart });

        if (restart) scheduleSelfRestart();
        return;
      }

      if (p === '/api/bootstrap' && req.method === 'GET') {
        const [geo, raw] = await Promise.all([
          fs.readFile(path.join(dataDir, 'geo', 'beijing.json'), 'utf8').then(JSON.parse).catch(() => null),
          fs.readFile(path.join(dataDir, 'places', 'beijing.json'), 'utf8').then(JSON.parse).catch(() => ({ places: [] }))
        ]);
        return json(res, 200, { geo, poi: raw });
      }

      if (p === '/api/places' && req.method === 'GET') return json(res, 200, places.get());

      if (p === '/api/places' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        if (!Array.isArray(body.places)) return json(res, 400, { error: 'places 必须是数组' });
        const result = await places.save(body.places, body.baseRev);
        return json(res, 200, { ok: true, ...result });
      }

      const delPlace = /^\/api\/places\/([\w-]+)$/.exec(p);
      if (delPlace && req.method === 'DELETE') {
        const id = delPlace[1];
        const count = photos.countForPlace(id);
        if (count > 0) return json(res, 409, { error: 'has-photos', count, message: `这个地点还有 ${count} 张照片` });
        const result = await places.remove(id);
        return json(res, 200, { ok: true, ...result });
      }

      if (p === '/api/photos' && req.method === 'GET') {
        const placeId = url.searchParams.get('placeId') || undefined;
        const deleted = url.searchParams.get('deleted') === '1';
        return json(res, 200, photos.list({ placeId, deleted }));
      }

      if (p === '/api/photos/counts' && req.method === 'GET') return json(res, 200, photos.counts());
      if (p === '/api/photos/summary' && req.method === 'GET') return json(res, 200, photos.summary());

      if (p === '/api/photos' && req.method === 'POST') {
        const placeId = req.headers['x-place-id'];
        if (!placeId) return json(res, 400, { error: '缺少 x-place-id' });
        const photo = await receiveUpload(req, placeId);
        return json(res, 200, photo);
      }

      const photoAction = /^\/api\/photos\/([\w-]+)(?:\/(thumb|file|restore))?$/.exec(p);
      if (photoAction) {
        const id = photoAction[1];
        const action = photoAction[2];

        if (action === 'file' && req.method === 'GET') return servePhotoFile(req, res, id, 'file');
        if (action === 'thumb' && req.method === 'GET') return servePhotoFile(req, res, id, 'thumb');
        if (action === 'thumb' && req.method === 'POST') {
          const buffer = await readBody(req, 8 * 1024 * 1024);
          return json(res, 200, await photos.setThumb(id, buffer));
        }
        if (action === 'restore' && req.method === 'POST') return json(res, 200, await photos.restore(id));

        if (!action && req.method === 'PATCH') {
          const patch = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
          return json(res, 200, await photos.update(id, patch));
        }
        if (!action && req.method === 'DELETE') {
          const permanent = url.searchParams.get('permanent') === '1';
          if (permanent) return json(res, 200, await photos.purge(id));
          return json(res, 200, await photos.softDelete(id));
        }
      }

      if (p === '/api/ping') return json(res, 200, { ok: true });
      if (p === '/api/bye') return json(res, 200, { ok: true });

      // 供重启脚本调用：优雅退出，避免靠 netstat 找 PID
      if (p === '/api/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 120);
        return;
      }
      if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

      return await serveStatic(res, p);
    } catch (err) {
      if (err instanceof ConflictError) {
        return json(res, 409, { error: 'conflict', rev: err.current.rev, places: err.current.places });
      }
      if (err instanceof NotFoundError || err.code === 'NOT_FOUND') return json(res, 404, { error: err.message });
      if (err.code === 'BAD_IMAGE') {
        await logLine(`拒绝上传 ${req.url}: ${err.message}`);
        return json(res, 415, { error: err.message });
      }
      if (err.code === 'TOO_LARGE') {
        await logLine(`上传过大 ${req.url}: ${err.message}`);
        return json(res, 413, { error: err.message });
      }
      await logLine(`请求失败 ${req.method} ${req.url}: ${err.stack || err.message}`);
      console.error('[phototrack]', err);
      return json(res, 500, { error: err.message });
    }
  }

  const server = http.createServer(handle);

  /** 换数据目录后自我重启：先释放端口，再拉起新进程（新进程读的新配置） */
  function scheduleSelfRestart() {
    setTimeout(() => {
      server.close(() => {
        try {
          spawn(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
            detached: true,
            stdio: 'ignore',
            cwd: root
          }).unref();
        } catch (err) {
          logLine(`自动重启失败: ${err.message}`);
        }
        setTimeout(() => process.exit(0), 300);
      });
    }, 400);
  }

  return { server, stores: { places, photos }, state, userDir };
}

export function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  return candidates.find((p) => existsSync(p));
}

export function openAppWindow(port, root = ROOT) {
  const url = `http://127.0.0.1:${port}/`;
  const edge = findEdge();
  if (!edge) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return 'default-browser';
  }
  // 浏览器配置放到系统本地目录，避免把几百兆缓存混进 userdata 备份
  const profileRoot = process.env.LOCALAPPDATA || path.join(root, 'userdata');
  const profile = path.join(profileRoot, 'PhotoTrack', 'edge-profile');
  spawn(
    edge,
    [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      '--disable-features=msEdgeSidebarV2'
    ],
    { detached: true, stdio: 'ignore' }
  ).unref();
  return 'edge';
}

/** 探测已在运行的实例（避免双开写同一份数据） */
export async function probeExisting(startPort = PORT_START, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    const port = startPort + i;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/hello`, {
        signal: AbortSignal.timeout(600)
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.app === 'phototrack') return port;
    } catch {
      /* 该端口没有实例 */
    }
  }
  return null;
}

/** 解析数据目录，并把旧版仓库内的 userdata/ 一次性迁移过去 */
export async function prepareUserDir(root = ROOT) {
  if (process.env.PHOTOTRACK_USER_DIR) return process.env.PHOTOTRACK_USER_DIR;

  // 默认放在仓库的**同级目录**（<仓库>/../PhotoTrackData），
  // 这样数据既不在仓库里、也不在系统盘的用户目录下
  let dir = path.join(path.dirname(path.resolve(root)), 'PhotoTrackData');
  try {
    const raw = await fs.readFile(path.join(root, 'phototrack.local.json'), 'utf8');
    const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (cfg.dataDir) dir = path.resolve(root, cfg.dataDir);
  } catch {
    /* 没有本机配置就用默认位置 */
  }

  // 目录不可写（权限/只读盘）时退回仓库内的 userdata，别让应用起不来
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    dir = path.join(root, 'userdata');
    await fs.mkdir(dir, { recursive: true });
  }

  const exists = async (file) =>
    fs
      .access(file)
      .then(() => true)
      .catch(() => false);

  // 早期版本把数据放在仓库内 userdata/，后来的版本用过用户主目录，这里都搬一次
  const legacyDirs = [path.join(root, 'userdata'), path.join(os.homedir(), 'PhotoTrackData')];
  for (const legacy of legacyDirs) {
    if (legacy === dir) continue;
    if (await exists(path.join(dir, 'places.json'))) break;
    if (!(await exists(path.join(legacy, 'places.json')))) continue;

    await fs.cp(legacy, dir, { recursive: true, force: false });
    await fs
      .appendFile(
        path.join(dir, 'server.log'),
        `${new Date().toISOString()} 已把历史数据从 ${legacy} 迁移到 ${dir}\n`
      )
      .catch(() => {});
    break;
  }

  return dir;
}

export async function start({ port = PORT_START, open = false, root = ROOT, keepAlive = false } = {}) {
  const userDir = await prepareUserDir(root);
  const app = createApp(root, userDir);
  await app.stores.places.init();
  await app.stores.photos.init();
  // 记录数据目录位置，方便排查"照片去哪了"
  await fs
    .appendFile(path.join(app.userDir, 'server.log'), `${new Date().toISOString()} 数据目录 ${app.userDir}\n`)
    .catch(() => {});
  console.log(`数据目录：${app.userDir}`);
  // 清掉上次异常中断留下的上传临时文件
  await fs.rm(path.join(app.userDir, 'tmp'), { recursive: true, force: true }).catch(() => {});

  // 单实例：已有服务就直接连它，绝不再起第二个写数据
  // （自定义数据目录时不复用，避免测试连到真实实例上）
  const probeFrom = port > 0 ? port : PORT_START;
  const existing = process.env.PHOTOTRACK_USER_DIR ? null : await probeExisting(probeFrom);
  if (existing) {
    if (open) openAppWindow(existing, root);
    return { reused: true, port: existing, close: async () => {} };
  }

  const listenPort = await new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (candidate) => {
      app.server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          attempt += 1;
          tryListen(candidate + 1);
        } else {
          reject(err);
        }
      });
      app.server.listen(candidate, '127.0.0.1', () => resolve(candidate));
    };
    tryListen(port);
  });

  // 心跳看门狗：只有交互式启动（有窗口）时才在页面关闭后退出；
  // 开机自启模式加 --keep-alive，保持常驻，随时可以打开书签
  const watchdog = keepAlive
    ? null
    : setInterval(() => {
        if (!app.state.lastPing) return;
        if (Date.now() - app.state.lastPing > 45000) {
          clearInterval(watchdog);
          app.server.close();
          process.exit(0);
        }
      }, 10000);
  watchdog?.unref();

  if (open) openAppWindow(listenPort, root);

  return {
    reused: false,
    port: listenPort,
    close: () =>
      new Promise((resolve) => {
        if (watchdog) clearInterval(watchdog);
        app.server.close(() => resolve());
      })
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const open = process.argv.includes('--open');
  const keepAlive = process.argv.includes('--keep-alive');
  const port = Number(process.env.PHOTOTRACK_PORT) || PORT_START;
  start({ port, open, keepAlive }).then(({ port: actual, reused }) => {
    console.log(`${reused ? '已连到运行中的实例' : 'PhotoTrack 已启动'}：http://127.0.0.1:${actual}`);
  });
}
