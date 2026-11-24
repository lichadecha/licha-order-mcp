import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {readConfig} from '../server/config.js';
import {Ledger} from '../server/ledger.js';
import {Qmai, PATHS} from '../server/qmai.js';
import {argsFor, bind, failure, prepare, setup} from '../test-support/commerce.js';
import {rig, serverPath} from '../test-support/rig.js';

const phone = '12345678901';
const captcha = '048576';
const bizId = 'mock-sms-1';
const event = {LICHA_SMS_EVENT_NO:'123'};

test('§3.2 短信配置使用正整数、有效期上下界，绑定默认闲置 30 天', () => {
  const env = {LICHA_ACCESS_KEYS:'FAKE'};
  const config = readConfig(env);
  assert.equal(config.LICHA_BINDING_IDLE_TTL_MS, 30 * 86400000);
  const defaults = {
    LICHA_SMS_CODE_TTL_SEC:300, LICHA_SMS_COOLDOWN_SEC:60,
    LICHA_SMS_PER_PHONE_PER_HOUR:5, LICHA_SMS_PER_PHONE_PER_DAY:10, LICHA_SMS_GLOBAL_PER_DAY:2000, LICHA_SMS_MAX_WRONG:5,
    LICHA_SMS_BRAKE_WINDOW_SEC:3600, LICHA_SMS_BRAKE_MIN_SAMPLE:20, LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT:50
  };
  for (const [key, expected] of Object.entries(defaults)) {
    assert.equal(config[key], expected);
    for (const value of ['', '1.5', '0', '-1', 'NaN', '9007199254740992']) {
      assert.throws(() => readConfig({...env, [key]:value}), {message:'配置无效：' + key});
    }
  }
  for (const value of ['29','301']) assert.throws(() => readConfig({...env, LICHA_SMS_CODE_TTL_SEC:value}),
    {message:'配置无效：LICHA_SMS_CODE_TTL_SEC'});
  for (const value of ['30','300']) assert.equal(readConfig({...env, LICHA_SMS_CODE_TTL_SEC:value}).LICHA_SMS_CODE_TTL_SEC, Number(value));
  assert.equal(readConfig({...env,...event}).LICHA_SMS_EVENT_NO, 123);
  for (const value of ['', '0', '-1', '1.3', '9007199254740992']) {
    assert.throws(() => readConfig({...env, LICHA_SMS_EVENT_NO:value}), {message:'配置无效：LICHA_SMS_EVENT_NO'});
  }
});

test('§3.2 刹车窗口严格大于配置的有效期，样本下限可设为 1，百分数含两端', () => {
  const env = {LICHA_ACCESS_KEYS:'FAKE', LICHA_SMS_CODE_TTL_SEC:'60', LICHA_SMS_BRAKE_MIN_SAMPLE:'1'};
  for (const window of ['59', '60']) {
    assert.throws(() => readConfig({...env, LICHA_SMS_BRAKE_WINDOW_SEC:window}), {message:'配置无效：LICHA_SMS_BRAKE_WINDOW_SEC'});
  }
  for (const percent of ['1', '100']) {
    const config = readConfig({...env, LICHA_SMS_BRAKE_WINDOW_SEC:'61', LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT:percent});
    assert.equal(config.LICHA_SMS_BRAKE_WINDOW_SEC, 61);
    assert.equal(config.LICHA_SMS_BRAKE_MIN_SAMPLE, 1);
    assert.equal(config.LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT, Number(percent));
  }
});

test('§3.2 短信事件编号、全服务日额或刹车配置无效时拒绝启动', async t => {
  const r = await rig(t, {env:event});
  for (const [key, value] of [['LICHA_SMS_EVENT_NO', undefined], ['LICHA_SMS_EVENT_NO', 'FAKE_PRIVATE_EVENT_NUMBER'],
    ['LICHA_SMS_GLOBAL_PER_DAY', '0'], ['LICHA_SMS_BRAKE_WINDOW_SEC', '300'], ['LICHA_SMS_BRAKE_MIN_SAMPLE', '0'],
    ['LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT', '101']]) {
    const env = {...r.env, [key]:value};
    if (value === undefined) delete env[key];
    await assert.rejects(promisify(execFile)(process.execPath, [serverPath], {cwd:r.cwd, env, timeout:5000}),
      error => error.code === 1 && error.stderr.includes(key) && !error.stderr.includes('FAKE_PRIVATE_EVENT_NUMBER'));
  }
});

test('BND-13 查会员与创建订单的失败回执中，手机号和去掉前导零的号码都不外传', async t => {
  const padded = '00123456789';
  let code;
  const r = await setup(t);
  const s = await r.session();
  r.mock.override.set(PATHS.member, () => ({status:false, code}));
  for (const [input, echoed] of [[phone, Number(phone)], [padded, Number(padded)],
    [padded, String(Number(padded))], [padded, 110004]]) {
    code = echoed;
    await failure(s, 'bind_member', {code:input, codeType:'phone'}, /查询会员信息时出了点问题/);
  }
  r.mock.override.set(PATHS.member, () => ({status:true, data:1234}));
  r.mock.override.set(PATHS.create, ({mobile, reservePhone}) => ({
    status:false, code:Number(mobile), message:'号码无效 ' + reservePhone + '（' + Number(mobile) + '）'
  }));
  const output = [];
  for (const input of [phone, padded]) {
    const customer = await r.session();
    await bind(customer, input);
    output.push(await failure(customer, 'place_order', argsFor(await prepare(customer)), /下单失败：号码无效/));
  }
  const logs = await Promise.all(['upstream.jsonl', 'access.jsonl', 'write.jsonl'].map(file => readFile(join(r.logDir, file), 'utf8')));
  for (const secret of [phone, padded, String(Number(padded))]) {
    assert.ok([...logs, ...output].every(text => !text.includes(secret)));
  }
  const rows = logs[0].trim().split('\n').map(JSON.parse).filter(row => row.outcome === 'business');
  assert.deepEqual(rows.map(row => row.code), ['***8901', '***6789', '***6789', 110004, '***8901', '***6789']);
  const writes = logs[2].trim().split('\n').map(JSON.parse).filter(row => row.reason === 'business');
  assert.deepEqual(writes.map(row => row.qmaiCode), ['***8901', '***6789']);
});

