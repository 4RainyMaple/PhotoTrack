// 地点存储：版本号防并发覆盖 + 坏文件自动留证与备份恢复
import fs from 'node:fs/promises';
import path from 'node:path';

export class ConflictError extends Error {
  constructor(current) {
    super('版本冲突');
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.current = current;
  }
}

export function createPlacesStore(userDir) {
  const file = path.join(userDir, 'places.json');
  const backup = path.join(userDir, 'places.json.bak');
  let state = { places: [], rev: 0 };
  let chain = Promise.resolve();

  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function readJsonFile(target) {
    const raw = await fs.readFile(target, 'utf8').catch(() => null);
    if (raw === null) return null;
    return JSON.parse(raw); // 解析失败由调用方处理
  }

  async function writeAtomic() {
    await fs.mkdir(userDir, { recursive: true });
    const payload = {
      version: 1,
      rev: state.rev,
      places: state.places,
      savedAt: new Date().toISOString()
    };
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    // 保留上一份成功写入的内容，供损坏时恢复
    await fs.copyFile(file, backup).catch(() => {});
    await fs.rename(tmp, file);
  }

  return {
    async init() {
      try {
        const data = await readJsonFile(file);
        if (data) {
          state = {
            places: Array.isArray(data.places) ? data.places : [],
            rev: Number(data.rev) || 0
          };
        }
      } catch {
        // 主文件损坏：先改名留证，再尝试从备份恢复
        const broken = path.join(userDir, `places.broken-${Date.now()}.json`);
        await fs.rename(file, broken).catch(() => {});
        try {
          const data = await readJsonFile(backup);
          if (data) {
            state = {
              places: Array.isArray(data.places) ? data.places : [],
              rev: (Number(data.rev) || 0) + 1
            };
            await writeAtomic();
            return { recovered: 'backup', broken };
          }
        } catch {
          /* 备份也坏，只能从空开始 */
        }
        state = { places: [], rev: 0 };
        return { recovered: 'empty', broken };
      }
      return { recovered: null };
    },

    get() {
      return { places: state.places, rev: state.rev };
    },

    save(places, baseRev) {
      return exclusive(async () => {
        if (baseRev !== undefined && Number(baseRev) !== state.rev) {
          throw new ConflictError({ places: state.places, rev: state.rev });
        }
        state = { places, rev: state.rev + 1 };
        await writeAtomic();
        return { rev: state.rev };
      });
    },

    /** 删除地点；有照片时由调用方先判断 */
    remove(id) {
      return exclusive(async () => {
        const next = state.places.filter((p) => p.id !== id);
        if (next.length === state.places.length) return { removed: false, rev: state.rev };
        state = { places: next, rev: state.rev + 1 };
        await writeAtomic();
        return { removed: true, rev: state.rev };
      });
    }
  };
}
