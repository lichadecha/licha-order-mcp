import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS } from '../server/qmai.js';
import { bind, failure, ok, phone, phoneB, setup, success } from '../test-support/commerce.js';
import { mockCaptcha } from '../test-support/rig.js';

const start = Date.parse('2031-02-07T13:05:00+08:00');
const brakeMessage = '验证短信暂时停发了（系统检测到短时间内异常，自动暂停），请过一阵再试（最长约 2 分钟），或直接在小程序里下单。';
const args = code => ({ codeType: 'phone', code });
const send = (s, code) => success(s, 'bind_member', args(code));
const verify = (s, code) => success(s, 'bind_member', { ...args(code), captcha: mockCaptcha });

async function setupBrake(t) {
  const dir = await mkdtemp(join(tmpdir(), 'licha-sms-clock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'time');
  async function at(offsetMs) {
    await writeFile(clock + '.next', String(start + offsetMs));
    await rename(clock + '.next', clock);
  }
  await at(0);
  const preload = `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`;
  const r = await setup(t, {
    NODE_OPTIONS: '--import=data:text/javascript;base64,' + Buffer.from(preload).toString('base64'),
    LICHA_SMS_CODE_TTL_SEC: '30', LICHA_SMS_BRAKE_WINDOW_SEC: '61',
    LICHA_SMS_BRAKE_MIN_SAMPLE: '1', LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT: '50'
  });
  return { r, at };
}

async function audit(r) {
  return (await readFile(join(r.logDir, 'access.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
}

async function blocked(r, s, code) {
  const before = r.requests.length;
  const message = await failure(s, 'bind_member', args(code), /验证短信暂时停发了/);
  assert.equal(message, brakeMessage);
  assert.equal(r.requests.length, before);
}

test('BND-11/12 重启保留同号逐笔回填；明确拒绝、结果不明均进入刹车分母和未填数', async t => {
  const { r, at } = await setupBrake(t);
  const first = await r.session(), second = await r.session();
  await send(first, phone);
  await at(1000);
  r.mock.override.set(PATHS.smsSend, () => ({}));
  assert.equal((await send(second, phone)).verificationSent, 'unknown');
  // 同号第二条已写入，第一台设备现在报的是第一条的验证码。
  assert.equal((await verify(first, phone)).bound, true);
  await at(2000);
  r.mock.override.set(PATHS.smsSend, () => ({ status: false, message: '渠道拒绝' }));
  await failure(second, 'bind_member', args(phoneB), /验证码没发出去/);
  r.mock.override.delete(PATHS.smsSend);

  await at(30_000);
  await r.restart();
  const resumed = await r.session(first.device);
  // 仅第一条已过期。若回填写在最新的同号记录上，重启后此请求会被刹车。
  assert.equal((await send(resumed, phoneB)).verificationSent, true);
  await at(32_000);
  await blocked(r, resumed, phone);
  const [alert] = (await audit(r)).filter(row => row.event === 'sms_brake_engaged');
  assert.equal(alert.expiredCount, 3);
  assert.equal(alert.unfilledCount, 2);
});

test('BND-11/12/15 刹车拦下新发码时仍能验证有效短信、切换回已验证号码', async t => {
  const { r, at } = await setupBrake(t);
  const switching = await r.session(), pending = await r.session();
  await send(pending, phoneB);
  await at(1000);
  const original = await bind(switching, phone);
  await bind(switching, phoneB);
  await at(2000);
  await send(pending, phone);

  await at(30_000);
  await blocked(r, pending, phoneB);
  const before = r.requests.length;
  assert.equal((await verify(pending, phone)).bound, true);
  const back = await send(switching, phone);
  assert.equal(back.rebound, true);
  assert.deepEqual(back.member, original.member);
  assert.deepEqual(r.requests.slice(before).map(req => req.path), [PATHS.smsCheck]);
});

test('BND-12/14 持续刹车每次拒绝留痕，恢复后再次刹车及服务重启均重记首拒审计', async t => {
  const { r, at } = await setupBrake(t);
  const s = await r.session();
  await send(s, phone);
  await at(30_000);
  await blocked(r, s, phoneB);
  await blocked(r, s, phoneB);
  assert.equal((await audit(r)).filter(row => row.event === 'sms_brake_engaged').length, 1);
  await at(61_001);
  assert.equal((await send(s, phoneB)).verificationSent, true);
  await at(91_001);
  await blocked(r, s, phone);
  await blocked(r, s, phone);
  assert.equal((await audit(r)).filter(row => row.event === 'sms_brake_engaged').length, 2);
  await r.restart();
  const resumed = await r.session();
  await blocked(r, resumed, phone);
  await blocked(r, resumed, phone);

  const rows = await audit(r);
  const alerts = rows.filter(row => row.event === 'sms_brake_engaged');
  assert.deepEqual(alerts.map(row => [row.expiredCount, row.unfilledCount]), [[1, 1], [1, 1], [1, 1]]);
  const refusals = rows.filter(row => row.event === 'sms_send' && row.outcome === 'rate_limited');
  assert.equal(refusals.length, 6);
  assert.ok(refusals.every(row => row.tier === 'brake' && row.tiers.includes('brake')));
});

test('BND-12 查会员期间已有短信到期触发刹车，落账复核拦住发送并记录首拒', async t => {
  const { r, at } = await setupBrake(t);
  const s = await r.session();
  await send(s, phone);
  r.mock.override.set(PATHS.member, async () => {
    await at(30_000);
    return ok({ customerId: 123 });
  });
  const before = r.requests.length;
  const message = await failure(s, 'bind_member', args(phoneB), /验证短信暂时停发了/);
  assert.equal(message, brakeMessage);
  assert.deepEqual(r.requests.slice(before).map(req => req.path), [PATHS.member]);
  await blocked(r, s, phoneB);
  const alerts = (await audit(r)).filter(row => row.event === 'sms_brake_engaged');
  assert.deepEqual(alerts.map(row => [row.expiredCount, row.unfilledCount]), [[1, 1]]);
});
