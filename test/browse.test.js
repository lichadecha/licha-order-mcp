import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {rig} from '../test-support/rig.js';
import {bind} from '../test-support/commerce.js';
import {Browse} from '../server/browse.js';
import {itemCard} from '../server/catalog.js';
import {PATHS, Qmai, parseResponse, sign} from '../server/qmai.js';

const good = data => ({status:true, code:0, data});
const digits = '8990000000000000123';
const skuId = '8991000000000000321';
const kind = key => key.replace(/^\//,'');
const product = (overrides = {}) => ({
  goodsId:digits, name:'测试奶茶', type:1, goodsSkuList:[{skuId, salePrice:2400, skuItemList:[{specValue:'1杯'}]}],
  sortedPracticeList:[{practiceName:'温度', practiceId:'8881234567899876543', isRequired:1,
    practiceValueList:[{practiceValueId:'8882222222222222222', practiceValue:'少冰', price:100},
      {practiceValueId:'8882222222222222223', practiceValue:'常温', price:0}]}],
  attachGoodsList:[{attachGoodsName:'测试椰果', attachGoodsId:'8883333333333333333', attachGoodsPrice:80}],
  labelList:[{text:'新款',type:1},{labelTypeText:'文字标签'},{text:'图片说明',type:2}],
  categoryList:[{categoryName:'茶奶'}], internalPrivate:'FAKE_PRIVATE_FIELD', ...overrides
});
async function invoke(session,name,args) {
  const message = await session.call(name,args);
  assert.ok(!message.isError, message.content[0].text);
  return JSON.parse(message.content[0].text);
}

test('BRW-01 BRW-02 BRW-03 门店匹配、采样和两路刷新', async t => {
  const shops = [
    {id:301,code:'02',name:'Ａ店',fullAddress:'幸福大厦',cityName:'测试市',openStatus:1,internal:'FAKE_PRIVATE_FIELD'},
    {id:302,code:'01',name:'B店',address:'东门',cityName:'测试市',openStatus:2}
  ];
  let detail = {openStatus:0, opentimes:[{opentime:[{worktime:[{time:['09:00','23:40']}],workweek:[1,2,3,4,5,6,7]}]}]};
  let details = 0, lists = 0;
  const r = await rig(t,{env:{LICHA_CACHE_STORES_MS:'2200',LICHA_CACHE_STORE_STATUS_MS:'1800'},upstream(path) {
    if (kind(path) === PATHS.stores) { lists++; return good({list:shops}); }
    assert.equal(kind(path), PATHS.storeStatus);
    details++;
    return good(detail);
  }});
  const s = await r.session();
  const find = query => invoke(s,'find_store',{query});
  assert.deepEqual((await find('测试市')).candidates.map(s => [s.shopCode,s.openStatusText]), [['01','繁忙'],['02','营业中']]);
  assert.equal(details,0);
  let a = (await find('a店')).store;
  assert.equal(a.openStatusText,'休息中');
  assert.equal(a.opentimes,'09:00-23:40（周一至周日）');
  assert.match(a.statusSampledAt,/\+08:00$/);
  assert.deepEqual((await find('幸福大厦')).store,a);
  assert.deepEqual((await find('０２')).store,a);
  assert.equal(details,1);
  assert.equal(lists,1);
  assert.deepEqual((await find('无此店')).candidates,[]);
  shops.push({id:303,code:'03',name:'新开店',openStatus:1});
  await sleep(2250);
  assert.equal((await find('新开店')).store.storeId,'303');
  detail = {opentimes:[], openStatus:null};
  assert.equal((await find('A店')).store.openStatusText,'营业中');
  const before = lists;
  await sleep(1850);
  shops[0].openStatus = false;
  assert.deepEqual((await find('A店')).store,{name:'Ａ店',storeId:'301',shopCode:'02',address:'',cityName:'测试市',openStatusText:'状态未知'});
  assert.equal((await find('a店')).store.openStatusText,'状态未知');
  assert.ok(lists >= before + 2);
  assert.equal((await find('东门')).store.storeId,'302');
});

test('BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID', async t => {
  const sample = product({goodsExtra:{goodsDesc:{desc:'配料只在卡片展示'}}});
  const entries = [
    sample, product({goodsId:'22',type:2}), product({goodsId:'23',status:20}),
    product({goodsId:'24',goodsSkuList:[{salePrice:null}]}), product({goodsId:'25',goodsSkuList:[{salePrice:false}]}),
    product({goodsId:'26',type:undefined, goodsSkuList:[{salePrice:'30',clearStatus:'0'},{clearStatus:0}]}),
    product({goodsId:'28',goodsSkuList:[],showPriceLow:1500}), product({goodsId:'29',goodsSkuList:[{salePrice:0}]})
  ];
  const r = await rig(t,{upstream(path,params,{raw}) {
    const p = kind(path);
    assert.deepEqual([params.storeId,params.saleType,params.saleChannel,params.appChannel],[301,1,3,1]);
    if (p === PATHS.categories) return good([
      {categoryName:'后排',frontCategoryId:'9'}, {categoryName:'A茶',frontCategoryId:digits,categorySort:1},
      {categoryName:'A茶系列',frontCategoryId:'3',categorySort:5}]);
    assert.deepEqual(params.includeProperties,['SKU','LABEL']);
    if (p === PATHS.categoryItems) {
      assert.match(raw,new RegExp('"frontCategoryId":\\s*'+digits+'[,}]'));
      return good(entries);
    }
    assert.equal(p,PATHS.search);
    return good(Array(20).fill(params.name === '隐藏品' ? entries[1] : sample));
  }});
  const s = await r.session();
  const menu = keyword => invoke(s,'get_menu',{storeId:'301',keyword});
  assert.deepEqual((await menu('   ')).categories.map(c=>c.categoryName), ['A茶','A茶系列','后排']);
  const result = await menu('Ａ茶系列');
  assert.equal(result.via,'category');
  assert.equal(result.categoryName,'A茶');
  assert.deepEqual(result.items.map(i=>i.goodsId),[digits,'26','28']);
  assert.equal(result.items[1].soldOut,true);
  assert.equal(Object.hasOwn(result.items[0],'soldOut'),false);
  assert.deepEqual(result.items[0].labels,['新款','文字标签']);
  assert.ok(!Object.hasOwn(result.items[0], 'description'));
  assert.equal(result.items[2].priceYuan,'15.00');
  assert.match(result.hint,/以 get_item_detail 点单卡片为准/);
  const search = await menu('测试');
  assert.match(search.hint,/前 20 条/);
  assert.ok(!Object.hasOwn(search.items[0], 'description'));
  assert.match((await menu('隐藏品')).hint,/^没找到/);
  assert.equal(r.requests.filter(x => kind(x.path) === PATHS.categories).length,1);
});

test('BRW-07 OUT-01 卡片投影、空值、估清优先级和商品一致性', async t => {
  let row = product({goodsSkuList:[
    {skuId, salePrice:null, inventory:null, skuName:'缺价'}, {skuId:'2',salePrice:' ',inventory:false,specName:'空白价'},
    {skuId:'3',salePrice:1000,inventory:'0'}, {skuId:'4',salePrice:2000,clearStatus:1,skuItemList:[{specValue:'大杯'}]}]});
  const r = await rig(t,{env:{LICHA_CACHE_ITEM_MS:'35'},upstream:()=>good([row])});
  const s = await r.session();
  const detail = () => invoke(s,'get_item_detail',{goodsId:digits,storeId:'301'});
  const card = await detail();
  assert.equal(card.available,true);
  assert.deepEqual(card.skus.map(s=>[s.specName,s.priceFen,s.priceYuan,s.stock,s.available]),[
    ['缺价',null,'价格待询',null,false], ['空白价',null,'价格待询',null,false],
    ['标准杯',1000,'10.00',0,false], ['大杯',2000,'20.00',null,true]]);
  assert.deepEqual(card.practices[0],{name:'温度',required:true,values:[
    {name:'少冰',priceFen:100,priceDeltaYuan:'+1.00'}, {name:'常温',priceFen:0,priceDeltaYuan:'+0'}]});
  assert.equal(card.attaches[0].priceYuan,'0.80');
  assert.equal(card.categoryName,'茶奶');
  assert.doesNotMatch(JSON.stringify(card),/FAKE_PRIVATE_FIELD|8881234567899876543|8883333333333333333/);
  for (const [patch,reason] of [
    [{status:20,goodsSkuList:[]},'已下架'], [{goodsSkuList:[{salePrice:false}]},'非售卖条目'],
    [{goodsSkuList:[{salePrice:1,clearStatus:0}]},'暂时估清，点不了']
  ]) {
    await sleep(45);
    row = product(patch);
    assert.equal((await detail()).unavailableReason,reason);
  }
  await sleep(45);
  row = product({goodsId:'7777'});
  const failed = await s.call('get_item_detail',{goodsId:digits, storeId:301});
  assert.equal(failed.isError,true);
  assert.match(failed.content[0].text,/商品不存在或已下架/);
  row = product();
  assert.equal((await detail()).goodsId,digits);
});

test('BRW-11 点单卡片请求描述并展示 11-24 样本中的配料、能量和杯量', async t => {
  // 摘自规格样本 3.1.12_getShopGoodsDetail_withGoodsDesc_composed_20261124，保留原始数字和商品描述。
  const sampleFile = '../test-support/item-description-20261124.json';
  const raw = await readFile(new URL(sampleFile, import.meta.url), 'utf8');
  const r = await rig(t, {upstream(path, params, {res}) { res.end(raw); }});
  const s = await r.session();
  const card = await invoke(s, 'get_item_detail', {storeId:301, goodsId:'1288634197238501377'});
  const [request] = r.requests;
  assert.equal(request.path, PATHS.item);
  assert.deepEqual(request.params.includeProperties, ['SKU','PRACTICE','ATTACH','LABEL','CATEGORY']);
  assert.deepEqual(request.params.includeExtras, ['GOODS_DESC']);
  assert.deepEqual(card.description, {
    summary:'红富士苹果 | 岩冠大红袍',
    detail:'配料：HPP红富士苹果/岩冠大红袍；因采用HPP冷压鲜榨，产品会有沉淀，喝前请搅拌。为保证口感，本品不可去冰。' +
      '；能量（冰）：不另外加糖≈95kcal, 30%L阿拉伯糖≈136kcal；能量（热）：不另外加糖=74kcal, 30%L阿拉伯糖=115kcal' +
      '；茶多酚：■■■□□；规格：冰420ml，热350ml'
  });
});

test('BRW-11 OUT-02 描述只投影非空字段，去掉网址、凭证并遮盖长号码', () => {
  const cases = [
    [{desc:'<b>苹果</b> &amp; 茶'}, {summary:'苹果 & 茶'}],
    [{detail:'<p>杯量&nbsp; 420ml</p><p>联系+8613800000000，编号1234567890123456789</p>'},
      {detail:'杯量 420ml；联系***0000，编号***6789'}],
    [{desc:'配料 https://example.invalid/hidden 茶', detail:'无糖 appSECRET：FAKE_REDACT_ME 热饮'},
      {summary:'配料 茶', detail:'无糖 热饮'}],
    [{desc:'<p>&nbsp;</p>', detail:' \t\n '}, undefined],
    [{desc:'https://example.invalid/hidden', detail:'AppToken=FAKE_REDACT_ME'}, undefined],
    [{desc:123, detail:null}, undefined],
    [undefined, undefined]
  ];
  for (const [goodsDesc, expected] of cases) {
    const card = itemCard(product({goodsExtra:{goodsDesc}}));
    if (expected) assert.deepEqual(card.description, expected);
    else assert.ok(!Object.hasOwn(card, 'description'));
  }
});

test('BRW-11 短描述与长说明各按 Unicode 码点计数，恰好到上限时保留原文', () => {
  const summary = '🍎'.repeat(60), detail = '🍵'.repeat(400);
  for (const extra of ['', '多一字']) {
    const goodsDesc = {desc:summary + extra, detail:detail + extra};
    const projected = itemCard(product({goodsExtra:{goodsDesc}})).description;
    const suffix = extra ? '…' : '';
    assert.deepEqual(projected, {summary:summary + suffix, detail:detail + suffix});
  }
});

test('BRW-08 逐行算价、同名做法及缺价规格', async t => {
  const row = product();
  row.goodsSkuList.push({skuId:'2',salePrice:''},{skuId:'3',salePrice:2000,inventory:0},{skuId:'4',salePrice:2200});
  row.sortedPracticeList.push({practiceName:'糖度',practiceValueList:[{practiceValue:'少冰'}]});
  const r = await rig(t,{upstream:()=>good([row])});
  const s = await r.session();
  const item = {goodsId:digits,skuId,quantity:2, practices:['温度：少冰'], attaches:['测试椰果','测试椰果']};
  const preview = items => invoke(s,'preview_order',{storeId:301, items});
  const ok = await preview([item,{...item,skuId:'4',quantity:1,practices:[],attaches:[]}]);
  assert.deepEqual(ok.lines.map(l=>[l.quantity,l.unitPriceYuan,l.lineTotalYuan]),[[2,'26.60','53.20'],[1,'22.00','22.00']]);
  assert.deepEqual(ok.lines[0].practices,['少冰']);
  assert.equal(ok.totalYuan,'75.20');
  for (const [patch,expected] of [
    [{skuId:undefined},/4 个规格/],[{skuId:'2'},/暂时没有价格/],[{skuId:'3'},/暂时估清/],[{skuId:'999'},/没有这个规格/],
    [{practices:['少冰']},/在「温度」「糖度」里都有/],[{practices:['温度:少冰','常温']},/只能选一个/],
    [{practices:['少冰 ']},/没有.*这个做法/],[{attaches:['双倍椰果']},/没有.*这个加料/]
  ]) {
    const result = await preview([item,{...item,...patch}]);
    assert.equal(result.ok,false);
    assert.equal(result.error.code,'PREVIEW_INVALID');
    assert.match(result.error.message, expected);
    assert.equal(result.lines,undefined);
  }
});

test('BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照', async t => {
  let reads = 0, row = product();
  const member = '8999999999999909001', orderNo = 'D00000000000000000901';
  const r = await rig(t,{mockSms:true,env:{LICHA_MAX_ORDER_AMOUNT_FEN:'10000'},upstream(path,params,{res}) {
    switch (kind(path)) {
      case PATHS.member: return good({customerId:member});
      case PATHS.item:
        reads++;
        return good([{...row, goodsExtra:params.includeExtras?.includes('GOODS_DESC') ? row.goodsExtra : null}]);
      case PATHS.stores: return good({list:[{id:301,code:'01',name:'试验店'}]});
      case PATHS.coupons: return good([]);
      case PATHS.create: return good({orderNo});
      case PATHS.orderDetail: return good({orderNo,userId:member,actualAmount:10000,discountAmount:0});
      default: res.statusCode = 400; res.end();
    }
  }});
  const s = await r.session();
  const item = {goodsId:digits,quantity:1,practices:['少冰'],attaches:['测试椰果','测试椰果']};
  const args = {storeId:301,items:[item,item]};
  const detail = () => invoke(s,'get_item_detail',{storeId:301,goodsId:digits});
  const prepare = () => s.call('prepare_order',args);
  await bind(s);
  assert.equal((await detail()).skus[0].priceFen,2400);
  row.goodsSkuList[0].salePrice = 4740;
  const draft = await invoke(s,'prepare_order',args);
  assert.equal(draft.estimatedTotalYuan,'100.00');
  assert.equal(reads,2);
  const couponRequest = r.requests.find(x => kind(x.path) === PATHS.coupons);
  assert.deepEqual(couponRequest.params.tradeMarks,Array(2).fill({tradeMark:digits,num:1,price:50}));
  assert.ok(couponRequest.raw.includes('"customerId":'+member));
  row.goodsSkuList[0].salePrice = 4741;
  row.goodsExtra = {goodsDesc:{desc:'新配料说明'}};
  const overLimit = await prepare();
  assert.equal(overLimit.isError,true);
  assert.equal(overLimit.content[0].text,'单笔金额超上限：本单预估 ¥100.02，上限 ¥100.00。请减少商品后重新组单。');
  const refreshed = await detail();
  assert.equal(refreshed.skus[0].priceFen,4741);
  assert.deepEqual(refreshed.description, {summary:'新配料说明'});
  assert.equal(reads,3);
  row = product();
  const missing = await s.call('prepare_order',{...args,items:[{...item,practices:[]}]});
  assert.match(missing.content[0].text,/必选做法没选：温度（可选：少冰 \/ 常温）/);
  for (const [obj,key,label] of [
    [row.goodsSkuList[0],'skuId','规格'], [row.sortedPracticeList[0],'practiceId','做法'],
    [row.sortedPracticeList[0].practiceValueList[0],'practiceValueId','做法'],
    [row.attachGoodsList[0],'attachGoodsId','加料']
  ]) {
    const saved = obj[key];
    delete obj[key];
    const fail = await prepare();
    assert.equal(fail.isError,true);
    assert.match(fail.content[0].text,new RegExp(label + '.*缺少下单所需的信息'));
    obj[key] = saved;
  }
  await invoke(s,'place_order',{confirmToken:draft.confirmToken, confirmAmountYuan:100});
  const create = r.requests.find(x=>kind(x.path) === PATHS.create);
  const expected = {goodsId:digits, skuId, num:1,
    practiceList:[{id:'8881234567899876543', name:'温度', value:'少冰', valueId:'8882222222222222222', price:100}],
    attachList:[{id:'8883333333333333333', name:'测试椰果', price:80,num:2}]};
  assert.deepEqual(create.params.items,[expected,expected]);
  for (const value of [digits,skuId,member,expected.practiceList[0].id,expected.practiceList[0].valueId,expected.attachList[0].id]) {
    assert.ok(create.raw.includes(':'+value));
    assert.ok(!create.raw.includes('"'+value+'"'));
  }
});

test('BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应', async t => {
  const key = 'FAKE_RETRY_SIGNING_KEY';
  let behavior = 'recover', calls = 0;
  const r = await rig(t,{env:{QMAI_OPEN_KEY:'go-keyring-base64:'+Buffer.from(key).toString('base64'),
    LICHA_READ_TIMEOUT_MS:'110', LICHA_READ_BACKOFF_MS:'25,35'},
  upstream(path,params,{body,req,res}) {
    calls++;
    assert.equal(body.token,sign(key,body));
    if (behavior === 'recover' && calls === 1) { res.statusCode = 503; res.end(); }
    else if (behavior === 'recover' && calls === 2 || behavior === 'malformed') res.end('{"data":');
    else if (behavior === 'timeout') return undefined;
    else if (behavior === 'disconnect') req.socket.destroy();
    else if (behavior === 'business') return {status:false,code:110004,
      message:'验签  FAKE_OPEN_KEY=FAKE_REDACT_ME  https://example.invalid/hidden  测试13800000000号  '+ '🍵'.repeat(100)};
    else if (behavior === 'recover') {
      res.end('{"status":true,"data":[{"categoryName":"测试","frontCategoryId":'+digits+'}]}');
    }
  }});
  const s = await r.session();
  const menu = storeId => s.call('get_menu',{storeId});
  const fixed = await menu(1);
  assert.ok(!fixed.isError, fixed.content[0].text);
  assert.equal(JSON.parse(fixed.content[0].text).categories[0].frontCategoryId,digits);
  assert.equal(calls,3);
  const [one,two,three] = r.requests;
  assert.equal(new Set(r.requests.map(x=>x.body.token)).size,3);
  assert.ok(two.at-one.at>=25 && three.at-two.at>=35);
  assert.equal(one.body.openId,'FAKE_OPEN_ID');
  assert.ok(Math.abs(one.body.timestamp - one.at/1000) < 2);
  for (const mode of ['malformed','timeout','disconnect','business']) {
    behavior = mode;
    calls = 0;
    const response = await menu(2);
    assert.equal(response.isError,true);
    assert.equal(calls,mode === 'business' ? 1 : 3);
    const message = response.content[0].text;
    if (mode === 'timeout') assert.match(message,/门店系统这会儿反应慢，刚才那一步没查到结果/);
    else if (mode === 'business') {
      assert.match(message,/\*\*\*0000/);
      assert.match(message,/…（验签失败，检查凭证配置）/);
      assert.doesNotMatch(message,/FAKE_REDACT_ME|13800000000|https:\/\/|hidden/);
    } else assert.match(message,/网络异常/);
  }
});

test('BRW-10 五种浏览查询收到 HTTP 200 坏 JSON 都共试三次并给出网络提示', async t => {
  const storeId = 301;
  const r = await rig(t,{upstream(path,params,{res}) {
    if (path === PATHS.categories && params.storeId === storeId) {
      return good([{frontCategoryId:1,categoryName:'奶茶'}]);
    }
    res.end('{"data":');
  }});
  const s = await r.session();
  for (const [path,tool,args,label] of [
    [PATHS.stores,'find_store',{query:'测试'},'门店列表拉取失败'],
    [PATHS.categories,'get_menu',{storeId:302},'分类菜单拉取失败'],
    [PATHS.categoryItems,'get_menu',{storeId,keyword:'奶茶'},'按分类查商品失败'],
    [PATHS.search,'get_menu',{storeId,keyword:'椰果'},'搜索失败'],
    [PATHS.item,'get_item_detail',{storeId,goodsId:digits},'商品详情查询失败']
  ]) {
    const start = r.requests.length;
    const result = await s.call(tool,args);
    assert.equal(result.isError,true);
    assert.equal(r.requests.slice(start).filter(req => req.path === path).length,3,label);
    assert.equal(result.content[0].text,`${label}：未知错误（网络异常，稍后再试）`);
  }
});

test('UPS-02 全局队列按实际发送时刻限速、慢响应可并行', async t => {
  let release, notified;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { notified = resolve; });
  const r = await rig(t,{env:{LICHA_UPSTREAM_MIN_INTERVAL_MS:'70',LICHA_READ_TIMEOUT_MS:'2200'},
    upstream:async (path,params) => {
      if (params.storeId === 11) { notified(); await held; }
      return good([]);
    }});
  t.after(release);
  const sessions = await Promise.all([r.session(),r.session(),r.session()]);
  const first = sessions[0].call('get_menu',{storeId:11});
  await started;
  const rest = await Promise.all(sessions.slice(1).map((s,i)=>s.call('get_menu',{storeId:i+12})));
  assert.ok(rest.every(result=>!result.isError));
  release();
  assert.ok(!(await first).isError);
  assert.equal(r.requests.length,3);
  for (let i=1; i<3; i++) {
    // 线上的到达时间包含 TCP 交付与另一进程调度的少量抖动。
    assert.ok(r.requests[i].at-r.requests[i-1].at >= 68);
  }
});

