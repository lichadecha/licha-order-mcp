import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createBindingFlow} from '../server/binding.js';
import {digest} from '../server/common.js';
import {PATHS} from '../server/qmai.js';
import {argsFor, bind, bookFile, count, failure, ok, phone, phoneB, place, prepare, setup, success} from '../test-support/commerce.js';
import {mockCaptcha} from '../test-support/rig.js';

const args = (code, captcha) => ({code, codeType:'phone', ...(captcha !== undefined && {captcha})});
const send = (s, code = phone) => success(s, 'bind_member', args(code));
const verify = (s, code = phone) => success(s, 'bind_member', args(code, mockCaptcha));
const denied = (s, code, captcha, message) => failure(s, 'bind_member', args(code, captcha), message);
const missing = /还没给这个手机号发过验证码/;

test('BND-11 工具契约、两步回执、同设备跨会话和幂等免验', async t => {
  const r = await setup(t, {LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:'1'});
  const first = await r.session(), same = await r.session(first.device), other = await r.session();
  const schema = (await first.rpc('tools/list')).tools.find(tool => tool.name === 'bind_member');
  assert.match(schema.description, /同一个手机号和 captcha/);
  assert.deepEqual(schema.inputSchema.properties.captcha, {type:'string', minLength:1, maxLength:16});
  for (const malformed of [123456, '', '1'.repeat(17)]) {
    await denied(first, phone, malformed, /参数/);
  }
  assert.equal(r.requests.length, 0);
  assert.deepEqual(await send(first, '138 0000 0000'), {bound:false, verificationSent:true, phoneLast4:'***0000',
    expiresInMinutes:5, note:'验证码已发到尾号 0000 的手机，5 分钟内有效。请顾客把短信里的数字告诉你，再调用一次 bind_member，带上同一个手机号和 captcha。'});
  await failure(same, 'my_orders', {}, /尚未绑定/);
  await denied(other, phone, mockCaptcha, missing);
  await denied(same, phoneB, mockCaptcha, missing);
  const formatted = mockCaptcha.split('').join(' ');
  const bound = await success(same, 'bind_member', args(phone, formatted));
  assert.equal(bound.bound, true);
  assert.deepEqual(bound.member, {last4:'***0000',via:'phone'});
  const exempt = await send(first);
  assert.equal(exempt.boundAt, bound.boundAt);
  assert.equal(exempt.rebound, undefined);
  await denied(first, phone, mockCaptcha, missing);
  assert.deepEqual(r.requests.map(r => r.path), [PATHS.member, PATHS.smsSend, PATHS.smsCheck]);
  const request = r.requests[1].params, check = r.requests[2].params;
  assert.match(request.bizId, /^[a-zA-Z0-9-]{1,36}$/);
  assert.deepEqual(check, {bizId:request.bizId, phone, captcha:mockCaptcha});
});

test('BND-01/02/03/09 拒绝标识、查询失败与查询限流均不发码', async t => {
  const r = await setup(t, {LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:'2'});
  const s = await r.session();
  for (const codeType of ['card','dynamic_code']) {
    await failure(s, 'bind_member', {code:phone, codeType, captcha:mockCaptcha}, /目前只支持用注册会员的手机号绑定/);
  }
  await denied(s, 'Te st', undefined, /格式不正确/);
  assert.equal(r.requests.length, 0);
  r.mock.override.set(PATHS.member, () => ok({customerId:'0'}));
  await denied(s, phone, undefined, /还不是李茶的茶会员/);
  r.mock.override.set(PATHS.member, () => ({status:false}));
  await denied(s, phone, undefined, /查询会员信息时出了点问题/);
  await denied(s, phone, undefined, /绑定尝试太频繁/);
  await denied(s, phone, mockCaptcha, missing);
  assert.deepEqual(r.requests.map(r => r.path), [PATHS.member, PATHS.member]);
});

