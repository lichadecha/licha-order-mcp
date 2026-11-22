import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {rig} from '../test-support/rig.js';
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
  await value(session.call('bind_member',{codeType:'card',code:'FAKE-CARD-' + code}));
  return session;
}
const prepare = s => value(s.call('prepare_order',order));
const place = (s,draft) => s.call('place_order',{confirmToken:draft.confirmToken,confirmAmountYuan:1});
const records = async r => JSON.parse(await readFile(join(r.dataDir,'orders.json'),'utf8')).records;
function mockUpstream(onCreate) {
  return async (path,params,wire) => {
    switch(path) {
      case PATHS.member: return good({customerId:'9900000000000000'+params.customerCode.code.slice(-3)});
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
    await writeFile(offset+'.next',String(ms-Date.now()));
    await rename(offset+'.next',offset);
  };
  await setClock(midnight - 15000);
  // 只改变子进程 Date.now 的基准。定时器、排队、落盘、网络仍使用真实时间。
  const preload = "import {readFileSync} from 'node:fs';const now=Date.now.bind(Date);" +
    "Date.now=()=>now()+Number(readFileSync("+JSON.stringify(offset)+",'utf8'));";
  const hook = 'data:text/javascript;base64,'+Buffer.from(preload).toString('base64');
  const created = [];
  const firstReceived = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(()=>release.resolve());
  const r = await rig(t,{env:{NODE_OPTIONS:'--import='+hook,LICHA_MAX_ORDERS_PER_DAY:'1',
    LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1', LICHA_UPSTREAM_MIN_INTERVAL_MS:'720', LICHA_WRITE_TIMEOUT_MS:'6000'},
    upstream:mockUpstream(async params => {
      const n = created.push(params);
      if (n === 1) { firstReceived.resolve(); await release.promise; }
      return good({orderNo:'D'+String(n).padStart(20,'0')});
    })});
  const customers = await Promise.all(['001','002'].map(code=>bind(r,code)));
  const drafts = await Promise.all(customers.map(prepare));
  // 一次真实读取占据最近的发送时刻，保证下单的占位与真正发出之间跨越午夜。
  await value(customers[0].call('get_menu',{storeId:602}));
  await setClock(midnight - 380);
  const attempts = customers.map((s,i)=>place(s,drafts[i]));
  const early = await Promise.race(attempts.map((promise,i)=>promise.then(result=>({result,i}))));
  assert.match(early.result.content[0].text,/总单量已到上限/);
  await firstReceived.promise;
  const [sent] = await records(r);
  assert.equal(sent.day,'2031-02-07');
  assert.ok(sent.time >= midnight,JSON.stringify(sent));
  assert.equal(sent.state,'sent');
  release.resolve();
  const results = await Promise.all(attempts);
  const winner = 1 - early.i;
  assert.equal((await value(results[winner])).placed,true);
  // 昨天被拒没有消耗令牌或名额；新一天仍有完整额度。
  assert.equal((await value(place(customers[early.i],drafts[early.i]))).placed,true);
  assert.deepEqual((await records(r)).map(row=>[row.day,row.state]),
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

test('WRT-11 等待实际发送名额超时，账本空且个人、全局占位都释放', async t => {
  const interval = 430;
  const r = await rig(t,{env:{LICHA_UPSTREAM_MIN_INTERVAL_MS:String(interval),LICHA_WRITE_TIMEOUT_MS:'100',
    LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1',LICHA_MAX_ORDERS_PER_DAY:'1'},
    upstream:mockUpstream(()=>good({orderNo:'D00000000000000000911'}))});
  const s = await bind(r,'611');
  const first = await prepare(s);
  const response = await place(s,first);
  assert.equal(response.isError,true);
  assert.match(response.content[0].text,/排队的人多，这次下单请求没有发出/);
  assert.equal(r.requests.filter(x=>x.path===PATHS.create).length,0);
  assert.equal((await records(r)).length,0);
  const reused = await place(s,first);
  assert.match(reused.content[0].text,/令牌无效/);
  const second = await prepare(s);
  await sleep(interval+25);
  assert.equal((await value(place(s,second))).placed,true);
  assert.equal((await records(r)).length,1);
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
