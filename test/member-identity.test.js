import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PATHS } from '../server/qmai.js';
import { digest } from '../server/common.js';
import { argsFor, bind, bookFile, count, failure, number, ok, place, prepare, setup, success } from '../test-support/commerce.js';

test('BND-04/05/06 PRE-10 按原编号取尾号，绑定、念单、查单说同一个标识尾号', async t => {
  const r = await setup(t);
  const s = await r.session();
  const ids = { '13800000000': '01234567', SAME: 1234567, '00005555': '07654321' };
  r.mock.override.set(PATHS.member, ({ customerCode }) => ok({ customerId: ids[customerCode.code] }));

  const first = await bind(s);
  const phoneMember = { last4: '***0000', via: 'phone' };
  assert.equal(first.customerIdLast4, '***4567');
  assert.deepEqual(first.member, phoneMember);
  const same = await bind(s, 'SAME', 'dynamic_code');
  assert.equal(same.rebound, undefined);
  assert.equal(same.customerIdLast4, first.customerIdLast4);
  assert.deepEqual(same.member, phoneMember);
  assert.deepEqual((await prepare(s)).member, phoneMember);
  assert.deepEqual((await success(s, 'my_orders')).member, phoneMember);

  const next = await bind(s, '00005555', 'card');
  const cardMember = { last4: '***5555', via: 'card' };
  assert.equal(next.customerIdLast4, '***4321');
  assert.equal(next.previousCustomerIdLast4, '***4567');
  assert.deepEqual(next.member, cardMember);
  assert.deepEqual(next.previousMember, phoneMember);
  assert.equal(next.note, '已从***0000换成***5555。原来那位顾客还没确认的 1 张单已作废，需要重新组单。');
  assert.deepEqual((await success(s, 'my_orders')).member, cardMember);
  const back = await bind(s);
  assert.deepEqual(back.previousMember, cardMember);
  assert.equal(back.note, '已从***5555换成***0000。');
});

for (const unknown of [false, true]) {
  const outcome = unknown ? '结果未知' : '成功';
  test(`BND-05 LED-05 WRT-07/09/18 R3 两种会员编号共享${outcome}记录，重启后继续生效`, async t => {
    const r = await setup(t, { LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY: '1' });
    r.mock.override.set(PATHS.member, params => ok(params.customerCode.code === 'PADD' ? { customerId: '00123' } : 123));
    r.mock.override.set(PATHS.orderStatus, () => ok({ userId: '000123', status: 10 }));
    const padded = await r.session(), plain = await r.session();
    const first = await bind(padded, 'PADD', 'card');
    await bind(plain, 'BASE', 'card');
    const draft = await prepare(padded);
    let receipt;
    if (unknown) {
      r.mock.override.set(PATHS.create, () => ok({}));
      await failure(padded, 'place_order', argsFor(draft), /结果未知/);
    } else {
      receipt = await place(padded, draft);
    }
    assert.equal(r.requests.find(req => req.path === PATHS.create).params.userId, 123);
    const guard = unknown ? /还没有核对清楚/ : /今天的下单次数已到上限/;
    await failure(plain, 'place_order', argsFor(await prepare(plain)), guard);
    const [record] = JSON.parse(await readFile(bookFile(r), 'utf8')).records;
    assert.equal(record.memberHash, digest('123'));
    if (receipt) {
      assert.equal(receipt.qmaiActualAmountYuan, '20.00');
      assert.equal((await success(plain, 'get_order_status', { orderNo: receipt.orderNo })).status, 10);
    }
    const again = await bind(padded, 'BASE', 'dynamic_code');
    assert.equal(again.rebound, undefined);
    assert.equal(again.boundAt, first.boundAt);
    assert.equal(again.boundVia, 'card');
    await r.restart();
    const restarted = await r.session();
    await bind(restarted, 'PADD', 'card');
    await failure(restarted, 'place_order', argsFor(await prepare(restarted)), guard);
    assert.equal(count(r, PATHS.create), 1);
    if (unknown) {
      r.mock.orders = [{ userId: 123, orderNo: number(2), orderAt: record.time, status: 10 }];
      assert.equal((await success(restarted, 'my_orders')).resolvedPendingWrites, 1);
    } else {
      assert.equal((await success(restarted, 'my_orders')).orders[0].orderNo, number(1));
    }
  });
}

test('QRY-02/04 WRT-18 UNR-03 R25 原始会员编号有非零小数或指数溢出时不得作归属证据', async t => {
  const r = await setup(t, { LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY: '5' });
  const s = await r.session();
  r.mock.override.set(PATHS.member, () => ok({ customerId: 76543210 }));
  await bind(s);
  // 直接写 HTTP 字节，避免测试的 JSON.stringify 在发送前就把小数舍入。
  function rawReply(data, res) {
    res.setHeader('content-type', 'application/json');
    res.end('{"status":true,"code":0,"data":' + data + '}');
  }
  for (const token of ['76543210.0000000001', '1e400']) {
    const row = orderNo => `{"orderNo":"${orderNo}","userId":${token},"orderAt":${Date.now()},"status":10,"actualAmount":2000}`;
    r.mock.override.set(PATHS.orderDetail, ({ orderNo }, { res }) => rawReply(row(orderNo), res));
    const receipt = await place(s, await prepare(s));
    assert.equal(receipt.readbackFailed, true);
    assert.equal(receipt.qmaiActualAmountYuan, undefined);
    r.mock.override.set(PATHS.orderStatus, ({ orderNo }, { res }) => rawReply(row(orderNo), res));
    await failure(s, 'get_order_status', { orderNo: receipt.orderNo }, /不属于/);
  }
  r.mock.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  const time = r.requests.filter(req => req.path === PATHS.create).at(-1).at;
  for (const token of ['76543210.0000000001', '1e400']) {
    const data = `{"data":[{"orderNo":"${number(10)}","orderAt":${time},"userId":${token}}],"total":1}`;
    r.mock.override.set(PATHS.orderList, (_, { res }) => rawReply(data, res));
    const list = await success(s, 'my_orders');
    assert.equal(list.count, 0);
    assert.equal(list.discardedNotOwned, 1);
    assert.equal(list.unresolvedPendingWrites, 1);
    for (const member of [token, `{"customerId":${token}}`]) {
      r.mock.override.set(PATHS.member, (_, { res }) => rawReply(member, res));
      await failure(s, 'bind_member', { code: 'BASE', codeType: 'card' }, /查询会员信息/);
    }
  }
});