test('BND-11 同设备的新待验证替换旧笔，第二步才更换会员和作废待确认单', async t => {
  const r = await setup(t);
  const s = await r.session();
  await send(s);
  await send(s, phoneB);
  const sends = r.requests.filter(r => r.path === PATHS.smsSend);
  assert.notEqual(sends[0].params.bizId, sends[1].params.bizId);
  await denied(s, phone, mockCaptcha, missing);
  const first = await verify(s, phoneB);
  assert.equal(first.member.last4, '***8888');
  await prepare(s);
  // 另一个号码对应会员 A，避免前次给 A 发码的冷却影响换绑。
  const newPhone = '13899997777';
  r.mock.override.set(PATHS.member, () => ok({customerId:'9000000000000001234'}));
  await send(s, newPhone);
  assert.deepEqual((await success(s, 'my_orders')).member, first.member);
  const rebound = await verify(s, newPhone);
  assert.equal(rebound.rebound, true);
  assert.equal(rebound.discardedPendingOrders, 1);
  assert.deepEqual(rebound.previousMember, first.member);
});

test('BND-07/11 发码后原会员新增未决，校验通过也拒绝换人并消耗待验证', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s);
  await send(s, phoneB);
  const draft = await prepare(s);
  r.mock.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(draft), /结果未知/);
  await denied(s, phoneB, mockCaptcha, /暂时不能换人/);
  assert.equal(count(r, PATHS.smsCheck), 2);
  const before = r.requests.length;
  await denied(s, phoneB, mockCaptcha, missing);
  await denied(s, phoneB, undefined, /暂时不能换人/);
  assert.equal((await send(s)).bound, true);
  assert.equal(r.requests.length, before);
});

