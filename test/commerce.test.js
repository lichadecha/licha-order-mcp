import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chmod, cp, readFile, readdir, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { rig } from '../test-support/rig.js';
import { PATHS } from '../server/qmai.js';
import { Ledger } from '../server/ledger.js';
import { beijingTime, digest } from '../server/common.js';
import { checkOrderFields } from '../server/commerce.js';

import {
  memberA, memberB, phone, goodsId, skuId, shop, basket, number, ok, setup, success, failure,
  bind, prepare, argsFor, place, count, bookFile, bookRecords, withBound
} from '../test-support/commerce.js';

test('绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01', async t => {
  const r = await setup(t);
  const s = await r.session();
  const nowhere = { confirmToken: 'fake', confirmAmountYuan: 20 };
  for (const [tool, args] of [['prepare_order', basket], ['get_order_status', { orderNo: 'x' }], ['my_orders', {}], ['place_order', nowhere]])
    await failure(s, tool, args, /未绑定/);
  await failure(s, 'bind_member', { code: 'bad-number', codeType: 'phone' }, /收到长度：10/);
  await failure(s, 'bind_member', { code: '  AB ', codeType: 'card' }, /收到长度：2/);
  assert.equal(r.requests.length, 0);
  const first = await bind(s, '138 0000 0000');
  assert.equal(first.customerIdLast4, '***1234');
  assert.equal(first.boundVia, 'phone');
  const draft = await prepare(s);
  assert.equal(draft.member.last4, '***0000');
  for (const code of ['0000', '0001', '0002']) await failure(s, 'bind_member', { code, codeType: 'card' }, /去微信搜/);
  r.mock.override.set(PATHS.member, () => ({ status: false }));
  await failure(s, 'bind_member', { code: 'FAKE_CARD_B', codeType: 'card' }, /查询会员信息/);
  r.mock.override.delete(PATHS.member);
  const same = await bind(s, 'FAKE_CARD_A', 'dynamic_code');
  assert.equal(same.boundAt, first.boundAt);
  assert.equal(same.boundVia, first.boundVia);
  assert.equal(same.rebound, undefined);
  await place(s, draft);
  const req = r.requests.find(x => x.path === PATHS.create);
  assert.equal(req.params.mobile, phone);
  assert.equal(req.params.reservePhone, phone);
  assert.equal(req.params.userId, memberA);
  assert.equal(r.requests.find(x => x.params.customerCode?.code === 'FAKE_CARD_A').params.customerCode.type, 0);
  const old = await prepare(s);
  const replacement = await bind(s, 'ABCD', 'card');
  assert.equal(replacement.rebound, true);
  assert.equal(replacement.previousCustomerIdLast4, '***1234');
  assert.equal(replacement.discardedPendingOrders, 1);
  await failure(s, 'place_order', argsFor(old), /不属于/);
  const second = await prepare(s);
  assert.deepEqual(second.member, { last4: '***', via: 'card' });
  await place(s, second);
  const reqB = r.requests.filter(x => x.path === PATHS.create).at(-1);
  assert.ok(!('mobile' in reqB.params) && !('reservePhone' in reqB.params));
  await bind(s);
  await failure(s, 'place_order', argsFor(old), /无效/);
  for (const file of [bookFile(r), ...['access','upstream','write'].map(n => join(r.logDir,n + '.jsonl'))]) {
    const bytes = await readFile(file, 'utf8');
    for (const secret of [phone, memberA, memberB, 'FAKE_CARD_A', s.device]) assert.ok(!bytes.includes(secret), file);
  }
});

test('绑定查询限流不计预检与限流拒绝 BND-09', async t => {
  const r = await setup(t, { LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR: '1', LICHA_RATE_BINDS_GLOBAL_PER_MIN: '2' });
  const a = await r.session(), b = await r.session(), c = await r.session();
  await failure(a, 'bind_member', { code: 'invalid', codeType: 'phone' }, /格式/);
  await bind(a);
  await failure(a, 'bind_member', { code: phone, codeType: 'phone' }, /太频繁/);
  await bind(b);
  await failure(c, 'bind_member', { code: phone, codeType: 'phone' }, /太频繁/);
  assert.equal(count(r, PATHS.member), 2);
});

test('设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03', async t => {
  const { r, s } = await withBound(t, { LICHA_CONFIRM_TOKEN_TTL_MS: '400' });
  const same = await r.session(s.device), other = await r.session();
  const first = await prepare(same);
  await bind(other);
  const newer = await prepare(other);
  assert.equal(newer.supersededPendingOrders, 1);
  await failure(other, 'place_order', argsFor(first), /无效/);
  await failure(same, 'place_order', argsFor(first), /替代/);
  await delay(410);
  await failure(same, 'place_order', argsFor(first), /过期/);
  await failure(same, 'place_order', argsFor(newer), /无效/);
  await delay(410);
  await failure(same, 'place_order', argsFor(first), /无效/);
  assert.equal(count(r, PATHS.create), 0);
  await bind(other, 'FAKE_CARD_B', 'card');
  const [draftA,draftB] = await Promise.all([prepare(same), prepare(other)]);
  const [orderA,orderB] = await Promise.all([place(same,draftA), place(other,draftB)]);
  assert.notEqual(orderA.orderNo, orderB.orderNo);
  assert.deepEqual(new Set(r.requests.filter(x => x.path === PATHS.create).map(x => x.params.userId)),new Set([memberA,memberB]));
});

test('券预测优先级、投影、一次查询和缺门店编码 PRE-07 OUT-01/02', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [
    { title: '大券', userCouponCanDisAmount: 30, unUseStatus: 1, couponCenterType: 1, id: memberA },
    { title: '测试5折', userCouponCanDisAmount: 10, unUseStatus: 1, couponCenterType: 2 },
    { title: '并列', userCouponCanDisAmount: 10, unUseStatus: 1, couponCenterType: 2 },
    { title: null, unUseStatus: 0, unUseDesc: '原因 openToken:FAKE_SECRET +8613800000000' }
  ];
  let coupons = (await prepare(s)).coupons;
  assert.deepEqual(coupons.predicted, { title:'测试5折', canDisYuan:'10.00', payAfterYuan:'10.00', basis:'auto_type' });
  assert.deepEqual(coupons.unusable, [{ title:'（未命名的券）', reason:'原因 ***0000' }]);
  assert.ok(!JSON.stringify(coupons).includes(memberA));
  m.couponRows.splice(1, 2);
  coupons = (await prepare(s)).coupons;
  assert.equal(coupons.predicted.basis, 'max_discount');
  assert.equal(coupons.predicted.payAfterYuan, '0.00');
  m.couponRows[0].userCouponCanDisAmount = null;
  assert.equal((await prepare(s)).coupons.predicted, undefined);
  m.override.set(PATHS.coupons, (_, { res }) => { res.statusCode = 503; res.end(); });
  const before = count(r, PATHS.coupons);
  assert.equal((await prepare(s)).coupons.available, false);
  assert.equal(count(r, PATHS.coupons) - before, 1);
  m.code = '';
  await r.restart();
  const newSession = await r.session();
  await bind(newSession);
  assert.match((await prepare(newSession)).coupons.note, /门店暂时查不了券/);
  assert.equal(count(r, PATHS.coupons) - before, 1);
});

