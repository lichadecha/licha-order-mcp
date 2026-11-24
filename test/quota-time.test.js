import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {rig} from '../test-support/rig.js';
import {bind as bindPhone, bookRecords} from '../test-support/commerce.js';
import {PATHS} from '../server/qmai.js';

const good = data => ({status:true,code:0,data});
const order = {storeId:601,items:[{goodsId:'10001',quantity:1}]};
async function value(result) {
  const x = await result;
  assert.ok(!x.isError,x.content[0].text);
  return JSON.parse(x.content[0].text);
}
async function bind(r,code) {
  const session = await r.session();
  await bindPhone(session, '13800000' + code);
  return session;
}
const prepare = s => value(s.call('prepare_order',order));
const place = (s,draft) => s.call('place_order',{confirmToken:draft.confirmToken,confirmAmountYuan:1});
function mockUpstream(onCreate) {
  return async (path,params,wire) => {
    switch(path) {
      case PATHS.member: return good({customerId:'9100000000000000'+params.customerCode.code.slice(-3)});
      case PATHS.item: return good([{goodsId:'10001',name:'测试茶',goodsSkuList:[{skuId:'902',salePrice:100}]}]);
      case PATHS.categories: return good([]);
      case PATHS.stores: return good({list:[{id:601,code:'',name:'测试店'}]});
      case PATHS.create: return onCreate(params,wire);
      case PATHS.orderDetail: return good({orderNo:params.orderNo,userId:params.userId,actualAmount:100,discountAmount:0});
      default: return {status:false,message:'测试不支持此接口'};
    }
  };
}

test('WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日', {timeout:30000}, async t => {
  const clockDir = await mkdtemp(join(tmpdir(),'licha-quota-clock-'));
  t.after(()=>rm(clockDir,{recursive:true,force:true}));
  const offset = join(clockDir,'offset');
  const midnight = Date.parse('2031-02-08T00:00:00+08:00');
  const setClock = async ms => {
    await writeFile(offset+'.next',String(ms));
    await rename(offset+'.next',offset);
  };
  await setClock(midnight - 15000);
  // 固定子进程的日历时钟，定时器、排队、落盘、网络仍使用真实时间。
  const preload = "import {readFileSync} from 'node:fs';" +
    "Date.now=()=>Number(readFileSync("+JSON.stringify(offset)+",'utf8'));";
  const hook = 'data:text/javascript;base64,'+Buffer.from(preload).toString('base64');
  const created = [];
  const firstReceived = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(()=>release.resolve());
  const r = await rig(t,{mockSms:true,env:{NODE_OPTIONS:'--import='+hook,LICHA_MAX_ORDERS_PER_DAY:'1',
    LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1', LICHA_UPSTREAM_MIN_INTERVAL_MS:'720', LICHA_WRITE_TIMEOUT_MS:'6000'},
    upstream:mockUpstream(async params => {
      const n = created.push(params);
      if (n === 1) { firstReceived.resolve(); await release.promise; }
      return good({orderNo:'D'+String(n).padStart(20,'0')});
    })});
  const customers = await Promise.all(['001','002'].map(code=>bind(r,code)));
  const drafts = await Promise.all(customers.map(prepare));
  await setClock(midnight - 380);
  const attempts = customers.map((s,i)=>place(s,drafts[i]));
  const early = await Promise.race(attempts.map((promise,i)=>promise.then(result=>({result,i}))));
  assert.match(early.result.content[0].text,/总单量已到上限/);
  // 两次 WRT-22 均已完成，输家被当日额度拦下；让赢家在次日真正发出。
  await setClock(midnight);
  await firstReceived.promise;
  const [sent] = bookRecords(r);
  assert.equal(sent.day,'2031-02-07');
  assert.ok(sent.time >= midnight,JSON.stringify(sent));
  assert.equal(sent.state,'sent');
  release.resolve();
  const results = await Promise.all(attempts);
  const winner = 1 - early.i;
  assert.equal((await value(results[winner])).placed,true);
  // 昨天被拒没有消耗令牌或名额；新一天仍有完整额度。
  assert.equal((await value(place(customers[early.i],drafts[early.i]))).placed,true);
  assert.deepEqual(bookRecords(r).map(row=>[row.day,row.state]),
    [['2031-02-07','success'],['2031-02-08','success']]);
  assert.equal(created.length,2);
  const audit = (await readFile(join(r.logDir,'write.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for (const outcome of ['sending','success']) {
    const entry = audit.find(row => row.outcome === outcome && row.tokenId === drafts[winner].confirmToken);
    assert.equal(entry.quotaDate,'2031-02-07');
    assert.equal(entry.date,'2031-02-08');
    assert.ok(entry.time.startsWith('2031-02-08'));
    assert.equal(entry.requestKey,sent.key);
    assert.equal(entry.dedupKey,sent.key);
    if (outcome === 'success') assert.equal(entry.orderNo,'D00000000000000000001');
  }
  assert.equal(audit.find(row => row.reason === 'WRT-09_global').quotaDate,undefined);
});

test('WRT-11 等待实际发送名额超时，无发单记录且个人、全局占位都释放', async t => {
  const interval = 430;
  const readStarted = Promise.withResolvers();
  const recheckReceived = Promise.withResolvers(), release = Promise.withResolvers();
  let holdRecheck = false;
  const upstream = mockUpstream(()=>good({orderNo:'D00000000000000000911'}));
  const r = await rig(t,{mockSms:true,env:{LICHA_UPSTREAM_MIN_INTERVAL_MS:String(interval),LICHA_WRITE_TIMEOUT_MS:'650',
    LICHA_READ_TIMEOUT_MS:'5000',LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1',LICHA_MAX_ORDERS_PER_DAY:'1'},
    async upstream(path, params, wire) {
      if (path === PATHS.member && holdRecheck) {
        recheckReceived.resolve();
        await release.promise;
      }
      if (path === PATHS.categories) readStarted.resolve();
      return upstream(path, params, wire);
    }});
  const s = await bind(r,'611');
  const first = await prepare(s);
  // 单个间隔能发短信。两个不同门店的读取先占据发送时隙，使下单等待超过写超时。
  const readers = await Promise.all([r.session(), r.session()]);
  holdRecheck = true;
  const placing = place(s,first);
  await recheckReceived.promise;
  const menuReads = readers.map((reader, i) => value(reader.call('get_menu', {storeId: 610 + i})));
  await readStarted.promise;
  release.resolve();
  const response = await placing;
  await Promise.all(menuReads);
  assert.equal(response.isError,true);
  assert.match(response.content[0].text,/排队的人多，这次下单请求没有发出/);
  assert.equal(r.requests.filter(x=>x.path===PATHS.create).length,0);
  assert.equal(bookRecords(r).length,0);
  const reused = await place(s,first);
  assert.match(reused.content[0].text,/令牌无效/);
  const second = await prepare(s);
  await sleep(interval+25);
  assert.equal((await value(place(s,second))).placed,true);
  assert.equal(bookRecords(r).length,1);
  assert.equal(r.requests.filter(x=>x.path===PATHS.create).length,1);
});

test('UPS-03 读超时覆盖收到响应头后的半截响应体', async t => {
  const r = await rig(t,{env:{LICHA_READ_TIMEOUT_MS:'95'},upstream(path,params,{res}) {
    res.writeHead(200,{'content-type':'application/json'});
    res.write('{"status":true,"data":[');
  }});
  const s = await r.session();
  const result = await s.call('get_menu',{storeId:601});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/门店系统这会儿反应慢/);
  assert.equal(r.requests.length,3);
});