test('ORD-02 ORD-03 出口白名单与未知路径发前拒绝', async t => {
  const r = await rig(t);
  for (const ordering of [false,true]) {
    const api = new Qmai({...r.env,LICHA_ENABLE_ORDERING:ordering},()=>{});
    assert.throws(()=>api.read(PATHS.create,{}),/读出口/);
    assert.throws(()=>api.read('v3/unknown',{}),/读出口/);
    for (const path of ['v3/crm/points/getCustomerPoints', 'v3/crm/customer/getLevelExperience']) {
      assert.throws(()=>api.read(path + '/other',{}),/读出口/);
      assert.throws(()=>api.write(path,{}),/写出口/);
      await assert.rejects(api.sms(path,{}),/短信出口/);
    }
    assert.throws(()=>api.write(PATHS.stores,{}),/写出口/);
    assert.throws(()=>api.write('v3/unknown',{}),/写出口/);
    if (!ordering) assert.throws(()=>api.write(PATHS.create,{}),/写出口/);
  }
  assert.equal(r.requests.length,0);
});

test('UPS-01 R4 响应数组、嵌套字段与字符串中的数字保持无损', () => {
  const value = parseResponse('{"n":[123456789012345,1,-8888888888888888888],"s":"123456789012345 \\"x\\"","d":-0.125,"exp":1.5e2}');
  assert.deepEqual(value,{n:['123456789012345',1,'-8888888888888888888'],s:'123456789012345 "x"',d:-0.125,exp:150});
  assert.throws(()=>parseResponse('{"n":001}'));
});

