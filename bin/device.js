import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function deviceId(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'device-id');
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (handle) {
    const value = randomUUID();
    try {
      await handle.writeFile(value + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return value;
  }

  // 独占创建先于文件内容可见。竞争者等到同一个完整 UUID 出现才开始握手。
  const deadline = Date.now() + 3000;
  while (true) {
    const value = (await readFile(target, 'utf8')).trim();
    if (uuidV4.test(value)) {
      if (process.platform !== 'win32') {
        try { await chmod(target, 0o600); }
        catch (error) {
          if (!['ENOTSUP','EOPNOTSUPP','ENOSYS'].includes(error.code)) throw error;
        }
      }
      return value;
    }
    if (value.length >= 36 || Date.now() >= deadline) throw new Error('设备 ID 文件不完整。');
    await wait(25);
  }
}
