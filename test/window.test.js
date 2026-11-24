import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockCaptcha, rig } from '../test-support/rig.js';
import { bind, failure, phone, phoneB, success } from '../test-support/commerce.js';
import { PATHS } from '../server/qmai.js';

const baseTime = Date.UTC(2026, 0, 1, 12, 0, 57);
const memberPath = 'v3/crm/customer/getCustomerIdByCode';
const valid = { codeType: 'phone', code: '13800000000' };
const callsLimited = '操作太频繁，请稍等一下再试。';
const bindsLimited = '绑定尝试太频繁，请稍后再试。';

async function withClock(t, limits, upstream) {
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
    upstream: upstream ?? (path => path === memberPath
      ? { code: 0, status: true, data: { customerId: 0 } }
      : { code: 400, status: false }),
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
  return { service, attempt, at };
}

test('BND-11/SES-08 第二步在到期前到达，排队或回执跨过到期时刻仍以企迈回执为准', async t => {
  const firstCheck = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let checks = 0;
  const {service, at} = await withClock(t, {LICHA_RATE_CALLS_PER_DEVICE_PER_MIN:'3',
    LICHA_SMS_CODE_TTL_SEC:'30', LICHA_WRITE_TIMEOUT_MS:'5000'}, async path => {
    if (path === memberPath) return {status:true, data:1234};
    if (path === PATHS.smsCheck && ++checks === 1) {
      firstCheck.resolve();
      await resume.promise;
      return {status:false};
    }
    return {status:true};
  });
  const s = await service.session();
  assert.equal((await s.call('bind_member', valid)).isError, undefined);
  await at(29999);
  const check = () => s.call('bind_member', {...valid, captcha:mockCaptcha});
  const first = check();
  await firstCheck.promise;
  const later = [check(), check()];
  try {
    // 还剩一个调用名额。收到立即限流的回包即表明另一笔已排进同设备队列。
    assert.equal((await Promise.race(later)).content[0].text, callsLimited);
    await at(31000);
    const other = await service.session();
    await other.call('my_orders'); // 到期后触发清理，已排队的校验仍能取得原待验证。
  } finally { resume.resolve(); }
  assert.equal((await first).content[0].text, '验证码不对，还可以再试 4 次。请顾客核对短信里的数字再报一次。');
  const bound = (await Promise.all(later)).find(result => !result.isError);
  assert.equal(JSON.parse(bound.content[0].text).bound, true);
  assert.equal(checks, 2);
});

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

test('SES-04/BND-15 当前号码的查单只续它自己的闲置期，失效的旧号需重新收码', async t => {
  const {service, at} = await withClock(t, {LICHA_BINDING_IDLE_TTL_MS:'10000', LICHA_SMS_COOLDOWN_SEC:'1'},
    (path, params) => {
      if (path === PATHS.member) return {status:true, data:params.customerCode.code === phone ? 1234 : 5678};
      if (path === PATHS.orderList) return {status:true, data:{data:[], total:0}};
      return {status:true};
    });
  const s = await service.session();
  const first = await bind(s);
  await at(2000);
  const second = await bind(s, phoneB);
  await at(4000);
  const back = await success(s, 'bind_member', valid);
  assert.equal(back.boundAt, first.boundAt);
  await at(6000);
  const again = await success(s, 'bind_member', {...valid, code:phoneB});
  assert.equal(again.boundAt, second.boundAt);
  await at(9000);
  assert.deepEqual((await success(s, 'my_orders')).member, second.member);
  await at(18000);
  const before = service.requests.length;
  const expired = await success(s, 'bind_member', valid);
  assert.equal(expired.verificationSent, true);
  assert.equal(expired.bound, false);
  assert.deepEqual(service.requests.slice(before).map(row => row.path), [PATHS.member, PATHS.smsSend]);
  assert.deepEqual((await success(s, 'my_orders')).member, second.member);
});

test('SES-04 QRY-07 会员查询仅查到一项也刷新绑定闲置时间', async t => {
  const {service, at} = await withClock(t, {LICHA_BINDING_IDLE_TTL_MS:'10000'}, path => {
    if (path === PATHS.member) return {status:true, data:1234};
    if (path === 'v3/crm/points/getCustomerPoints') return {status:true, data:{totalPoints:0}};
    if (path === 'v3/crm/customer/getLevelExperience') return {status:false};
    return {status:true};
  });
  const s = await service.session();
  await bind(s);
  for (const offset of [9000, 18000]) {
    await at(offset);
    assert.deepEqual((await success(s, 'my_member_info')).unavailable, ['level']);
  }
  await at(28001);
  const before = service.requests.length;
  await failure(s, 'my_member_info', {}, /尚未绑定/);
  assert.equal(service.requests.length, before);
});

test('SES-03/05/BND-15 同号在别的设备和服务重启后都要重新收码', async t => {
  const {service, at} = await withClock(t, {LICHA_SMS_COOLDOWN_SEC:'1'},
    (path, params) => path === PATHS.member
      ? {status:true, data:params.customerCode.code === phone ? 1234 : 5678} : {status:true});
  const first = await service.session();
  await bind(first);
  await bind(first, phoneB);
  await at(2000);
  const other = await service.session();
  await failure(other, 'my_orders', {}, /尚未绑定/);
  await bind(other);
  const before = service.requests.length;
  const switched = await success(first, 'bind_member', valid);
  assert.equal(switched.rebound, true);
  assert.equal(service.requests.length, before);
  await at(4000);
  await service.restart();
  const resumed = await service.session(first.device);
  await failure(resumed, 'my_orders', {}, /尚未绑定/);
  for (const code of [phone, phoneB]) {
    const before = service.requests.length;
    await bind(resumed, code);
    assert.deepEqual(service.requests.slice(before).map(row => row.path), [PATHS.member, PATHS.smsSend, PATHS.smsCheck]);
  }
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