test('UPS-04 签名实现损坏时真实启动拒绝就绪', async t => {
  const code = "import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';" +
    "crypto.createHmac=()=>({update(){return this},digest(){return 'FAKE_BAD_SIGNATURE'}});syncBuiltinESMExports();";
  const hook = 'data:text/javascript,'+encodeURIComponent(code);
  await assert.rejects(rig(t,{env:{NODE_OPTIONS:'--import='+hook}}),/企迈签名自检失败/);
});

test('BRW-09 PRE-03 同毫秒开始的旧浏览响应晚到，保留组单现读缓存', async t => {
  const began = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(()=>release.resolve());
  let reads = 0;
  const preload = "const fixed=Date.now(); Date.now=()=>fixed;";
  const hook = 'data:text/javascript;base64,'+Buffer.from(preload).toString('base64');
  const r = await rig(t,{mockSms:true,env:{NODE_OPTIONS:'--import='+hook,LICHA_READ_TIMEOUT_MS:'5000'},async upstream(path) {
    if (path === PATHS.member) return good({customerId:'8900000000000000001'});
    if (path === PATHS.stores) return good({list:[]});
    assert.equal(path,PATHS.item);
    const price = ++reads === 1 ? 2000 : 3300;
    if (reads === 1) { began.resolve(); await release.promise; }
    return good([product({goodsSkuList:[{skuId,salePrice:price}],sortedPracticeList:[]})]);
  }});
  const [reader,buyer] = await Promise.all([r.session(),r.session()]);
  await bind(buyer);
  const details = () => invoke(reader,'get_item_detail',{storeId:301,goodsId:digits});
  const old = details();
  await began.promise;
  const draft = await invoke(buyer,'prepare_order',{storeId:301,items:[{goodsId:digits,quantity:1}]});
  assert.equal(draft.estimatedTotalYuan,'33.00');
  release.resolve();
  assert.equal((await old).skus[0].priceFen,2000);
  assert.equal((await details()).skus[0].priceFen,3300);
  assert.equal(reads,2);
});