test('BND-11/14 未完成的校验不扣次数，错误与认不出的 data 都扣次并可作废', async t => {
  const r = await setup(t, {LICHA_SMS_MAX_WRONG:'2'});
  const s = await r.session();
  await send(s);
  await denied(s, phone, 'abc', /验证码格式不对/);
  assert.equal(count(r, PATHS.smsCheck), 0);
  r.mock.override.set(PATHS.smsCheck, (_params, {res}) => { res.statusCode = 503; res.end(); });
  await denied(s, phone, mockCaptcha, /仍然有效/);
  r.mock.override.set(PATHS.smsCheck, () => ({status:false}));
  await denied(s, phone, mockCaptcha, /还可以再试 1 次/);
  r.mock.override.set(PATHS.smsCheck, () => ({status:true, data:{valid:true}}));
  await denied(s, phone, mockCaptcha, /次数太多，这条已作废/);
  await denied(s, phone, mockCaptcha, missing);
  assert.equal(count(r, PATHS.smsCheck), 3);
  const access = (await readFile(join(r.logDir,'access.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const checks = access.filter(row => row.event === 'sms_check');
  assert.deepEqual(checks.map(row => row.outcome), ['request_failed','wrong','wrong','invalidated']);
  for (const row of checks) {
    assert.equal(row.deviceHash, digest(s.device));
    assert.equal(row.phoneHash, digest(phone));
    assert.equal(row.memberHash, undefined);
  }
});

function timedBinding(t, sms) {
  t.mock.timers.enable({apis:['Date'], now:Date.UTC(2026, 0, 1)});
  const config = {QMAI_OPEN_ID:'test', QMAI_OPEN_KEY:'test', QMAI_GRANT_CODE:'test',
    LICHA_SMS_CODE_TTL_SEC:30, LICHA_SMS_COOLDOWN_SEC:60, LICHA_SESSION_IDLE_TTL_MS:1800000,
    LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:2, LICHA_RATE_BINDS_GLOBAL_PER_MIN:2};
  return createBindingFlow({config, bindings:new Map(), qmai:{read:async () => ({customerId:123}), sms},
    logs:{access() {}}, book:{checkSmsAllowed() {}, recordSmsSending() { return {}; }}});
}

test('BND-11 发码结果不明时按秒告知重发时间', async t => {
  const r = await setup(t, {LICHA_SMS_COOLDOWN_SEC:'1'});
  r.mock.override.set(PATHS.smsSend, () => ({}));
  const receipt = await send(await r.session());
  assert.equal(receipt.verificationSent, 'unknown');
  assert.equal(receipt.note, '验证码可能已经发出（短信服务没有回话）。请顾客看一下尾号 0000 的手机：收到了就照常报验证码；过 1 秒 还没收到，再只带手机号调用一次重新发。');
});

test('BND-11 验证码在有效期边界作废，过期提示优先于格式预检', async t => {
  const flow = timedBinding(t, async (path, _, {beforeSend}) => {
    assert.equal(path, PATHS.smsSend);
    beforeSend({});
  });
  assert.equal((await flow.bind(args(phone),'device')).expiresInMinutes, 0.5);
  t.mock.timers.tick(30000);
  flow.sweep(Date.now());
  await assert.rejects(flow.bind(args(phone, 'abc'),'device'), /已过期（有效期 0.5 分钟）/);
  await assert.rejects(flow.bind(args(phone, mockCaptcha),'device'), missing);
});

test('BND-13/14 真实工具回包、三本日志及账本不暴露手机号和验证码，审计可按摘要关联', async t => {
  const r = await setup(t, {LICHA_SMS_COOLDOWN_SEC:'60'});
  const s = await r.session();
  const output = [await send(s), await denied(s, phone, undefined, /太频繁/), await verify(s), await send(s)];
  const draft = await prepare(s);
  output.push(await place(s, draft));
  r.mock.override.set(PATHS.smsSend, () => ({status:false, code:mockCaptcha, message:`短信服务拒绝 ${mockCaptcha} ${phoneB}`}));
  output.push(await denied(s, phoneB, undefined, /短信服务拒绝/));
  const thirdPhone = '18811112223';
  r.mock.override.set(PATHS.member, () => ok({customerId:1234}));
  r.mock.override.set(PATHS.smsSend, (_params, {res}) => { res.end('{'); });
  const unknown = await send(s, thirdPhone);
  assert.equal(unknown.verificationSent, 'unknown');
  assert.equal(unknown.note, '验证码可能已经发出（短信服务没有回话）。请顾客看一下尾号 2223 的手机：收到了就照常报验证码；过 1 分钟 还没收到，再只带手机号调用一次重新发。');
  output.push(unknown);
  r.mock.override.set(PATHS.smsCheck, () => ({status:true}));
  output.push(await verify(s, thirdPhone));
  const files = await Promise.all(['upstream.jsonl','write.jsonl','access.jsonl'].map(file => readFile(join(r.logDir,file),'utf8')));
  const rows = files[2].trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row => row.event === 'sms_send').map(row => row.outcome),
    ['sent','rate_limited','rejected','unknown']);
  for (const row of rows.filter(row => row.event.startsWith('sms_') || row.reason === 'sms_exempt')) {
    assert.equal(row.deviceHash, digest(s.device));
    assert.ok([phone, phoneB, thirdPhone].some(value => row.phoneHash === digest(value)));
    assert.equal(row.memberHash, undefined);
  }
  const db = await readFile(bookFile(r));
  for (const secret of [phone, phoneB, thirdPhone, mockCaptcha]) {
    assert.ok(!JSON.stringify(output).includes(secret));
    assert.ok(files.every(file => !file.includes(secret)));
    assert.ok(!db.includes(secret));
  }
});

test('BND-11 发码回执或校验故障等到有效期结束，不再提示验证码可用', async t => {
  let slowSend = true;
  const flow = timedBinding(t, async (path, _, opts) => {
    if (path === PATHS.smsSend) {
      opts.beforeSend({});
      if (slowSend) t.mock.timers.tick(31_000);
      return true;
    }
    t.mock.timers.tick(31_000);
    throw Error('模拟超时');
  });
  await assert.rejects(flow.bind(args(phone),'device'), /验证码已过期/);
  await assert.rejects(flow.bind(args(phone, mockCaptcha),'device'), missing);
  slowSend = false;
  assert.equal((await flow.bind(args(phone),'device')).verificationSent, true);
  await assert.rejects(flow.bind(args(phone, mockCaptcha),'device'), /验证码已过期/);
  await assert.rejects(flow.bind(args(phone, mockCaptcha),'device'), missing);
});