test('递归拒绝七个预约字段 PRE-06', () => {
  for (const key of ['isPre','preTime','preTimeStart','preTimeEnd','isWaiterCheck','orderSubType','payModel']) {
    assert.throws(() => checkOrderFields({ items: [{ practiceList: [{ [key]: 0 }] }] }), /params.items\[0\].practiceList\[0\]/);
  }
});

test('并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [{ title:'半价券', unUseStatus:1, userCouponCanDisAmount:10 }];
  const draft = await prepare(s);
  const args = argsFor(draft);
  await failure(s,'place_order',{...args, other:{userId:memberB}},/只接受/);
  await failure(s,'place_order',{...args,confirmAmountYuan:20.02},/20.02.*20.00/);
  assert.equal(count(r, PATHS.create), 0);
  m.override.set(PATHS.orderDetail, p => ok({ ...m.last, actualAmount: 0, discountList: [{ discountType:2,
    discountName:'优惠券', discountSummary:'半价券', discountAmount:2000, discountId:memberA }] }));
  const outcomes = await Promise.all([s.call('place_order', {...args,confirmAmountYuan:20.01}), s.call('place_order',args)]);
  assert.equal(outcomes.filter(x => x.isError).length, 1);
  const receipt = JSON.parse(outcomes.find(x => !x.isError).content[0].text);
  assert.equal(receipt.qmaiActualAmountYuan, '0.00');
  assert.equal(receipt.diffYuan, '-20.00');
  assert.ok(receipt.warning);
  assert.match(receipt.nextStep, /确认这一单的状态/);
  assert.equal(receipt.couponApplied.matchesPrediction, true);
  assert.equal(receipt.couponApplied.items[0].discountId, undefined);
  assert.equal(count(r, PATHS.create), 1);
  assert.equal(count(r, PATHS.orderDetail), 1);
  const again = await prepare(s);
  assert.equal(again.recentOrder.orderNo, receipt.orderNo);
  assert.equal(again.recentOrder.estimatedTotalYuan,'20.00');
});

