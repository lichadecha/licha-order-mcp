import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { digest } from '../server/common.js';
import { Ledger } from '../server/ledger.js';
import { PATHS } from '../server/qmai.js';
import {
  argsFor, basket, bind, bookRecords, count, failure, memberA, number, ok, place, prepare, success, withBound
} from '../test-support/commerce.js';

async function writeAudit(r) {
  const text = await readFile(join(r.logDir, 'write.jsonl'), 'utf8');
  return text.trim().split('\n').map(line => JSON.parse(line));
}

test('§5.9 写审计只从本设备签发的待确认单取用券选择，覆盖拒绝、发送及成功', async t => {
  const {r, s} = await withBound(t);
  const original = await prepare(s);
  const draft = await success(s, 'prepare_order', {...basket, couponChoice:'none'});
  const args = argsFor(draft);
  const stranger = await r.session();
  await bind(stranger);
  await failure(stranger, 'place_order', args, /令牌无效/);
  await failure(s, 'place_order', {...args, confirmToken:'unknown-token'}, /令牌无效/);
  await failure(s, 'place_order', argsFor(original), /已被更新/);
  await failure(s, 'place_order', {...args, couponChoice:'default'}, /多余/);
  await failure(s, 'place_order', {...args, confirmAmountYuan:false}, /类型/);
  await failure(s, 'place_order', {...args, confirmAmountYuan:1}, /不一致/);
  await place(s, draft);
  await failure(s, 'place_order', args, /令牌无效/);
  const rows = await writeAudit(r);
  assert.deepEqual(rows.map(row => [row.reason, row.couponChoice]), [
    ['WRT-03', undefined], ['WRT-03', undefined], ['WRT-03', 'default'], ['WRT-01', 'none'],
    ['invalid_arguments', 'none'], ['WRT-05', 'none'], ['WRT-11', 'none'], ['created', 'none'], ['WRT-03', 'none']
  ]);
  await place(s, await prepare(s));
  assert.deepEqual((await writeAudit(r)).slice(-2).map(row => row.couponChoice), ['default', 'default']);
});

test('§5.9 设备限流的写审计只关联本设备已登记的用券选择', async t => {
  const {r, s} = await withBound(t, {LICHA_RATE_CALLS_PER_DEVICE_PER_MIN:'2'});
  const draft = await success(s, 'prepare_order', {...basket, couponChoice:'none'});
  await failure(s, 'place_order', argsFor(draft), /太频繁/);
  await failure(s, 'place_order', {...argsFor(draft), confirmToken:'unknown-token'}, /太频繁/);
  assert.deepEqual((await writeAudit(r)).map(row => [row.reason, row.couponChoice]), [
    ['device_rate', 'none'], ['device_rate', undefined]
  ]);
});

for (const [reason, args, message, limit] of [
  ['WRT-01', {confirmAmountYuan:20, extra:true}, /多余/, '200'],
  ['invalid_arguments', {confirmAmountYuan:false}, /类型/, '200'],
  ['device_rate', {confirmAmountYuan:20}, /太频繁/, '2']
]) {
  test(`LOG-03 ${reason} 拒绝只记录本设备登记令牌的全值和防重键`, async t => {
    const {r, s} = await withBound(t, {LICHA_RATE_CALLS_PER_DEVICE_PER_MIN:limit});
    const own = await prepare(s);
    const other = await r.session();
    await bind(other);
    const foreign = await success(other, 'prepare_order', {...basket, couponChoice:'none'});
    const unknown = '00000000-0000-4000-8000-000000000001';
    for (const confirmToken of [own.confirmToken, foreign.confirmToken, unknown, 12345678]) {
      await failure(s, 'place_order', {...args, confirmToken}, message);
    }
    const rows = await writeAudit(r);
    assert.deepEqual(rows.map(row => row.reason), Array(4).fill(reason));
    const [registered, ...unverified] = rows;
    const key = digest(own.confirmToken);
    assert.equal(registered.tokenId, own.confirmToken);
    assert.equal(registered.requestKey, key);
    assert.equal(registered.dedupKey, key);
    assert.equal(registered.couponChoice, 'default');
    for (const row of unverified) {
      for (const field of ['tokenId', 'requestKey', 'dedupKey', 'couponChoice']) {
        assert.ok(!Object.hasOwn(row, field), field);
      }
    }
    assert.equal(count(r, PATHS.create), 0);
  });
}

test('R26 不用券明确失败只发送一次，未决请求的用券选择在重启核对时仍可审计', async t => {
  const {r, s, m} = await withBound(t);
  const none = {...basket, couponChoice:'none'};
  m.override.set(PATHS.create, () => ({status:false, code:30005, message:'模拟业务失败'}));
  await failure(s, 'place_order', argsFor(await success(s, 'prepare_order', none)), /这.*单没有创建/);
  assert.equal(count(r, PATHS.create), 1);
  m.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await success(s, 'prepare_order', none)), /结果未知/);
  const record = bookRecords(r).find(row => row.state === 'unknown');
  assert.equal(record.couponChoice, 'none');
  m.orders = [{orderNo:number(42), userId:memberA, orderAt:record.time}];
  await r.restart();
  const again = await r.session();
  await bind(again);
  assert.equal((await success(again, 'my_orders')).resolvedPendingWrites, 1);
  const rows = await writeAudit(r);
  assert.deepEqual(rows.map(row => [row.outcome, row.couponChoice]), [
    ['sending', 'none'], ['failed', 'none'], ['sending', 'none'], ['unknown', 'none'], ['resolved', 'none']
  ]);
  assert.equal(rows.at(-1).requestKey, rows.at(-2).requestKey);
});