test('ORD-02 短信出口隔离、关停和一次性凭据绑定到实际发出的手机号', async t => {
  const r = await rig(t, {env:event, upstream:() => ({status:true})});
  const config = readConfig(r.env);
  const api = new Qmai(config, () => {});
  const ledger = new Ledger(join(r.cwd, 'sms-gate'));
  t.after(() => ledger.close());
  const params = {phone, bizId, captcha, urls:{}, eventNo:'覆盖', source:9};
  for (const path of [PATHS.smsSend, PATHS.smsCheck]) {
    assert.throws(() => api.read(path, params), /读出口/);
    assert.throws(() => api.write(path, params), /写出口/);
    const disabled = new Qmai({...config, LICHA_ENABLE_ORDERING:false}, () => {});
    await assert.rejects(disabled.sms(path, params), /短信出口/);
  }
  for (const path of [...Object.values(PATHS).filter(p => p !== PATHS.smsSend && p !== PATHS.smsCheck), 'v3/future/sms']) {
    await assert.rejects(api.sms(path, params), /短信出口/);
  }
  const send = beforeSend => api.sms(PATHS.smsSend, params, {beforeSend});
  await assert.rejects(send(), /凭据/);
  await assert.rejects(send(() => ({})), /凭据/);
  await assert.rejects(send(attempt => ledger.recordSmsSending('00000000000', attempt, config)), /凭据/);
  assert.equal(r.requests.length, 0);
  let receipt;
  assert.equal(await send(attempt => (receipt = ledger.recordSmsSending(phone, attempt, config))), true);
  assert.deepEqual(r.requests[0].params, {bizId, customerPhone:phone, eventNo:123, expireTime:300, source:3});
  await assert.rejects(send(() => receipt), /凭据/);
  assert.equal(r.requests.length, 1);
  assert.equal(await api.sms(PATHS.smsCheck, params), true);
  assert.deepEqual(r.requests[1].params, {bizId, captcha, phone});
});

test('R27 校验只接受四种肯定回执，分别识别明确失败和未知回执', async t => {
  let response;
  const r = await rig(t, {env:event, upstream:() => response});
  const api = new Qmai(readConfig(r.env), () => {});
  const check = () => api.sms(PATHS.smsCheck, {phone, bizId, captcha});
  let attempts = 0;
  const cases = [[undefined,true], [null,true], [{},true], [true,true],
    [false,'unrecognized'], [[],'unrecognized'], [['ok'],'unrecognized'], ['','unrecognized'],
    [0,'unrecognized'], [{valid:true},'unrecognized'], [{status:true},'unrecognized']];
  for (const [data, expected] of cases) {
    response = {status:true, data};
    assert.equal(await check(), expected);
    assert.equal(r.requests.length, ++attempts);
  }
  response = {status:false, code:0, data:true, message:'验证码不对'};
  assert.equal(await check(), false);
  response = {code:0, data:true};
  assert.equal(await check(), 'unrecognized');
  assert.equal(r.requests.length, attempts + 2);
});

test('R27 发码与校验遇 5xx、超时、连接中断、坏 JSON 都不重试，拒绝文案和日志保护识别值', async t => {
  let reply;
  const r = await rig(t, {env:event, upstream:(_path, _params, {res}) => {
    if (reply === '5xx') { res.writeHead(503); res.end(JSON.stringify({status:false})); return; }
    if (reply === 'badJson') { res.end('{'); return; }
    if (reply === 'disconnect') { res.destroy(); return; }
    if (reply === 'timeout') return;
    return reply;
  }});
  const config = readConfig({...r.env, LICHA_WRITE_TIMEOUT_MS:'500'});
  const reports = [];
  const api = new Qmai(config, entry => reports.push(entry));
  const ledger = new Ledger(join(r.cwd, 'sms-errors'));
  t.after(() => ledger.close());
  let clock = Date.now();
  const send = () => api.sms(PATHS.smsSend, {phone, bizId}, {beforeSend:attempt => {
    clock += 3600000;
    return ledger.recordSmsSending(phone, attempt, config, clock);
  }});
  const check = () => api.sms(PATHS.smsCheck, {phone, bizId, captcha});
  for (const [response, kind] of [['5xx','http'], ['badJson','invalid'], ['disconnect','network'], ['timeout','timeout']]) {
    reply = response;
    const before = r.requests.length;
    await assert.rejects(send(), {kind});
    if (response === 'badJson') assert.equal(await check(), 'unrecognized');
    else await assert.rejects(check(), {kind});
    assert.equal(r.requests.length, before + 2);
  }
  reply = {status:false, code:captcha, message:`短信受限，2 分钟后再试，12、123、1234、${captcha}、${phone}、${config.QMAI_OPEN_ID}`};
  await assert.rejects(send(), {kind:'business', message:'短信受限，2 分钟后再试，12、123、***、***、***、***'});
  assert.equal(await check(), false);
  reply = {status:false};
  await assert.rejects(send(), {kind:'business', message:'短信服务暂时不可用'});
  for (const value of [phone, captcha, config.QMAI_OPEN_ID, '短信受限']) assert.ok(!JSON.stringify(reports).includes(value));
  assert.equal(reports.length, r.requests.length);
});