test('同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05', async t => {
  const { r, s, m } = await withBound(t, { LICHA_MAX_ORDERS_PER_DAY:'1', LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1' });
  const a2 = await r.session(), b = await r.session();
  await bind(a2);
  await bind(b, 'FAKE_CARD_B','card');
  const draftB = await prepare(b);
  const draftA = await prepare(s);
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  m.override.set(PATHS.create, async params => {
    arrived.resolve();
    await release.promise;
    m.last = { orderNo:number(2), userId:params.userId, actualAmount:2000 };
    return ok({ orderNo:number(2) });
  });
  const purchasing = place(s,draftA);
  await arrived.promise;
  const newer = await prepare(a2);
  await failure(a2,'place_order',argsFor(newer),/还在处理中/);
  await failure(b,'place_order',argsFor(draftB),/总单量已到上限/);
  release.resolve();
  await purchasing;
  await failure(a2,'place_order',argsFor(newer),/每位会员每天最多 1 单/);
  assert.equal(count(r, PATHS.create), 1);
  await r.restart();
  const resumed = await r.session(s.device);
  await failure(resumed,'place_order',argsFor(draftA),/未绑定/);
  await bind(resumed);
  await failure(resumed,'place_order',argsFor(draftA),/无效/);
  await failure(resumed,'place_order',argsFor(await prepare(resumed)),/每位会员每天最多 1 单/);
  const other = await r.session();
  await bind(other, 'FAKE_CARD_B','card');
  await failure(other,'place_order',argsFor(await prepare(other)),/总单量/);
  const text = await readFile(bookFile(r),'utf8');
  const [row] = bookRecords(r);
  assert.match(row.memberHash,/^[0-9a-f]{64}$/);
  assert.match(row.key,/^[0-9a-f]{64}$/);
  assert.equal(row.state,'success');
  assert.ok(!text.includes(memberA));
});

test('资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03', async t => {
  const { r, s, m } = await withBound(t, { LICHA_WRITE_TIMEOUT_MS:'150', LICHA_ORDER_MATCH_WINDOW_MS:'20', LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'10' });
  m.override.set(PATHS.create, () => ({ status:false, code:30005, message:'坏值 appSecret=FAKE_TEXT' }));
  const rejected = await prepare(s);
  const message = await failure(s, 'place_order', argsFor(rejected),/这一单没有创建/);
  assert.ok(!message.includes('FAKE_TEXT'));
  await failure(s,'place_order',argsFor(rejected),/无效/);
  const modes = [
    [(_, { res }) => { res.statusCode=503; res.end(); }, /HTTP 503/],
    [(_, { res }) => { res.end('{bad'); }, /回执没法确认/],
    [() => ({ status: 'true', data:{orderNo:number(3)} }), /回执没法确认/],
    [() => ok({ payAmount:20 }), /回执没法确认/],
    [(_, { res }) => { res.destroy(); }, /网络中断/],
    [() => undefined, /请求已经发出去了/]
  ];
  for (const [reply, error] of modes) {
    m.override.set(PATHS.create, reply);
    const before = count(r,PATHS.create);
    const draft = await prepare(s);
    await failure(s,'place_order',argsFor(draft),error);
    assert.equal(count(r,PATHS.create), before+1);
    await delay(25);
    const list = await success(s,'my_orders');
    assert.equal(list.resolvedPendingWrites,1);
    assert.match(list.pendingWriteNote,/没有建单/);
  }
});

test('安全读回和优惠证据 WRT-15/16/17/18/19', async t => {
  const { r, s, m } = await withBound(t,{LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'25',LICHA_MAX_ORDERS_PER_DAY:'25'});
  m.couponRows = [{ title:'模拟券', userCouponCanDisAmount:1, unUseStatus:1 }];
  const orderWith = async transform => {
    m.override.set(PATHS.orderDetail, () => ok(transform(m.last)));
    return place(s, await prepare(s));
  };
  for (const transform of [
    () => null, row => ({ ...row, orderNo:number(123) }), row => ({...row,userId:memberB}),
    row => ({...row,userId:null}), row => ({...row,actualAmount:false}), row => ({...row,actualAmount:' '})
  ]) {
    const result = await orderWith(transform);
    assert.equal(result.readbackFailed,true);
    assert.deepEqual(Object.keys(result).sort(), ['nextStep','orderNo','placed','readbackFailed','readbackNote']);
    assert.match(result.nextStep,/核对金额后再付款/);
  }
  m.override.set(PATHS.orderDetail, (_, {res}) => { res.statusCode=503; res.end(); });
  const reads = count(r,PATHS.orderDetail), writes = count(r,PATHS.create);
  assert.equal((await place(s,await prepare(s))).readbackFailed,true);
  assert.equal(count(r,PATHS.orderDetail),reads+3);
  assert.equal(count(r,PATHS.create),writes+1);
  const zeroDiscount = await orderWith(row => ({...row,actualAmount:1900,discountAmount:0}));
  assert.equal(zeroDiscount.warning,undefined);
  assert.match(zeroDiscount.couponApplied.note,/没有任何优惠/);
  const missing = await orderWith(row => ({...row,actualAmount:1899,discountAmount:null}));
  assert.ok(missing.warning);
  assert.match(missing.couponApplied.note,/没取到优惠明细/);
  assert.equal(missing.couponApplied.matchesPrediction,undefined);
  const noncoupon = await orderWith(row => ({...row,actualAmount:1900,discountAmount:100,
    discountList:[{discountType:3,discountAmount:100,discountName:'满减'}]}));
  assert.equal(noncoupon.couponApplied.matchesPrediction,false);
  assert.match(noncoupon.couponApplied.note,/门店系统自动给了优惠/);
  const otherCoupon = await orderWith(row => ({...row,discountList:[{discountType:2,discountAmount:100,discountName:'别的券'}]}));
  assert.match(otherCoupon.couponApplied.note,/与组单时告知的不一致/);
  m.couponRows = [];
  const auto = await orderWith(row => ({...row,discountList:[{discountType:2,discountAmount:200,discountName:'自动券'}]}));
  assert.match(auto.couponApplied.note,/自动使用了优惠券/);
  assert.match(auto.nextStep,/完成付款/);
});

test('查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08', async t => {
  const { r,s,m } = await withBound(t);
  for (const userId of [memberB, null]) {
    m.override.set(PATHS.orderStatus, () => ok({status:10,userId,storeOrderNo:'SHOULD_NOT_LEAK'}));
    const error = await failure(s,'get_order_status',{orderNo:number(1)},/不属于/);
    assert.ok(!error.includes('SHOULD_NOT_LEAK'));
  }
  for (const [raw,text,hint] of [[null,'状态未知',/没查清/], [true,'状态未知',/没查清/],
    [10,'待支付',/完成付款/], [15,'支付中',/看支付结果/], [20,'已支付',/已经付款/],
    [30,'待备餐',/已经付款/],[40,'待取餐',/取餐即可/],[50,'已完成',/不需要再付款/],
    [60,'已取消',/不需要再付款/],[70,'已关闭',/不需要再付款/],[89,'未知状态(89)',/没查清/]]) {
    m.override.set(PATHS.orderStatus, () => ok({status:raw,userId:memberA}));
    const result = await success(s,'get_order_status',{orderNo:number(1)});
    assert.equal(result.statusText,text);
    assert.match(result.paymentHint,hint);
  }
  m.orders = [
    {userId:memberB,orderNo:number(66)},
    {orderNo:number(67)}, {orderNo:number(68)},
    {userId:memberA,orderNo:number(1),status:null,actualAmount:' ',createTime:String(Date.now()),itemList:[{num:3},{itemName:'茶',num:2}]},
    {userId:memberA,orderNo:number(2),status:10,actualAmount:'0',orderAt:Date.now(),itemList:[],secret:'FAKE_PRIVATE'}
  ];
  const result = await success(s,'my_orders',{days:90});
  assert.equal(result.count,2);
  assert.equal(result.discardedNotOwned,1);
  assert.equal(result.unverifiedNotShown,2);
  assert.match(result.note,/另有 2 条订单门店系统没标明属于哪位会员，没有展示；请在小程序「我的订单」里查看。$/);
  assert.deepEqual(result.orders.map(row => row.orderNo),[number(1),number(2)]);
  assert.equal(result.orders[0].actualAmountYuan,null);
  assert.match(result.orders[0].orderTime,/\+08:00$/);
  assert.deepEqual(result.orders[0].items,['茶 ×2']);
  assert.equal(result.orders[1].actualAmountYuan,'0.00');
  assert.ok(!JSON.stringify(result).includes(memberA) && !JSON.stringify(result).includes('FAKE_PRIVATE'));
  const p = r.requests.at(-1).params;
  assert.equal(p.orderAtEnd-p.orderAtStart,90*86400000);
  assert.equal(p.pageNo,1);
  assert.equal(p.pageSize,10);
});

test('未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08', async t => {
  const {r,s,m} = await withBound(t,{ LICHA_ORDER_MATCH_WINDOW_MS:'450', LICHA_MAX_ORDERS_PER_DAY:'10' });
  const b = await r.session();
  await bind(b,'FAKE_CARD_B','card');
  // 已知成功的订单也处于匹配窗口。
  const prior = await place(s,await prepare(s));
  m.override.set(PATHS.create, () => ok({}));
  await failure(s,'place_order',argsFor(await prepare(s)),/结果未知/);
  m.override.delete(PATHS.create);
  await failure(s,'bind_member',{code:'FAKE_CARD_B',codeType:'card'},/暂时不能换人/);
  await failure(s,'place_order',argsFor(await prepare(s)),/先调用 my_orders/);
  const status = await success(s,'get_order_status',{orderNo:prior.orderNo});
  assert.equal(status.unresolvedPendingWrites,1);
  const at = r.requests.filter(x=>x.path===PATHS.create).at(-1).at;
  const candidate = { orderNo:number(88), userId:memberA, orderAt:at, status:60, storeId:shop };
  let page = {data:[],total:0};
  m.override.set(PATHS.orderList,()=>ok(page));
  assert.equal((await success(s,'my_orders')).unresolvedPendingWrites,1);
  assert.equal((await success(b,'my_orders')).unresolvedPendingWrites,undefined);
  await place(b,await prepare(b));
  await delay(455);
  page={total:0};
  await failure(s,'my_orders',{days:90},/查询订单列表失败/);
  for (const bad of [
    {data:[],total:' '}, {data:[],total:-1}, {data:[],total:2.1},
    {data:[{...candidate,userId:memberB}],total:1}, {data:[{...candidate,userId:null}],total:1},
    {data:[{...candidate,orderNo:''}],total:1}, {data:[{...candidate,orderAt:null}],total:1},
    {data:[{...candidate,orderNo:prior.orderNo}],total:1},
    {data:[candidate,{...candidate,orderNo:number(89)}],total:2}
  ]) {
    page=bad;
    assert.equal((await success(s,'my_orders',{days:90})).unresolvedPendingWrites,1);
  }
  page={data:[],total:18};
  assert.match((await success(s,'my_orders',{days:90})).pendingWriteNote,/联系门店/);
  page={data:[candidate],total:18};
  const confirmed=await success(s,'my_orders');
  assert.equal(confirmed.resolvedPendingWrites,1);
  assert.match(confirmed.pendingWriteNote,/不是待支付状态/);
  assert.ok(!confirmed.pendingWriteNote.includes('请引导顾客去'));
  await r.restart();
  const s2=await r.session(s.device);
  await bind(s2);
  m.override.set(PATHS.create,()=>ok({}));
  await failure(s2,'place_order',argsFor(await prepare(s2)),/结果未知/);
  candidate.orderAt=r.requests.filter(x=>x.path===PATHS.create).at(-1).at;
  assert.equal((await success(s2,'my_orders')).unresolvedPendingWrites,1);
  page={data:[{...candidate,storeId:'999'}],total:1};
  await delay(455);
  assert.equal((await success(s2,'my_orders')).unresolvedPendingWrites,1);
  page={data:[],total:0};
  const absent=await success(s2,'my_orders');
  assert.equal(absent.resolvedPendingWrites,1);
  assert.match(absent.pendingWriteNote,/没有建单/);
});

test('零元预估不占位 WRT-08', async t => {
  // 正常目录已拦截负加价。直接给下单层一份零元报价，单独检验发送前护栏。
  const browseURL = new URL('../server/browse.js', import.meta.url).href;
  const preload = `import { Browse } from ${JSON.stringify(browseURL)};
    const quote = Browse.prototype.quote;
    Browse.prototype.quote = async function (...args) {
      return { ...await quote.apply(this, args), totalFen: 0 };
    };`;
  const { r, s } = await withBound(t, {
    NODE_OPTIONS: '--import=data:text/javascript;base64,' + Buffer.from(preload).toString('base64')
  });
  const draft = await prepare(s);
  assert.equal(draft.estimatedTotalYuan,'0.00');
  await failure(s,'place_order',{confirmToken:draft.confirmToken,confirmAmountYuan:0.01},/超上限/);
  assert.equal(count(r,PATHS.create),0);
});

test('发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03', async t => {
  const { r,s } = await withBound(t);
  const second = await r.session();
  await bind(second,'FAKE_CARD_B','card');
  const a = await prepare(s), b = await prepare(second);
  const file = bookFile(r);
  await rename(file,file+'.backup');
  await mkdir(file);
  await failure(s,'place_order',argsFor(a),/没有发出/);
  await failure(second,'place_order',argsFor(b),/安全账本不可用/);
  await failure(s,'prepare_order',basket,/安全账本不可用/);
  assert.equal(count(r,PATHS.create),0);
  const assertFault = async () => {
    await r.restart();
    const resumed = await r.session(s.device);
    await bind(resumed);
    await failure(resumed,'prepare_order',basket,/安全账本不可用/);
    assert.equal((await success(resumed,'preview_order',basket)).ok,true);
    assert.equal((await success(resumed,'my_orders')).count,0);
  };
  await assertFault();
  await rm(file,{recursive:true});
  await assertFault();
  await writeFile(file,'damaged sqlite header');
  await assertFault();
  await rename(file+'.backup',file);
  await r.restart();
  const recovered=await r.session();
  await bind(recovered);
  await place(recovered,await prepare(recovered));
});

test('已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07', async t => {
  const {r,s,m}=await withBound(t,{LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1',LICHA_ORDER_MATCH_WINDOW_MS:'2000'});
  const file=bookFile(r);
  let at;
  m.override.set(PATHS.create,async params=>{
    at=Date.now();
    await rename(file,file+'.backup');
    await mkdir(file);
    return ok({orderNo:number(99)});
  });
  const receipt=await place(s,await prepare(s));
  assert.equal(receipt.orderNo,number(99));
  assert.equal(receipt.placed,true);
  await failure(s,'prepare_order',basket,/账本不可用/);
  await rm(file,{recursive:true});
  await rename(file+'.backup',file);
  await r.restart();
  const current=await r.session(s.device);
  await bind(current);
  const draft=await prepare(current);
  await failure(current,'place_order',argsFor(draft),/状态未知/);
  m.orders=[{orderNo:number(99),userId:memberA,orderAt:at,status:10,storeId:shop}];
  await rename(file,file+'.backup');
  await mkdir(file);
  const list=await success(current,'my_orders');
  assert.equal(list.orders[0].orderNo,number(99));
  assert.equal(list.unresolvedPendingWrites,1);
  assert.equal(list.resolvedPendingWrites,undefined);
  assert.match(list.pendingWriteNote,/结论暂时没能保存/);
  await rm(file,{recursive:true});
  await rename(file+'.backup',file);
  await r.restart();
  const verified=await r.session(s.device);
  await bind(verified);
  assert.equal((await success(verified,'my_orders')).resolvedPendingWrites,1);
  await failure(verified,'place_order',argsFor(await prepare(verified)),/每位会员每天最多 1 单/);
  assert.equal(count(r,PATHS.create),1);
});

test('强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06',async t=>{
  const {r,s,m}=await withBound(t,{LICHA_WRITE_TIMEOUT_MS:'4000'});
  const second=await r.session();
  await bind(second);
  const arrived=Promise.withResolvers();
  m.override.set(PATHS.create,()=>{arrived.resolve();return undefined;});
  const submitted=s.call('place_order',argsFor(await prepare(s))).catch(()=>null);
  await arrived.promise;
  const [row]=bookRecords(r);
  const [request]=r.requests.filter(req=>req.path===PATHS.create);
  assert.equal(row.state,'sent');
  assert.ok(Math.abs(row.time-request.at)<200);
  m.orders=[{userId:memberA,orderNo:number(18),orderAt:request.at,status:10}];
  // 在途的请求即便在上游列表查到，也不允许提前写核对结论。
  const active=await success(second,'my_orders');
  assert.equal(active.resolvedPendingWrites,undefined);
  await r.stop('SIGKILL');
  await submitted;
  await r.start();
  const restarted=await r.session();
  await bind(restarted);
  await failure(restarted,'place_order',argsFor(await prepare(restarted)),/状态未知/);
  const cli=fileURLToPath(new URL('../server/ledger-cli.js',import.meta.url));
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:r.cwd,env:r.env,encoding:'utf8'});
  assert.notEqual(run('list').status,0);
  await r.stop();
  const listing=run('list');
  assert.equal(listing.status,0,listing.stderr);
  assert.equal(JSON.parse(listing.stdout)[0].key,row.key);
  const manualOrderNo = 'FAKEORDER00000018';
  assert.equal(run('resolve',row.key,'found',manualOrderNo,'门店人工核对').status,0);
  assert.notEqual(run('resolve',row.key,'absent','重复核对').status,0);
  await r.start();
  const fixed=await r.session();
  await bind(fixed);
  assert.equal((await success(fixed,'my_orders')).unresolvedPendingWrites,undefined);
  m.override.set(PATHS.create,()=>ok({}));
  await failure(fixed,'place_order',argsFor(await prepare(fixed)),/结果未知/);
  m.orders[0].orderAt=Date.now();
  m.orders[0].orderNo=manualOrderNo;
  assert.equal((await success(fixed,'my_orders')).unresolvedPendingWrites,1);
  await r.stop();
  const nextKey=JSON.parse(run('list').stdout)[0].key;
  assert.notEqual(run('resolve',nextKey,'found',manualOrderNo,'同一张单').status,0);
  assert.equal(run('resolve',nextKey,'absent','门店复查无单').status,0);
  assert.deepEqual(JSON.parse(run('list').stdout),[]);
  assert.equal(bookRecords(r).find(row => row.key === nextKey).operatorNote, '门店复查无单');
});

// 两个服务各用自己的端口与客户端，共享被测账本目录和同一个模拟上游。
async function secondInstance(t, first) {
  const second = await rig(t, {env:{LICHA_ENABLE_ORDERING:'0', QMAI_BASE_URL:first.env.QMAI_BASE_URL}});
  await second.stop();
  second.env.LICHA_ENABLE_ORDERING = '1';
  second.env.LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY = first.env.LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY ?? '5';
  return second;
}

async function raceForLedger(first, second, directory) {
  first.env.LICHA_DATA_DIR = directory;
  second.env.LICHA_DATA_DIR = directory + '/.';
  const instances = [first, second];
  const outcomes = await Promise.allSettled(instances.map(instance => instance.start()));
  const losers = outcomes.filter(result => result.status === 'rejected');
  assert.equal(losers.length, 1, outcomes.map(result => result.reason?.message ?? '已就绪').join('、'));
  assert.match(losers[0].reason.message, /服务启动失败.*其他实例/s);
  const winnerIndex = outcomes.findIndex(result => result.status === 'fulfilled');
  return {winner:instances[winnerIndex], loser:instances[1 - winnerIndex]};
}

test('全新目录双实例并发抢锁、别名与死亡接管 LED-06', async t => {
  const first = await setup(t,{LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1'});
  const second = await secondInstance(t,first);
  await first.stop();
  const {winner, loser} = await raceForLedger(first,second,join(first.cwd,'fresh'));
  const customer = await winner.session();
  await bind(customer);
  const placed = await place(customer,await prepare(customer));
  await winner.stop('SIGKILL');
  await loser.start();
  const resumed = await loser.session();
  await bind(resumed);
  const draft = await prepare(resumed);
  assert.equal(draft.recentOrder.orderNo,placed.orderNo);
  await failure(resumed,'place_order',argsFor(draft),/每位会员每天最多 1 单/);
  assert.equal(count(first,PATHS.create),1);
});

test('恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07', async t => {
  const r = await setup(t, { LICHA_ORDER_MATCH_WINDOW_MS:'30000' });
  await r.stop();
  const now = Date.now();
  const early = now - 12000;
  const recent = now - 10000;
  const ancient = now - 91 * 86400000;
  const entries = [
    [recent, 'second'], [early, 'first'], [ancient, 'ancient']
  ].map(([time, key]) => ({ time, day: beijingTime(time).slice(0,10), key: digest(key),
    memberHash: digest(memberA), storeId: shop, totalFen: 2000, state:'sent' }));
  const ledger = new Ledger(r.dataDir);
  try { for (const entry of entries) ledger.update(entry); } finally { ledger.close(); }
  r.mock.orders = [{ userId:memberA, orderNo:number(19), orderAt:early+1, status:10 }];
  await r.start();
  const s=await r.session();
  await bind(s);
  const result=await success(s,'my_orders');
  assert.equal(result.resolvedPendingWrites,1);
  assert.equal(result.unresolvedPendingWrites,2);
  assert.match(result.pendingWriteNote,/小程序「我的订单」付款/);
  assert.match(result.pendingWriteNote,/联系门店/);
  const saved=bookRecords(r);
  assert.equal(saved.find(row=>row.time===early).orderNo,number(19));
  assert.equal(saved.find(row=>row.time===recent).state,'sent');
  assert.equal((await success(s,'my_orders')).unresolvedPendingWrites,2);
});

test('UNR-03/07 有单说明列出吻合订单，按支付状态顺序附上三个尾句', async t => {
  const r = await setup(t, { LICHA_ORDER_MATCH_WINDOW_MS: '1000' });
  await r.stop();
  const now = Date.now();
  const ledger = new Ledger(r.dataDir);
  try {
    for (const [i, status] of [10, 60, null].entries()) {
      const time = now - (3 - i) * 10000;
      ledger.update({ time, day: beijingTime(time).slice(0, 10), key: digest('request' + i),
        memberHash: digest(memberA), storeId: shop, totalFen: 2000, state: 'sent' });
      r.mock.orders.push({ userId: memberA, orderNo: number(i + 1), orderAt: time, status });
    }
  } finally {
    ledger.close();
  }
  await r.start();
  const s = await r.session();
  await bind(s);
  const result = await success(s, 'my_orders');
  assert.equal(result.resolvedPendingWrites, 3);
  assert.equal(result.pendingWriteNote, `核对结果：此前 3 笔结果未知的下单请求，在企迈侧查到了与它吻合的订单（${[1, 2, 3].map(number).join('、')}），按这张处理，不要重下。`
    + '请引导顾客去小程序「我的订单」付款。其中 1 笔不是待支付状态，按小程序订单页显示的为准。'
    + '其中 1 笔状态未查清，请在小程序「我的订单」核对状态。');
});

test('迟到的订单列表只核对查询开始时的未决 UNR-05', async t => {
  const {r,s,m} = await withBound(t);
  const other = await r.session();
  await bind(other);
  const fetching = Promise.withResolvers();
  const respond = Promise.withResolvers();
  m.override.set(PATHS.orderList, async () => { fetching.resolve(); return ok(await respond.promise); });
  const oldQuery = success(s,'my_orders');
  await fetching.promise;
  m.override.set(PATHS.create, () => ok({}));
  await failure(other,'place_order',argsFor(await prepare(other)),/结果未知/);
  const data = [{orderNo:number(21),userId:memberA,storeId:shop,orderAt:Date.now(),status:10}];
  respond.resolve({ data, total:1 });
  const result=await oldQuery;
  assert.equal(result.resolvedPendingWrites,undefined);
  assert.equal(result.unresolvedPendingWrites,1);
  assert.equal((await success(s,'my_orders')).resolvedPendingWrites,1);
});

test('WRT-10 持久防重记录命中时归还占位，不再请求创建', async t => {
  // 测试中让签发函数两次得到相同的 UUID，触达随机令牌通常无法重复命中的防线。
  // 会话、SQLite 和其他模块继续使用系统随机数。
  const source = `import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
const original = crypto.randomUUID.bind(crypto);
let count = 0;
crypto.randomUUID = (...args) => new Error().stack.includes('at prepare (') && ++count <= 2
  ? '00000000-0000-4000-8000-000000000010' : original(...args);
syncBuiltinESMExports();`;
  const preload = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const {r,s} = await withBound(t,{NODE_OPTIONS:'--import='+preload,LICHA_MAX_ORDERS_PER_DAY:'2',
    LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'2'});
  const first = await prepare(s);
  await place(s,first);
  const duplicate = await prepare(s);
  assert.equal(duplicate.confirmToken,first.confirmToken);
  await failure(s,'place_order',argsFor(duplicate),/已经下过单/);
  assert.equal(count(r,PATHS.create),1);
  const next = await prepare(s);
  assert.notEqual(next.confirmToken,first.confirmToken);
  await place(s,next);
  assert.equal(count(r,PATHS.create),2);
});

test('UNR-03 商品名称、编号和杯数随发送记录恢复，畸形时间不能用于正负核对', async t => {
  const { r, s, m } = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '250' });
  m.override.set(PATHS.create, () => ok({}));
  const draft = await success(s, 'prepare_order', { storeId: shop, items: [
    { goodsId, quantity: 1 }, { goodsId, quantity: 2 }
  ] });
  await failure(s, 'place_order', argsFor(draft), /结果未知/);
  const at = bookRecords(r)[0].time;
  await r.restart();
  const again = await r.session();
  await bind(again);
  const candidate = { orderNo: number(42), userId: memberA, storeId: shop, orderAt: at,
    status: 50, actualAmount: 3000 };
  await delay(260);
  for (const conflicting of [
    { itemList: [{ itemName: '另一种茶', num: 3 }] },
    { itemList: [{ goodsId: '9999', itemName: '测试茶', num: 3 }] },
    { itemList: [{ goodsId, itemName: ['测试茶'], num: 3 }] },
    { itemList: [{ itemName: '测试茶', num: 2 }] },
    { itemList: [{ itemName: '测试茶', num: [3] }] },
    { itemList: [{ itemName: '测试茶' }] },
    { itemList: '商品列表格式错误' },
    { storeId: [shop] },
    { orderAt: [at] },
    { orderAt: [at - 86400000] }
  ]) {
    m.orders = [{ ...candidate, ...conflicting }];
    const list = await success(again, 'my_orders');
    assert.equal(list.unresolvedPendingWrites, 1);
    assert.equal(list.resolvedPendingWrites, undefined);
  }
  m.orders = [{ ...candidate, itemList: [{ goodsName: '测试茶', num: 3 }] }];
  const matched = await success(again, 'my_orders');
  assert.equal(matched.resolvedPendingWrites, 1);
  const [record] = bookRecords(r);
  const writes = (await readFile(join(r.logDir,'write.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const audit = writes.find(row => row.outcome === 'resolved');
  assert.equal(audit.requestKey,record.key);
  assert.equal(audit.quotaDate,record.day);
  assert.equal(audit.orderNo,number(42));
  assert.deepEqual(matched.orders[0].items, ['测试茶 ×3']);
});

test('PRE-11 自动认领与停服人工裁决均按发出时刻提醒再下单', async t => {
  const { r, s, m } = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '60000' });
  m.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  const first = bookRecords(r)[0];
  await delay(1100);
  m.orders = [{ orderNo: number(91), userId: memberA, orderAt: first.time }];
  assert.equal((await success(s, 'my_orders')).resolvedPendingWrites, 1);
  const next = await prepare(s);
  assert.equal(next.recentOrder.orderNo, number(91));
  assert.equal(next.recentOrder.orderTime, beijingTime(first.time));
  assert.equal(next.recentOrder.estimatedTotalYuan, '20.00');
  await failure(s, 'place_order', argsFor(next), /结果未知/);
  const second = bookRecords(r).at(-1);
  await r.stop();
  await delay(1100);
  const cli = fileURLToPath(new URL('../server/ledger-cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'resolve', second.key, 'found', number(92), '门店确认'],
    { cwd: r.cwd, env: r.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  await r.start();
  const again = await r.session();
  await bind(again);
  const recent = (await prepare(again)).recentOrder;
  assert.equal(recent.orderNo, number(92));
  assert.equal(recent.orderTime, beijingTime(second.time));
  assert.equal(recent.estimatedTotalYuan, '20.00');
});

test('WRT-14 QRY-04 R23 占位文字不算订单号；列表逐行校验 12 至 40 位英数', async t => {
  const { r, s, m } = await withBound(t);
  m.override.set(PATHS.create, () => ok({ orderNo: 'N/A', payAmount: 20 }));
  const error = await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  assert.ok(!error.includes('N/A'));
  assert.equal(count(r, PATHS.orderDetail), 0);
  const at = Date.now();
  const bad = ['N/A', 'A'.repeat(11), 'B'.repeat(41), 'BAD-ORDER-01234', ' VALIDORDER001 ', ['VALIDORDER001']];
  const valid = ['a2345678901Z', 'B'.repeat(40)];
  m.orders = [...bad, ...valid].map(orderNo => ({ orderNo, userId: memberA, orderAt: at }));
  const list = await success(s, 'my_orders');
  assert.equal(list.count, 2);
  assert.deepEqual(list.orders.map(row => row.orderNo), valid);
  assert.equal(list.discardedNotOwned, bad.length);
  assert.equal(list.unresolvedPendingWrites, 1);
  assert.ok(!JSON.stringify(list).includes('N/A'));
  m.orders = [{ orderNo: 'N/A', userId: memberA, orderAt: at }];
  assert.equal((await success(s, 'my_orders')).unresolvedPendingWrites, 1);
});

test('QRY-04 R24 归属缺失与形态异常分别处理、商品名称按主备字段投影', async t => {
  const { s, m } = await withBound(t);
  const invalid = [null, [memberA], {}, '', 'bad', true, 0];
  m.orders = invalid.map((userId, i) => ({ orderNo: number(40 + i), userId }));
  m.orders.push(
    { orderNo: number(1), userId: memberB },
    { orderNo: number(2), itemList: [{ goodsName: '归属缺失商品' }] },
    { orderNo: number(3), userId: memberA, itemList: [
      { itemName: '主商品名', goodsName: '备选商品名', num: 1 }, { goodsName: '备选商品名', num: 2 }
    ] }
  );
  const list = await success(s, 'my_orders');
  assert.equal(list.discardedNotOwned, invalid.length + 1);
  assert.equal(list.unverifiedNotShown, 1);
  assert.equal(list.count, 1);
  assert.equal(list.orders[0].orderNo, number(3));
  assert.deepEqual(list.orders[0].items, ['主商品名', '备选商品名 ×2']);
});

test('QRY-04 两位会员各有一单，列表夹入缺少会员号的他人订单时整份出参只多计数和提示', async t => {
  const { r, s, m } = await withBound(t);
  const own = await place(s, await prepare(s));
  const clean = await success(s, 'my_orders');
  assert.equal(clean.count, 1);
  assert.deepEqual(clean.orders.map(row => row.orderNo), [own.orderNo]);
  assert.equal(clean.orders[0].unverified, undefined);
  assert.equal(clean.unverifiedNotShown, undefined);
  assert.equal(clean.unresolvedPendingWrites, undefined);
  assert.equal(clean.note, '只列出最近 7 天、最多 10 条本人订单。要看某一单的最新状态用 get_order_status。');

  const other = await r.session();
  await bind(other, 'FAKE_CARD_B', 'card');
  m.price = 3899;
  const placed = await place(other, await prepare(other));
  const foreign = m.orders.find(row => row.orderNo === placed.orderNo);
  assert.equal(foreign.userId, memberB);
  delete foreign.userId;
  foreign.status = 40;
  foreign.itemList = [{ itemName: '另一位会员的商品' }];

  const mixed = await success(s, 'my_orders');
  assert.deepEqual(mixed, {
    ...clean, unverifiedNotShown: 1,
    note: clean.note + '另有 1 条订单门店系统没标明属于哪位会员，没有展示；请在小程序「我的订单」里查看。'
  });
});

test('WRT-17 WRT-19 金额未知的券保留、类型未知保留不确定、零元告警只核对差额', async t => {
  const { s, m } = await withBound(t);
  m.price = 100;
  m.couponRows = [{ title: '测试券', userCouponCanDisAmount: 1, unUseStatus: 1 }];
  let discounts = [
    { discountName: '测试券', discountType: 2 },
    { discountName: '测试满减', discountType: 3, discountAmount: 100 }
  ];
  m.override.set(PATHS.orderDetail, () => ok({ ...m.last, actualAmount: 0, discountList: discounts }));
  const result = await place(s, await prepare(s));
  assert.deepEqual(result.couponApplied.items, [
    { name: '测试券', amountYuan: null, isCoupon: true },
    { name: '测试满减', amountYuan: '1.00', isCoupon: false }
  ]);
  assert.equal(result.couponApplied.matchesPrediction, true);
  assert.match(result.couponApplied.note, /与组单时告知的一致.*测试券（金额未知）/);
  assert.equal(result.warning, '金额与预估不一致：企迈实付 ¥0.00，本地预估 ¥1.00，差额 ¥-1.00。请先向顾客说清这个差额并核对。');
  assert.match(result.nextStep, /确认这一单的状态/);
  discounts = [{ discountName: '另一张券', discountType: 2, discountAmount: 100 }];
  const different = await place(s, await prepare(s));
  assert.equal(different.couponApplied.matchesPrediction, false);
  assert.doesNotMatch(different.couponApplied.note, /引导付款/);
  for (const typeFields of [{}, { discountType: 999 }, { discountType: [3] }]) {
    discounts = [{ discountName: '活动', discountAmount: 0, ...typeFields }];
    const receipt = await place(s, await prepare(s));
    assert.deepEqual(receipt.couponApplied.items, [{ name: '活动', amountYuan: '0.00' }]);
    assert.equal(receipt.couponApplied.matchesPrediction, undefined);
    assert.equal(receipt.couponApplied.note, '门店系统自动给了优惠：活动（抵 ¥0.00）。读回里看不出这是不是优惠券，请如实告知顾客有这笔优惠。');
  }
});

test('BND-02 R24 会员查询支持标量编号，未知形态报告查询失败并保留原绑定', async t => {
  const r = await setup(t, { LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR: '30' });
  const s = await r.session();
  let payload = 123456;
  r.mock.override.set(PATHS.member, () => ok(payload));
  const first = await bind(s);
  assert.equal(first.customerIdLast4, '***');
  payload = memberA;
  assert.equal((await bind(s)).customerIdLast4, '***1234');
  for (const shape of [{}, { id: memberA }, [memberA], true, null, { customerId: [memberA] }]) {
    payload = shape;
    await failure(s, 'bind_member', { code: phone, codeType: 'phone' }, /查询会员信息时出了点问题/);
  }
  payload = '0';
  await failure(s, 'bind_member', { code: phone, codeType: 'phone' }, /去微信搜/);
  assert.equal((await prepare(s)).member.via, 'phone');
});

test('LED-02 LED-06 逐个破坏已下单账本文件，单实例故障态与双实例唯一胜者仍可浏览查单', async t => {
  const {r,s} = await withBound(t);
  const receipt = await place(s,await prepare(s));
  const second = await secondInstance(t,r);
  await r.stop();
  const files = await readdir(r.dataDir,{withFileTypes:true});
  assert.ok(files.some(entry => entry.isFile()),'真实下单后应有持久化文件');
  async function checkFault(instance) {
    const customer = await instance.session();
    await bind(customer);
    assert.equal((await success(customer,'preview_order',basket)).ok,true);
    const list = await success(customer,'my_orders');
    assert.equal(list.orders[0].orderNo,receipt.orderNo);
    await failure(customer,'prepare_order',basket,/账本不可用/);
    assert.equal(count(r,PATHS.create),1);
  }
  for (const file of files.filter(entry => entry.isFile())) {
    await t.test(file.name, async subtest => {
      const directory = join(r.cwd,'damaged-' + file.name);
      subtest.after(() => Promise.all([r.stop(),second.stop()]));
      await cp(r.dataDir,directory,{recursive:true});
      const damaged = join(directory,file.name);
      await writeFile(damaged,'FAKE_CORRUPTED_LEDGER');
      r.env.LICHA_DATA_DIR = directory;
      await r.start();
      await checkFault(r);
      await r.stop();

      const {winner} = await raceForLedger(r,second,directory);
      await checkFault(winner);
    });
  }
});

test('LED-08 运维按固定字段列未决，R23 不合格单号及未知请求退出非零且账本不变',async t=>{
  const {r,s,m}=await withBound(t);
  m.override.set(PATHS.create,()=>ok({}));
  await failure(s,'place_order',argsFor(await prepare(s)),/结果未知/);
  const cli=fileURLToPath(new URL('../server/ledger-cli.js',import.meta.url));
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:r.cwd,env:r.env,encoding:'utf8'});
  const bytes=await readFile(bookFile(r));
  const [row]=bookRecords(r);
  const locked=run('list');
  assert.notEqual(locked.status,0);
  assert.match(locked.stderr,/其他实例/);
  await r.stop();
  const list=run('list');
  assert.equal(list.status,0,list.stderr);
  assert.deepEqual(JSON.parse(list.stdout),[{key:row.key,member:row.memberHash,storeId:row.storeId,
    requestedAt:beijingTime(row.time),estimatedFen:row.totalFen}]);
  for (const [key,no] of [[row.key,'N/A'],[row.key,'x'.repeat(11)],[row.key,'x'.repeat(41)],
    [row.key,'FAKE_ORDER_123456'],['FAKE_UNKNOWN_KEY',number(601)]]) {
    const attempt=run('resolve',key,'found',no,'模拟门店记录');
    assert.notEqual(attempt.status,0);
    assert.match(attempt.stderr,/订单号格式无效|没有这笔未决/);
    assert.deepEqual(await readFile(bookFile(r)),bytes);
  }
  assert.equal(run('resolve',row.key,'found','FAKEORDER0012','模拟门店记录').status,0);
  assert.deepEqual(JSON.parse(run('list').stdout),[]);
});

test('LED-02 LED-06 既有账本截为零字节仍能独占并保持故障态', async t => {
  const {r,s} = await withBound(t);
  await place(s,await prepare(s));
  await r.stop();
  const path = bookFile(r);
  await writeFile(path,'');
  await r.start();
  const customer = await r.session();
  await bind(customer);
  await failure(customer,'prepare_order',basket,/账本不可用/);
  assert.equal((await success(customer,'my_orders')).count,1);
  assert.equal(count(r,PATHS.create),1);
});

test('LED-06 账本目录不可写时启动失败，恢复写权限后可接管', {
  skip:process.platform === 'win32' || process.getuid?.() === 0
}, async t => {
  const {r,s} = await withBound(t);
  const receipt = await place(s,await prepare(s));
  await r.stop();
  await chmod(r.dataDir,0o500);
  try {
    await assert.rejects(r.start(),/服务启动失败.*独占/s);
  } finally {
    await r.stop();
    await chmod(r.dataDir,0o700);
  }
  await r.start();
  const resumed = await r.session();
  await bind(resumed);
  assert.equal((await prepare(resumed)).recentOrder.orderNo,receipt.orderNo);
});

test('WRT-05 复述金额多于两位小数时按契约拒绝，原令牌仍可用整数金额提交', async t => {
  const { r, s } = await withBound(t);
  const { confirmToken } = await prepare(s);
  const message = '复述金额要照待确认单上的金额，用两位小数（如 24.00）。请按待确认单的金额重新向顾客确认后再提交。';
  for (const raw of ['19.984999999999999999', '20.014999999999999999', '20.001', '1e-7']) {
    const result = await s.call('place_order', { confirmToken, confirmAmountYuan: JSON.rawJSON(raw) });
    assert.equal(result.isError, true, raw);
    assert.equal(result.content[0].text, message, raw);
    assert.equal(count(r, PATHS.create), 0);
  }
  await success(s, 'place_order', { confirmToken, confirmAmountYuan: 20 });
  assert.equal(count(r, PATHS.create), 1);
});

test('WRT-05 合格的一位与两位小数按整分比对，相差一分仍可提交', async t => {
  const { r, s, m } = await withBound(t);
  m.price = 29;
  for (const confirmAmountYuan of [0.3, 0.29, 0.28]) {
    const { confirmToken } = await prepare(s);
    await success(s, 'place_order', { confirmToken, confirmAmountYuan });
  }
  assert.equal(count(r, PATHS.create), 3);
});
