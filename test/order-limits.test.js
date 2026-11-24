import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readConfig} from '../server/config.js';
import {Ledger} from '../server/ledger.js';
import {PATHS} from '../server/qmai.js';
import {argsFor, bind, bindAgain, bookRecords, count, failure, number, ok, phoneB, place,
  prepare, withBound} from '../test-support/commerce.js';

const personal = 'LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY';
const global = 'LICHA_MAX_ORDERS_PER_DAY';

test('§3.2 每日单量默认 0，只接受非负安全整数；单笔金额仍须正数', () => {
  const env = {LICHA_ACCESS_KEYS:'test'};
  for (const key of [personal, global]) {
    assert.equal(readConfig(env)[key], 0);
    for (const value of ['0', '1', '23']) assert.equal(readConfig({...env,[key]:value})[key], Number(value));
    for (const value of ['-1', '1.5', 'abc', '', '9007199254740992']) {
      assert.throws(() => readConfig({...env,[key]:value}), {message:'配置无效：' + key});
    }
  }
  assert.throws(() => readConfig({...env,LICHA_MAX_ORDER_AMOUNT_FEN:'0'}), /LICHA_MAX_ORDER_AMOUNT_FEN/);
});

test('WRT-09 每日两项不限时仍拦同会员在途，同日可超过原先两项上限', async t => {
  const {r, s, m} = await withBound(t, {LICHA_WRITE_TIMEOUT_MS:'6000'});
  const other = await r.session();
  await bindAgain(other);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  m.override.set(PATHS.create, async () => {
    started.resolve();
    await release.promise;
    return ok({orderNo:number(100)});
  });
  const first = place(s, await prepare(s));
  await started.promise;
  let next;
  try {
    next = await prepare(other);
    await failure(other,'place_order',argsFor(next),/还在处理中/);
  } finally {
    release.resolve();
    await first;
  }
  m.override.delete(PATHS.create);
  await place(other,next);
  for (let i = 2; i < 11; i++) await place(s, await prepare(s));
  assert.equal(count(r,PATHS.create),11);
  const writes = (await readFile(join(r.logDir,'write.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(writes.every(row => row.quotaDate === undefined));
});

test('WRT-09 LED-01 重启收紧任一上限只恢复实际占用的名额，旧格式按两项都占恢复', async t => {
  const {r, s} = await withBound(t);
  await place(s, await prepare(s));

  async function switchLimits(perMember, all) {
    r.env[personal] = String(perMember);
    r.env[global] = String(all);
    await r.restart();
    const session = await r.session(s.device);
    await bindAgain(session);
    return session;
  }
  const globalOnly = await switchLimits(0, 1);
  await place(globalOnly, await prepare(globalOnly));
  await failure(globalOnly,'place_order',argsFor(await prepare(globalOnly)),/总单量已到上限/);
  const memberOnly = await switchLimits(1, 0);
  await place(memberOnly, await prepare(memberOnly));
  await failure(memberOnly,'place_order',argsFor(await prepare(memberOnly)),/每位会员每天最多 1 单/);

  const both = await switchLimits(2, 2);
  await place(both, await prepare(both));
  await r.stop();
  const book = new Ledger(r.dataDir);
  try {
    const legacy = bookRecords(r).at(-1);
    delete legacy.memberQuota;
    delete legacy.globalQuota;
    book.update(legacy);
  } finally {
    book.close();
  }
  const resumed = await switchLimits(2, 2);
  await failure(resumed,'place_order',argsFor(await prepare(resumed)),/每位会员每天最多 2 单/);
  const other = await r.session();
  await bind(other, phoneB);
  await failure(other,'place_order',argsFor(await prepare(other)),/总单量已到上限/);
  assert.equal(count(r,PATHS.create),4);
});
