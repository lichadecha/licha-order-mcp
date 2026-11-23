import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
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
