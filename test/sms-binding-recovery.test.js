import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../server/common.js';
import {PATHS} from '../server/qmai.js';
import {bookFile, count, failure, phone, setup, success} from '../test-support/commerce.js';
import {mockCaptcha} from '../test-support/rig.js';

const args = {codeType:'phone', code:phone};
const verify = {...args, captcha:mockCaptcha};
const start = Date.parse('2031-02-07T13:05:00+08:00');
function fixedClock(time) {
  return '--import=data:text/javascript;base64,' + Buffer.from('Date.now=()=>' + time).toString('base64');
}

for (const outcome of ['发出', '拒绝', '结果不明']) {
  test('BND-12/13 ' + outcome + '均跨设备计入发码上限；重启清除待验证并保留限频', async t => {
    const daily = outcome === '结果不明';
    const r = await setup(t, {NODE_OPTIONS:fixedClock(start), LICHA_SMS_COOLDOWN_SEC:'60',
      LICHA_SMS_PER_PHONE_PER_HOUR:daily ? '5' : '1', LICHA_SMS_PER_PHONE_PER_DAY:'1'});
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
    await failure(other, 'bind_member', args, /请 60 秒后再试/);
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
  assert.deepEqual(persisted, [digest(phone)]);
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
