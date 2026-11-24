import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBindingFlow} from '../server/binding.js';
import {digest} from '../server/common.js';
import {PATHS} from '../server/qmai.js';
import {argsFor, bind, bookFile, count, failure, memberA, memberB, number, ok, phone, phoneB, place, prepare, setup, success} from '../test-support/commerce.js';
import {mockCaptcha} from '../test-support/rig.js';

const args = (code, captcha) => ({code, codeType:'phone', ...(captcha !== undefined && {captcha})});
const send = (s, code = phone) => success(s, 'bind_member', args(code));
const verify = (s, code = phone) => success(s, 'bind_member', args(code, mockCaptcha));
const denied = (s, code, captcha, message) => failure(s, 'bind_member', args(code, captcha), message);
const missing = /还没给这个手机号发过验证码/;

function sentPhoneHashes(r) {
  const db = new DatabaseSync(bookFile(r), {readOnly:true});
  try { return db.prepare('SELECT phone_hash FROM sms_sends ORDER BY rowid').all().map(row => row.phone_hash); }
  finally { db.close(); }
}

test('BND-11 工具契约、两步回执、同设备跨会话和幂等免验', async t => {
  const r = await setup(t, {LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:'1'});
  const first = await r.session(), same = await r.session(first.device), other = await r.session();
  const schema = (await first.rpc('tools/list')).tools.find(tool => tool.name === 'bind_member');
  assert.match(schema.description, /同一个手机号和 captcha/);
  assert.match(schema.description, /每个号在这台设备上验证过、且记录还有效（闲置不超过保留期、服务没重启）时，再报它就直接切过去、不用收码（出参同换绑）/);
  assert.match(schema.description, /两个号属于同一位会员时，仍按那位会员现在的绑定，不算换人/);
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
  r.mock.orders = [{userId:memberA, orderNo:number(1), orderAt:r.requests.find(req => req.path === PATHS.create).at}];
  assert.equal((await success(s, 'my_orders')).resolvedPendingWrites, 1);
  const afterReconciliation = r.requests.length;
  assert.equal((await send(s, phoneB)).rebound, true);
  assert.equal(r.requests.length, afterReconciliation);
});

test('BND-05/09/15 同会员另一号码验证后保留原绑定和订单，换人后可用该号码免验', async t => {
  const r = await setup(t, {LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:'3', LICHA_RATE_BINDS_GLOBAL_PER_MIN:'3'});
  const s = await r.session(), sameDevice = await r.session(s.device);
  const alias = '13800007777';
  const members = new Map([[phone, memberA], [alias, memberA], [phoneB, memberB]]);
  r.mock.override.set(PATHS.member, ({customerCode}) => ok({customerId:members.get(customerCode.code) ?? null}));
  const first = await bind(s);
  const draft = await prepare(s);
  const same = await bind(s, alias);
  assert.deepEqual(same.member, first.member);
  assert.equal(same.boundAt, first.boundAt);
  assert.equal(same.rebound, undefined);
  const before = r.requests.length;
  assert.deepEqual(await send(sameDevice, alias), same);
  assert.equal(r.requests.length, before);
  await place(s, draft);
  assert.equal(r.requests.find(row => row.path === PATHS.create).params.mobile, phone);
  const other = await bind(s, phoneB);
  const limitReached = r.requests.length;
  await denied(s, '13900000001', undefined, /绑定尝试太频繁/);
  const back = await send(sameDevice, alias);
  assert.equal(back.rebound, true);
  assert.deepEqual(back.previousMember, other.member);
  assert.deepEqual(back.member, {last4:'***7777', via:'phone'});
  assert.equal(r.requests.length, limitReached);
  assert.deepEqual((await success(s, 'my_orders')).member, back.member);
  await place(s, await prepare(s));
  assert.equal(r.requests.findLast(row => row.path === PATHS.create).params.mobile, alias);
});

test('BND-07/15 原会员有未决时拒绝切换到已验证号码，仍可用当前号免验', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s, phoneB);
  const first = await bind(s);
  r.mock.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  const before = r.requests.length;
  await denied(s, phoneB, undefined, /暂时不能换人/);
  const current = await send(s);
  assert.equal(current.rebound, undefined);
  assert.deepEqual(current.member, first.member);
  assert.equal(current.boundAt, first.boundAt);
  assert.equal(r.requests.length, before);
});

