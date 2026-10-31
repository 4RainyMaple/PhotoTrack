// 测试专用：拉起一个独立端口、独立数据目录的服务，跑完就关，绝不动真实 userdata
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

/** 从首页里取出本次启动的接口令牌 */
export async function fetchToken(base) {
  const html = await (await fetch(`${base}/`)).text();
  return /name="pt-token" content="([^"]+)"/.exec(html)?.[1] ?? '';
}

export async function startTestServer({ port, dir = '.test-data' } = {}) {
  const userDir = path.resolve(dir);
  await fs.rm(userDir, { recursive: true, force: true });

  const child = spawn(process.execPath, [path.resolve('server.mjs')], {
    env: { ...process.env, PHOTOTRACK_USER_DIR: userDir, PHOTOTRACK_PORT: String(port) },
    stdio: 'ignore'
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    try {
      const res = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(400) });
      ready = res.ok;
    } catch {
      /* 还没起来 */
    }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    child.kill();
    throw new Error(`测试服务未能在 ${base} 启动`);
  }

  return {
    base,
    port,
    dir: userDir,
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
        setTimeout(resolve, 1500);
      });
      await fs.rm(userDir, { recursive: true, force: true });
    }
  };
}
