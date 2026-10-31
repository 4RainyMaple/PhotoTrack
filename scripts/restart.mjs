// 重启本地服务：先让旧服务自己退出，再以 --keep-alive 拉起新进程
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';

const PORT = Number(process.env.PHOTOTRACK_PORT) || 48765;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve('.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    const res = await fetch(`${BASE}/api/hello`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function gracefulShutdown() {
  const html = await (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })).text();
  const token = /name="pt-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) return false;
  const res = await fetch(`${BASE}/api/shutdown`, {
    method: 'POST',
    headers: { 'X-PT-Token': token },
    signal: AbortSignal.timeout(1500)
  }).catch(() => null);
  return Boolean(res?.ok);
}

/** 旧版本服务没有 shutdown 接口，只能找 PID 杀掉 */
function forceKill() {
  const attempts = [
    `netstat -ano | findstr :${PORT}`,
    `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -ExpandProperty OwningProcess"`
  ];

  for (const cmd of attempts) {
    try {
      const out = execSync(cmd, { encoding: 'utf8', windowsHide: true, shell: 'cmd.exe' });
      const pid = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && (/LISTENING/.test(line) || /^\d+$/.test(line)))
        .map((line) => line.split(/\s+/).pop())
        .find((value) => /^\d+$/.test(value));
      if (pid) {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true });
        console.log(`已强制结束旧服务（PID ${pid}）`);
        return true;
      }
    } catch {
      /* 换下一种方式 */
    }
  }
  return false;
}

let stopped = false;

if (await alive()) {
  stopped = await gracefulShutdown();
  if (stopped) console.log('已请求旧服务退出');
  for (let i = 0; i < 20 && (await alive()); i += 1) await sleep(200);

  if (await alive()) {
    console.log('旧服务没有响应退出请求（可能是早期版本），尝试直接结束进程');
    stopped = forceKill();
    for (let i = 0; i < 15 && (await alive()); i += 1) await sleep(200);
    if (await alive()) {
      console.error('无法停止旧服务，请手动结束占用 48765 端口的 node 进程后重试');
      process.exit(1);
    }
  }
  console.log('旧服务已停止');
} else {
  console.log('端口空闲，直接启动新服务');
}

// 临时文件由服务启动时自行清理

spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--keep-alive'], {
  detached: true,
  stdio: 'ignore',
  cwd: ROOT
}).unref();

let up = false;
for (let i = 0; i < 25 && !up; i += 1) {
  await sleep(200);
  up = await alive();
}

if (up) {
  console.log(`服务已启动：${BASE}`);
  console.log('浏览器里按 Ctrl+F5 刷新（令牌随重启变化）');
} else {
  console.error('启动失败，请检查数据目录下的 server.log');
  process.exitCode = 1;
}