test('R27/BND-11/14 逐笔计数并审计错码和未知回执，超时、断线、5xx 不扣次数', async t => {
  const r = await setup(t, {LICHA_SMS_MAX_WRONG:'7'});
  const s = await r.session();
  await send(s);
  await denied(s, phone, 'abc', /验证码格式不对/);
  assert.equal(count(r, PATHS.smsCheck), 0);
  for (const failure of [res => { res.writeHead(503); res.end(); }, res => res.destroy(), () => {}]) {
    r.mock.override.set(PATHS.smsCheck, (_params, {res}) => { failure(res); });
    await denied(s, phone, mockCaptcha, /仍然有效/);
  }
  r.mock.override.set(PATHS.smsCheck, () => ({status:false}));
  assert.equal(await denied(s, phone, mockCaptcha, /验证码不对/), '验证码不对，还可以再试 6 次。请顾客核对短信里的数字再报一次。');
  const unknownReplies = [
    () => ({status:true, data:{valid:true}}), () => ({}), () => ({status:'false'}),
    (_params, {res}) => { res.end('{'); },
    (_params, {res}) => { res.writeHead(400); res.end('{"status":false}'); },
    (_params, {res}) => { res.writeHead(404); res.end('{"status":true}'); }
  ];
  for (const [index, reply] of unknownReplies.entries()) {
    r.mock.override.set(PATHS.smsCheck, reply);
    const remaining = unknownReplies.length - index - 1;
    const expected = remaining ? `这次没能确认验证码（门店系统的回复认不出来），按报错算了一次，还可以再试 ${remaining} 次。`
      : '验证码报错次数太多，这条已作废。请先只带手机号调用一次 bind_member，重新发一条。';
    assert.equal(await denied(s, phone, mockCaptcha, /验证码/), expected);
  }
  await denied(s, phone, mockCaptcha, missing);
  assert.equal(count(r, PATHS.smsCheck), 10);
  const access = (await readFile(join(r.logDir,'access.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const checks = access.filter(row => row.event === 'sms_check');
  assert.deepEqual(checks.map(row => row.outcome),
    ['request_failed','request_failed','request_failed','wrong',...unknownReplies.map(() => 'unrecognized'),'invalidated']);
  const [hash] = sentPhoneHashes(r);
  for (const row of checks) {
    assert.equal(row.deviceHash, digest(s.device));
    assert.equal(row.phoneHash, hash);
    assert.equal(row.memberHash, undefined);
  }
});

function timedBinding(t, sms) {
  t.mock.timers.enable({apis:['Date'], now:Date.UTC(2026, 0, 1)});
  const config = {QMAI_OPEN_ID:'test', QMAI_OPEN_KEY:'test', QMAI_GRANT_CODE:'test',
    LICHA_SMS_CODE_TTL_SEC:30, LICHA_SMS_COOLDOWN_SEC:60, LICHA_SESSION_IDLE_TTL_MS:1800000,
    LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:2, LICHA_RATE_BINDS_GLOBAL_PER_MIN:2};
  return createBindingFlow({config, qmai:{read:async () => ({customerId:123}), sms},
    logs:{access() {}}, book:{phoneHash:() => 'mock-phone-hash', checkSmsAllowed() {}, recordSmsSending() { return {}; }}});
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
  r.mock.override.set(PATHS.smsSend, () => ({status:false, code:mockCaptcha, message:`短信服务拒绝 ${mockCaptcha} ${phoneB}，2 分钟后再试`}));
  const refusal = await denied(s, phoneB, undefined, /短信服务拒绝/);
  assert.equal(refusal, '验证码没发出去（短信服务拒绝 *** ***，2 分钟后再试）。请稍后再试，或直接在小程序里下单。');
  output.push(refusal);
  const thirdPhone = '18811112223';
  r.mock.override.set(PATHS.member, () => ok({customerId:1234}));
  r.mock.override.set(PATHS.smsSend, (_params, {res}) => { res.end('{'); });
  const unknown = await send(s, thirdPhone);
  assert.equal(unknown.verificationSent, 'unknown');
  assert.equal(unknown.note, '验证码可能已经发出（短信服务没有回话）。请顾客看一下尾号 2223 的手机：收到了就照常报验证码；过 1 分钟 还没收到，再只带手机号调用一次重新发。');
  output.push(unknown);
  r.mock.override.set(PATHS.smsCheck, () => ({status:true}));
  output.push(await verify(s, thirdPhone));
  const before = r.requests.length;
  output.push(await send(s));
  assert.equal(r.requests.length, before);
  const files = await Promise.all(['upstream.jsonl','write.jsonl','access.jsonl'].map(file => readFile(join(r.logDir,file),'utf8')));
  const rows = files[2].trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row => row.event === 'sms_send').map(row => row.outcome),
    ['sent','rate_limited','rejected','unknown']);
  const hashes = sentPhoneHashes(r);
  assert.equal(new Set(hashes).size, 3);
  const events = rows.filter(row => row.event.startsWith('sms_') || row.reason === 'sms_exempt');
  assert.deepEqual(events.map(row => row.phoneHash),
    [hashes[0], hashes[0], hashes[0], hashes[0], hashes[1], hashes[2], hashes[2]]);
  const switches = rows.filter(row => row.reason === 'verified_switch');
  assert.equal(switches.length, 1);
  assert.equal(switches[0].phoneHash, hashes[0]);
  assert.equal(switches[0].deviceHash, digest(s.device));
  assert.equal(switches[0].memberHash, undefined);
  for (const row of events) {
    assert.equal(row.deviceHash, digest(s.device));
    assert.ok([phone, phoneB, thirdPhone].every(value => row.phoneHash !== digest(value)));
    assert.equal(row.memberHash, undefined);
  }
  const ledger = new DatabaseSync(bookFile(r), {readOnly:true});
  try {
    const {secret} = ledger.prepare('SELECT secret FROM sms_key').get();
    assert.ok(!JSON.stringify(output).includes(secret));
    assert.ok(files.every(file => !file.includes(secret)));
  } finally { ledger.close(); }
  const db = await readFile(bookFile(r));
  for (const secret of [phone, phoneB, thirdPhone, mockCaptcha]) {
    assert.ok(!JSON.stringify(output).includes(secret));
    assert.ok(files.every(file => !file.includes(secret)));
    assert.ok(!db.includes(secret));
  }
});

test('BND-11 发码时已过期不建待验证，准时送验后超时按请求失败，下一次重新判断到期', async t => {
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
  await assert.rejects(flow.bind(args(phone, mockCaptcha),'device'), /验证码暂时没校验成功/);
  await assert.rejects(flow.bind(args(phone, mockCaptcha),'device'), /验证码已过期/);
  await assert.rejects(flow.bind(args(phone, mockCaptcha),'device'), missing);
});
