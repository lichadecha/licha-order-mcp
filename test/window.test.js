import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rig } from '../test-support/rig.js';

const baseTime = Date.UTC(2026, 0, 1, 12, 0, 57);
const memberPath = 'v3/crm/customer/getCustomerIdByCode';
const valid = { codeType: 'phone', code: '13800000000' };
const callsLimited = '操作太频繁，请稍等一下再试。';
const bindsLimited = '绑定尝试太频繁，请稍后再试。';

async function withClock(t, limits) {
  const dir = await mkdtemp(join(tmpdir(), 'licha-window-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clockFile = join(dir, 'clock');
  const preload = join(dir, 'time.mjs');
  async function at(offset) {
    await writeFile(clockFile + '.next', String(baseTime + offset));
    await rename(clockFile + '.next', clockFile);
  }
  await at(0);
  await writeFile(preload, `import { readFileSync } from 'node:fs';
Date.now = () => Number(readFileSync(${JSON.stringify(clockFile)}, 'utf8'));
`);
  // 仅替换子进程的日历时钟。套接字、上游、限流状态、真实定时器均照常运行。
  const service = await rig(t, {
    nodeArgs: ['--import', pathToFileURL(preload).href],
    env: { LICHA_SESSION_IDLE_TTL_MS: '7200000', ...limits },
    upstream: (path) => path === memberPath
      ? { code: 0, status: true, data: { customerId: 0 } }
      : { code: 400, status: false },
  });
  async function attempt(offset, session, expectedError, args = valid) {
    await at(offset);
    const before = service.requests.filter((p) => p.path === memberPath).length;
    const result = await session.call('bind_member', args);
    const after = service.requests.filter((p) => p.path === memberPath).length;
    if (expectedError) {
      assert.equal(result.isError, true);
      assert.equal(after, before);
      assert.equal(typeof result.content[0].text, 'string');
      if (typeof expectedError === 'string') assert.equal(result.content[0].text, expectedError);
      else assert.match(result.content[0].text, expectedError);
    } else {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /还不是李茶的茶会员/);
      assert.equal(after, before + 1);
    }
  }
  return { service, attempt };
}

test('SES-09 任意连续六十秒内跨会话计数，拒绝不延长窗口，另一台设备独立', async (t) => {
  const { service, attempt } = await withClock(t, { LICHA_RATE_CALLS_PER_DEVICE_PER_MIN: '2' });
  const first = await service.session();
  const same = await service.session(first.device);
  const other = await service.session();
  await attempt(0, first);
  await attempt(10_000, same); // 已跨墙钟的整分线。
  await attempt(59_999, same, callsLimited);
  await attempt(59_999, other);
  await attempt(60_000, first);
  await attempt(60_000, same, callsLimited);
  await attempt(69_999, same, callsLimited);
  await attempt(70_000, same);
});

test('BND-09 格式预检、设备一小时与全局一分钟滑窗分别计数，在边界释放', async (t) => {
  const { service, attempt } = await withClock(t, {
    LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR: '2', LICHA_RATE_BINDS_GLOBAL_PER_MIN: '2',
  });
  const a = await service.session(), b = await service.session(), c = await service.session();
  await attempt(0, a, /格式不正确/, { codeType: 'phone', code: 'FAKE' });
  await attempt(0, a);
  await attempt(1, b);
  await attempt(59_999, c, bindsLimited);
  await attempt(60_000, c);     // 全局只释放了 a 的首次。
  await attempt(60_000, a, bindsLimited);
  await attempt(60_001, a);     // 刚才的全局拒绝没有占 a 的设备额度。
  await attempt(120_001, a, bindsLimited);
  await attempt(120_001, b);    // 设备拒绝没有占全局额度。
  await attempt(120_001, c);
  await attempt(3_599_999, a, bindsLimited);
  await attempt(3_600_000, a);  // 刚好释放 a 的首次。
  await attempt(3_600_000, a, bindsLimited);
  await attempt(3_660_001, a);
});