test('OUT-01 BRW-07 畸形公开 ID 字段不能携出无关的识别值', async t => {
  const badId = 'FAKE_CARD_IN_WRONG_FIELD';
  const r = await rig(t,{upstream(path) {
    if (path === PATHS.categories) return good([
      {categoryName:'有效',frontCategoryId:digits},{categoryName:'异常',frontCategoryId:badId}]);
    if (path === PATHS.categoryItems) return good([product({goodsId:badId}),product()]);
    return good([product({goodsSkuList:[{skuId:badId,salePrice:2400}]})]);
  }});
  const s = await r.session();
  const categories = await invoke(s,'get_menu',{storeId:301});
  assert.deepEqual(categories.categories,[{categoryName:'有效',frontCategoryId:digits}]);
  const menu = await invoke(s,'get_menu',{storeId:301,keyword:'有效'});
  assert.deepEqual(menu.items.map(row=>row.goodsId),[digits]);
  const detail = await invoke(s,'get_item_detail',{storeId:301,goodsId:digits});
  assert.equal(detail.skus[0].skuId,'');
  assert.ok(!JSON.stringify(detail).includes(badId));
});

test('BRW-04 BRW-08 错形分类不缓存；算价失败只给一次商品原因', async t => {
  let categories = 0;
  const r = await rig(t,{upstream(path,params) {
    if (path === PATHS.categories) return good(++categories === 1 ? {records:[]} : [{frontCategoryId:1,categoryName:'奶茶'}]);
    if (path === PATHS.stores || path === PATHS.categoryItems || (path === PATHS.search && params.name === '错形')) return good({});
    if (path === PATHS.item) {
      const goodsId = String(params.goodsIds[0]);
      if (goodsId === '2' || goodsId === '3') return good([product({goodsId, goodsSkuList:[], status:goodsId === '3' ? 20 : 10})]);
      return good({0:product()});
    }
    return {status:false,code:999,message:'测试异常'};
  }});
  const s = await r.session();
  const first = await s.call('get_menu',{storeId:301});
  assert.equal(first.isError,true);
  assert.equal(first.content[0].text,'分类菜单拉取失败：未知错误（网络异常，稍后再试）');
  assert.deepEqual((await invoke(s,'get_menu',{storeId:301})).categories,[{frontCategoryId:'1',categoryName:'奶茶'}]);
  const category = await s.call('get_menu',{storeId:301,keyword:'奶茶'});
  assert.equal(category.content[0].text,'按分类查商品失败：未知错误');
  const stores = await s.call('find_store',{query:'测试'});
  assert.equal(stores.content[0].text,'门店列表拉取失败：未知错误（网络异常，稍后再试）');
  const malformedSearch = await s.call('get_menu',{storeId:301,keyword:'错形'});
  assert.equal(malformedSearch.content[0].text,'搜索失败：未知错误（网络异常，稍后再试）');
  const search = await s.call('get_menu',{storeId:301,keyword:'测试'});
  assert.equal(search.content[0].text,'搜索失败：测试异常（接口暂时异常，换个问法试试）');
  const preview = await invoke(s,'preview_order',{storeId:301,items:[{goodsId:digits,quantity:1}]});
  assert.deepEqual(preview.error,{code:'PREVIEW_INVALID', message:'商品查询失败：商品不存在或已下架',hint:'换个商品试试'});
  for (const [goodsId,reason] of [['2','没有可用规格'],['3','已下架']]) {
    const result = await invoke(s,'preview_order',{storeId:301,items:[{goodsId,quantity:1}]});
    assert.deepEqual(result.error,{code:'PREVIEW_INVALID',message:`「测试奶茶」${reason}`,hint:'换一款试试'});
  }
});

