import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from '../server/common.js';
import {PATHS} from '../server/qmai.js';
import {argsFor, bookFile, count, failure, ok, phone, phoneB, prepare, setup, success} from '../test-support/commerce.js';
import {mockCaptcha} from '../test-support/rig.js';

const args = {codeType:'phone', code:phone};
const verify = {...args, captcha:mockCaptcha};
const start = Date.parse('2031-02-07T13:05:00+08:00');
function fixedClock(time) {
  return '--import=data:text/javascript;base64,' + Buffer.from('Date.now=()=>' + time).toString('base64');
}

async function accessRows(r) {
  return (await readFile(join(r.logDir, 'access.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
}

for (const [reason, elapsed, hour, day, tier, message] of [
  ['同号冷却中', 0, '5', '10', 'cooldown', /请 60 秒后再试/],
  ['已达每小时上限', 60_000, '1', '10', 'hour', /请约 59 分钟后再试/],
  ['已达每天上限', 3600_000, '1', '1', 'day', /请明天再试/]
]) {
  test('BND-11/12 ' + reason + '，拒绝绑定第一步且上游请求为零', async t => {
    const r = await setup(t, {NODE_OPTIONS:fixedClock(start), LICHA_SMS_COOLDOWN_SEC:'60',
      LICHA_SMS_PER_PHONE_PER_HOUR:hour, LICHA_SMS_PER_PHONE_PER_DAY:day});
    const first = await success(await r.session(), 'bind_member', args);
    assert.equal(first.verificationSent, true);
    assert.deepEqual(r.requests.map(req => req.path), [PATHS.member, PATHS.smsSend]);
    r.env.NODE_OPTIONS = fixedClock(start + elapsed);
    await r.restart();
    const before = r.requests.length;
    await failure(await r.session(), 'bind_member', args, message);
    assert.equal(r.requests.length - before, 0);
    assert.equal((await accessRows(r)).find(row => row.outcome === 'rate_limited').tier, tier);
  });
}

test('BND-11/12 账本故障时拒绝绑定第一步，上游请求为零', async t => {
  const r = await setup(t);
  await r.stop();
  const db = new DatabaseSync(bookFile(r));
  try { db.exec('DROP TABLE sms_sends'); } finally { db.close(); }
  await r.start();
  await failure(await r.session(), 'bind_member', args, /安全账本不可用，暂时不能发验证码/);
  assert.equal(r.requests.length, 0);
});

test('BND-11/12/14 两个号码竞争最后一条全服务日额，首拒审计跨重启去重、北京零点重开', async t => {
  const midnight = Date.parse('2031-02-08T00:00:00+08:00');
  const r = await setup(t, {NODE_OPTIONS:fixedClock(midnight - 1), LICHA_SMS_GLOBAL_PER_DAY:'1'});
  const sessions = await Promise.all([r.session(), r.session()]);
  const numbers = [phone, phoneB];
  const bothMembers = Promise.withResolvers();
  r.mock.override.set(PATHS.member, async () => {
    if (count(r, PATHS.member) === 2) bothMembers.resolve();
    await bothMembers.promise;
    return ok({customerId:123});
  });
  const responses = await Promise.all(sessions.map((s,i) => s.call('bind_member', {...args, code:numbers[i]})));
  assert.equal(count(r, PATHS.member), 2);
  assert.equal(count(r, PATHS.smsSend), 1);
  const denied = responses.findIndex(response => response.isError);
  const daily = '今天的验证短信已经发完了，明天再来绑定，或直接在小程序里下单。';
  assert.notEqual(denied, -1);
  assert.equal(responses[denied].content[0].text, daily);
  assert.equal(JSON.parse(responses[1 - denied].content[0].text).verificationSent, true);
  const blockedArgs = {...args, code:numbers[denied]};
  const blocked = /今天的验证短信已经发完了/;
  const before = r.requests.length;
  await failure(sessions[denied], 'bind_member', blockedArgs, blocked);
  await r.restart();
  await failure(await r.session(), 'bind_member', blockedArgs, blocked);
  assert.equal(r.requests.length, before);

  r.env.NODE_OPTIONS = fixedClock(midnight);
  await r.restart();
  const nextDay = await r.session();
  assert.equal((await success(nextDay, 'bind_member', blockedArgs)).verificationSent, true);
  const nextBefore = r.requests.length;
  await failure(nextDay, 'bind_member', {...args, code:'13900000002'}, blocked);
  assert.equal(r.requests.length, nextBefore);
  const rows = await accessRows(r);
  assert.deepEqual(rows.filter(row => row.event === 'sms_global_day_exhausted').map(row => row.time.slice(0, 10)),
    ['2031-02-07', '2031-02-08']);
  const refusals = rows.filter(row => row.event === 'sms_send' && row.outcome === 'rate_limited');
  assert.equal(refusals.length, 4);
  assert.ok(refusals.every(row => row.tier === 'global_day' && row.tiers.includes('global_day')));
});

test('SES-05 重启清除绑定、确认令牌和绑定查询限流，已记账的短信仍在冷却', async t => {
  const r = await setup(t, {NODE_OPTIONS:fixedClock(start), LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:'1',
    LICHA_RATE_BINDS_GLOBAL_PER_MIN:'1'});
  const s = await r.session();
  r.mock.override.set(PATHS.member, () => ok({customerId:123}));
  await success(s, 'bind_member', args);
  await success(s, 'bind_member', verify);
  const draft = await prepare(s);
  await failure(s, 'bind_member', {...args, code:phoneB}, /绑定尝试太频繁/);
  await r.restart();
  const resumed = await r.session(s.device);
  await failure(resumed, 'my_orders', {}, /尚未绑定/);
  await failure(resumed, 'bind_member', verify, /还没给这个手机号发过验证码/);
  await failure(resumed, 'bind_member', args, /验证码发得太频繁/);
  assert.equal((await success(resumed, 'bind_member', {...args, code:phoneB})).verificationSent, true);
  await success(resumed, 'bind_member', {...verify, code:phoneB});
  await failure(resumed, 'place_order', argsFor(draft), /确认令牌无效/);
  assert.equal(count(r, PATHS.create), 0);
  assert.equal(count(r, PATHS.member), 2);
});

for (const outcome of ['发出', '拒绝', '结果不明']) {
  test('BND-12/13 ' + outcome + '均跨设备计入发码上限；重启清除待验证并保留限频', async t => {
    const daily = outcome === '结果不明';
    const r = await setup(t, {NODE_OPTIONS:fixedClock(start), LICHA_SMS_COOLDOWN_SEC:'60',
      LICHA_SMS_PER_PHONE_PER_HOUR:daily ? '5' : '1', LICHA_SMS_PER_PHONE_PER_DAY:daily ? '1' : '10'});
    const first = await r.session();
    const other = await r.session();
    if (outcome === '拒绝') {
      r.mock.override.set(PATHS.smsSend, () => ({status:false, message:'渠道未开通'}));
      await failure(first, 'bind_member', args, /验证码没发出去/);
      await failure(first, 'bind_member', verify, /还没给这个手机号发过验证码/);
    } else {
      if (outcome === '结果不明') r.mock.override.set(PATHS.smsSend, () => ({}));
      const sent = await success(first, 'bind_member', args);
      assert.equal(sent.bound, false);
      assert.equal(sent.verificationSent, outcome === '发出' ? true : 'unknown');
      await failure(first, 'bind_member', {...args, captcha:'abc'}, /验证码格式不对/);
      await failure(other, 'bind_member', verify, /还没给这个手机号发过验证码/);
    }
    await failure(other, 'bind_member', args, daily ? /请明天再试/ : /请约 60 分钟后再试/);
    assert.equal(count(r, PATHS.smsSend), 1);
    r.env.NODE_OPTIONS = fixedClock(start + 60_000);
    await r.restart();
    const resumed = await r.session(first.device);
    await failure(resumed, 'bind_member', verify, /还没给这个手机号发过验证码/);
    await failure(resumed, 'bind_member', args, daily ? /请明天再试/ : /请约 59 分钟后再试/);
    assert.equal(count(r, PATHS.smsSend), 1);
    assert.equal(count(r, PATHS.smsCheck), 0);
  });
}

test('BND-12 两台设备并发给同一号发码仅放行一条，模拟企迈收件时账本已提交', async t => {
  const r = await setup(t, {LICHA_SMS_COOLDOWN_SEC:'60'});
  const sessions = await Promise.all([r.session(), r.session()]);
  let persisted = [];
  r.mock.override.set(PATHS.smsSend, () => {
    const db = new DatabaseSync(bookFile(r), {readOnly:true});
    try {
      persisted = db.prepare('SELECT phone_hash FROM sms_sends').all().map(row => row.phone_hash);
    } finally { db.close(); }
    return {status:true};
  });
  const responses = await Promise.all(sessions.map(s => s.call('bind_member', args)));
  const allowed = responses.filter(response => !response.isError);
  const refused = responses.filter(response => response.isError);
  assert.equal(allowed.length, 1);
  assert.equal(JSON.parse(allowed[0].content[0].text).verificationSent, true);
  assert.equal(refused.length, 1);
  assert.match(refused[0].content[0].text, /验证码发得太频繁/);
  assert.equal(count(r, PATHS.smsSend), 1);
  assert.equal(persisted.length, 1);
  assert.notEqual(persisted[0], digest(phone));
  const smsRows = (await accessRows(r)).filter(row => row.event === 'sms_send');
  assert.deepEqual(smsRows.map(row => row.phoneHash), [persisted[0], persisted[0]]);
});

test('LED-02/BND-12 运行中写入失败或重启发现发码表缺失，bind_member 均不发送短信', async t => {
  const r = await setup(t);
  const s = await r.session();
  const db = new DatabaseSync(bookFile(r));
  try {
    db.exec(`CREATE TRIGGER sms_write_failure BEFORE INSERT ON sms_sends
      BEGIN SELECT RAISE(ABORT, 'write failed'); END`);
    await failure(s, 'bind_member', args, /安全账本不可用，暂时不能发验证码/);
    db.exec('DROP TRIGGER sms_write_failure');
    await failure(s, 'bind_member', args, /安全账本不可用，暂时不能发验证码/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sms_sends').get().n, 0);
    await r.stop();
    db.exec('DROP TABLE sms_sends');
  } finally { db.close(); }
  await r.start();
  await failure(await r.session(), 'bind_member', args, /安全账本不可用，暂时不能发验证码/);
  assert.equal(count(r, PATHS.smsSend), 0);
  assert.equal(count(r, PATHS.smsCheck), 0);
});