test('§5.9 v1.8 账本中没有用券选择的未决记录按默认用券核对', async t => {
  const {r, s, m} = await withBound(t);
  m.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  await r.stop();
  const ledger = new Ledger(r.dataDir);
  try {
    const [record] = ledger.records.values();
    const legacy = {...record};
    delete legacy.couponChoice;
    ledger.update(legacy);
    m.orders = [{orderNo:number(21), userId:memberA, orderAt:record.time}];
  } finally {
    ledger.close();
  }
  await r.start();
  const again = await r.session();
  await bind(again);
  assert.equal((await success(again, 'my_orders')).resolvedPendingWrites, 1);
  const last = (await writeAudit(r)).at(-1);
  assert.deepEqual([last.outcome, last.couponChoice], ['resolved', 'default']);
});

test('WRT-10 指定券的两处字段即使同值，也须与签发时登记的实例一致', async t => {
  // 在测试子进程中模拟待发请求被错配为另一张券，保留登记时的选择供提交核对。
  const preload = `const parse = JSON.parse;
JSON.parse = function (...args) {
  const body = parse(...args);
  if (body?.channelCode === 'AI_AGENT' && body.lastSelect?.value === '7200000000000000001') {
    body.lastSelect.value = '7200000000000000002';
    body.attendCouponIds = [body.lastSelect.value];
  }
  return body;
};`;
  const {r, s, m} = await withBound(t, {NODE_OPTIONS:'--import=data:text/javascript;base64,' + Buffer.from(preload).toString('base64')});
  m.couponRows = [{id:'7200000000000000001', title:'三元券', unUseStatus:1, userCouponCanDisAmount:3}];
  const {ref} = (await prepare(s)).coupons.usable[0];
  const draft = await success(s, 'prepare_order', {...basket, couponChoice:'specific', couponRef:ref});
  await failure(s, 'place_order', argsFor(draft), /用券字段与本单的用券选择不符/);
  await failure(s, 'place_order', argsFor(draft), /令牌无效/);
  assert.equal(count(r, PATHS.create), 0);
  assert.deepEqual(bookRecords(r), []);
  assert.deepEqual((await writeAudit(r)).map(row => [row.reason, row.couponChoice]), [
    ['WRT-10', 'specific'], ['WRT-03', 'specific']
  ]);
  assert.equal((await place(s, await prepare(s))).placed, true);
});

test('§4 / §5.9 指定用券的审计和账本只记选择，重启后仍能核对未决单', async t => {
  const {r, s, m} = await withBound(t);
  const id = '7300000000000000042';
  const title = '仅顾客可见的测试券';
  m.couponRows = [{id, title, unUseStatus:1, userCouponCanDisAmount:3}];
  const {ref} = (await prepare(s)).coupons.usable[0];
  const chosen = () => success(s, 'prepare_order', {...basket, couponChoice:'specific', couponRef:ref});
  const draft = await chosen();
  const other = await r.session();
  await bind(other);
  await failure(other, 'place_order', argsFor(draft), /令牌无效/);
  await failure(s, 'place_order', {...argsFor(draft), couponRef:ref}, /多余的：couponRef/);
  assert.equal((await place(s, draft)).placed, true);

  m.override.set(PATHS.create, () => ({status:false, code:100002, message:'模拟拒绝'}));
  await failure(s, 'place_order', argsFor(await chosen()), /这一单没有创建/);
  assert.equal(count(r, PATHS.create), 2);
  m.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await chosen()), /结果未知/);
  const records = bookRecords(r);
  assert.deepEqual(records.map(row => [row.state, row.couponChoice]), [
    ['success', 'specific'], ['failed', 'specific'], ['unknown', 'specific']
  ]);
  m.orders = [{orderNo:number(42), userId:memberA, orderAt:records[2].time}];
  await r.restart();
  const resumed = await r.session(s.device);
  await bind(resumed);
  assert.equal((await success(resumed, 'my_orders')).resolvedPendingWrites, 1);
  const audit = await writeAudit(r);
  assert.deepEqual(audit.map(row => [row.outcome, row.couponChoice]), [
    ['rejected', undefined], ['rejected', 'specific'], ['sending', 'specific'], ['success', 'specific'],
    ['sending', 'specific'], ['failed', 'specific'], ['sending', 'specific'], ['unknown', 'specific'],
    ['resolved', 'specific']
  ]);
  assert.equal(audit.at(-1).requestKey, records[2].key);
  assert.equal(count(r, PATHS.create), 3);
  const logs = await Promise.all(['access', 'write', 'upstream'].map(name => readFile(join(r.logDir, name + '.jsonl'), 'utf8')));
  for (const value of [...logs, JSON.stringify(bookRecords(r))]) {
    for (const privateField of [id, title, ref]) assert.ok(!value.includes(privateField));
  }
});