test('UPS-01 R21 损坏的密钥封装不作为普通字符串签名', () => {
  assert.throws(()=>new Qmai({QMAI_OPEN_KEY:'go-keyring-base64:FAKE$BAD#ENCODED'},()=>{}),
    e=>e.message === '配置无效：QMAI_OPEN_KEY');
});

test('BRW-04 分类商品失败保留前缀，业务拒绝给原因，超时、断连和 HTTP 错误给对应提示', async () => {
  for (const [kind,message,expected,statusCode] of [
    ['business','分类不可用','按分类查商品失败：分类不可用'],
    ['timeout','','按分类查商品失败：未知错误（门店系统这会儿反应慢，刚才那一步没查到结果，稍等几秒我再帮你问一次。）'],
    ['network','','按分类查商品失败：未知错误（网络异常，稍后再试）'],
    ['http','HTTP 503','按分类查商品失败：未知错误（网络异常，稍后再试）',503],
    ['http','HTTP 400','按分类查商品失败：未知错误',400]
  ]) {
    const browse = new Browse({LICHA_CACHE_CATEGORIES_MS:1000}, {async read(path) {
      if (path === PATHS.categories) return [{frontCategoryId:1,categoryName:'奶茶'}];
      assert.equal(path,PATHS.categoryItems);
      throw Object.assign(new Error(message), {kind,statusCode});
    }});
    await assert.rejects(browse.call('get_menu',{storeId:301,keyword:'奶茶'}), {message:expected});
  }
});

test('BRW-08 PRE-06 加料原文、展示同名和做法双重解释都核对至创建请求',async t => {
  const orderNo = 'D00000000000000008765', member = '8999000000000000123';
  const variants = [['单空格','桂花 蜜'], ['双空格','桂花  蜜'], ['首尾空白',' 桂花 蜜 ']];
  const row = product({
    sortedPracticeList: [
      {practiceName:'糖度',practiceId:'101',practiceValueList:[{practiceValue:'少糖',practiceValueId:'201',price:10}]},
      {practiceName:'其他',practiceId:'102',practiceValueList:[{practiceValue:'糖度：少糖',practiceValueId:'202',price:50}]},
      {practiceName:'装饰',practiceId:'103',practiceValueList:[
        {practiceValue:'加花',practiceValueId:'203',price:80},{practiceValue:'加花',practiceValueId:'204',price:40}]},
      {practiceName:'香型',practiceId:'104',practiceValueList:variants.map(([,name],i) => ({
        practiceValue:name,practiceValueId:String(205+i),price:10*i
      }))}
    ],
    attachGoodsList:[
      ...variants.map(([,name],i) => ({attachGoodsName:name,attachGoodsId:String(310+i),attachGoodsPrice:20*i})),
      {attachGoodsName:'芒果  粒',attachGoodsId:'303',attachGoodsPrice:40}
    ]
  });
  const r = await rig(t,{mockSms:true,upstream(path) {
    switch (path) {
      case PATHS.item: return good([row]);
      case PATHS.member: return good({customerId:member});
      case PATHS.stores: return good({list:[{id:301,code:'',name:'模拟门店'}]});
      case PATHS.create: return good({orderNo});
      case PATHS.orderDetail: return good({orderNo,userId:member,actualAmount:2490,discountAmount:0});
      default: return {status:false};
    }
  }});
  const s = await r.session();
  await bind(s);
  const basket = (practices,attaches) => ({storeId:301,items:[{goodsId:digits,quantity:1,practices,attaches}]});
  for (const [label,name] of variants) {
    await t.test(label,async () => {
      for (const args of [basket([], [name]), basket([name], []), basket(['香型：'+name], [])]) {
        const preview = await invoke(s,'preview_order',args);
        assert.equal(preview.ok,false);
        assert.match(preview.error.message,/没法确定/);
        assert.equal(preview.lines,undefined);

        const failed = await s.call('prepare_order',args);
        assert.equal(failed.isError,true);
        assert.match(failed.content[0].text,/没法确定/);
        assert.doesNotMatch(failed.content[0].text,/confirmToken/);
      }
      assert.equal(r.requests.filter(req=>req.path===PATHS.create).length,0);
    });
  }
  for (const [practices,attaches,reason] of [
    [['糖度：少糖'],[],/没法确定/],
    [['装饰：加花'],[],/没法确定/],
    [[],['芒果 粒'],/没有.*加料/]
  ]) {
    const args = basket(practices,attaches);
    const preview = await invoke(s,'preview_order',args);
    assert.equal(preview.ok,false);
    assert.match(preview.error.message,reason);
    const failed = await s.call('prepare_order',args);
    assert.equal(failed.isError,true);
    assert.match(failed.content[0].text,reason);
  }
  assert.equal(r.requests.filter(r=>r.path===PATHS.create).length,0);
  const exact = basket(['其他：糖度：少糖'],['芒果  粒']);
  assert.equal((await invoke(s,'preview_order',exact)).totalYuan,'24.90');
  const draft = await invoke(s,'prepare_order',exact);
  assert.equal(draft.estimatedTotalYuan,'24.90');
  assert.equal(draft.supersededPendingOrders,undefined);
  await invoke(s,'place_order',{confirmToken:draft.confirmToken,confirmAmountYuan:24.90});
  const [line] = r.requests.find(req=>req.path===PATHS.create).params.items;
  assert.deepEqual(line.practiceList,[{id:102,valueId:202,name:'其他',value:'糖度：少糖',price:50}]);
  assert.deepEqual(line.attachList,[{id:303,name:'芒果  粒',price:40,num:1}]);
  row.goodsSkuList.push({skuId,salePrice:1000,specName:'另一规格'});
  const duplicateSku = basket([],[]);
  duplicateSku.items[0].skuId = skuId;
  const rejected = await s.call('prepare_order',duplicateSku);
  assert.equal(rejected.isError,true);
  assert.match(rejected.content[0].text,/多个规格使用同一编号/);
});

test('BRW-03 BRW-04 R24 营业时间内层复数和菜单布尔标记',async t => {
  const r = await rig(t,{upstream(path){
    switch(path) {
      case PATHS.stores: return good({list:[{id:301,name:'模拟店'}]});
      case PATHS.storeStatus: return good({openStatus:1,opentimes:[
        {opentimes:[{worktime:[{time:['10:00','17:00']}],workweek:[1,3,5]}]}]});
      case PATHS.categories: return good([]);
      case PATHS.search: return good([product({isAttach:true,isPractice:true}),product({goodsId:'303',isAttach:false,isPractice:false})]);
      default: return {status:false};
    }
  }});
  const s = await r.session();
  assert.equal((await invoke(s,'find_store',{query:'模拟店'})).store.opentimes,'10:00-17:00（周1、3、5）');
  const {items} = await invoke(s,'get_menu',{storeId:301,keyword:'茶'});
  assert.deepEqual(items.map(i=>[i.hasAttach,i.hasPractice]),[[true,true],[false,false]]);
});
