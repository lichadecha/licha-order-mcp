import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bind, bindAgain } from '../test-support/commerce.js';
import { rig, mockCaptcha } from '../test-support/rig.js';
import { createLogs } from '../server/logs.js';
import { readConfig } from '../server/config.js';
import { digest, projectText } from '../server/common.js';

const initialize = {jsonrpc:'2.0',id:1,method:'initialize',params:{
  protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'integration',version:'1'}
}};
const ping = {jsonrpc:'2.0',id:2,method:'ping'};
const ok = data => ({code:0,status:true,data});
const phone = {code:'13800000000',codeType:'phone'};
const otherPhone = {code:'13800001234',codeType:'phone'};
const customer = '9000000000000001234';
const data = result => { assert.ok(!result.isError,result.content[0].text); return JSON.parse(result.content[0].text); };
function upstream(path) {
  if (path.endsWith('getCustomerIdByCode')) return ok({customerId:customer});
  if (path.endsWith('getShopList')) return ok({list:[]});
  return ok({total:0,data:[]});
}

test('SES-01 SES-07 ORD-01 准入、设备归属、并发末席、失败和关闭归还名额',async t => {
  const blocked = randomUUID();
  const r = await rig(t,{env:{LICHA_MAX_SESSIONS:'1',LICHA_BLOCKED_DEVICES:blocked,
    LICHA_ACCESS_KEYS:'FAKE_ACCESS_KEY, FAKE_ROTATED_KEY',LICHA_ENABLE_ORDERING:'true'}});
  const device = randomUUID();
  const base = r.headers(device);
  const post = (headers,body) => fetch(r.url+'/mcp',{method:'POST',headers,body:JSON.stringify(body)});
  assert.deepEqual(await (await fetch(r.url+'/healthz')).json(),{ok:true,version:'1.0.0',ordering:false});
  for (const [extra,status] of [
    [{'x-licha-access':''},401],[{'x-licha-device':''},400],[{'x-licha-device':device.slice(0,14)+'1'+device.slice(15)},400],[{'x-licha-device':blocked},403]
  ]) assert.equal((await post({...base,...extra},initialize)).status,status);
  assert.equal((await post(base,{...initialize,params:{}})).status,400);
  assert.equal((await post({...base,accept:'text/plain'},initialize)).status,406);
  const results = await Promise.all([post(base,initialize),post(base,initialize)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,503]);
  const winner = results.find(r=>r.ok);
  const id = winner.headers.get('mcp-session-id');
  const bound = {...base,'mcp-session-id':id};
  assert.equal((await winner.json()).result.serverInfo.name,'licha-order-mcp');
  for (const method of ['GET','DELETE','POST']) {
    const resp = await fetch(r.url+'/mcp',{method,headers:{...bound,'x-licha-device':randomUUID()},
      ...(method==='POST' && {body:JSON.stringify(ping)})});
    assert.equal(resp.status,403);
  }
  const list = await post({...bound,'x-licha-device':device.toUpperCase(),'x-licha-access':'FAKE_ROTATED_KEY'},
    {...ping,method:'tools/list'});
  assert.deepEqual((await list.json()).result.tools.map(t=>t.name),['find_store','get_menu','get_item_detail','preview_order']);
  const closed = await fetch(r.url+'/mcp',{method:'DELETE',headers:bound});
  assert.equal(closed.status,200);
  for (const method of ['GET','POST','DELETE']) {
    const gone = await fetch(r.url+'/mcp',{method,headers:bound,...(method==='POST' && {body:JSON.stringify(ping)})});
    assert.equal(gone.status,404); assert.equal(gone.headers.get('x-licha-reason'),'session-not-found');
  }
  assert.ok((await r.session()).id);
  assert.equal(r.requests.length,0);
});

test('SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期',async t => {
  const r = await rig(t,{mockSms:true,upstream,env:{LICHA_BINDING_IDLE_TTL_MS:'900',LICHA_SESSION_IDLE_TTL_MS:'200'}});
  const first = await r.session();
  await bind(first);
  const other = await r.session();
  assert.match((await other.call('my_orders')).content[0].text,/尚未绑定/);
  await delay(270);
  assert.equal((await first.send(ping)).headers.get('x-licha-reason'),'session-not-found');
  const second = await r.session(first.device);
  assert.equal(data(await second.call('my_orders')).count,0);
  await second.close();
  for (let i=0;i<3;i++) {
    await delay(320);
    const s = await r.session(first.device);
    data(await s.call('find_store',{query:'茶'}));
    assert.equal((await s.call('bind_member',{codeType:'phone',code:'错误号码'})).isError,true);
    await s.close();
  }
  const late = await r.session(first.device);
  assert.match((await late.call('my_orders')).content[0].text,/尚未绑定/);
});

test('SES-05 SES-09 跨会话共用滑动窗口；重启清除限流与绑定',async t => {
  const r = await rig(t,{mockSms:true,upstream,env:{LICHA_RATE_CALLS_PER_DEVICE_PER_MIN:'3'}});
  const a = await r.session();
  const b = await r.session(a.device);
  await bind(a);
  data(await b.call('my_orders'));
  const before = r.requests.length;
  assert.match((await a.call('my_orders')).content[0].text,/操作太频繁/);
  assert.match((await b.call('my_orders')).content[0].text,/操作太频繁/);
  assert.equal(r.requests.length,before);
  const other = await r.session();
  assert.match((await other.call('my_orders')).content[0].text,/尚未绑定/);
  await r.restart();
  const fresh = await r.session(a.device);
  assert.match((await fresh.call('my_orders')).content[0].text,/尚未绑定/);
  await bind(fresh, otherPhone.code);
});

test('SES-08 同设备跨会话按到达次序执行，其他设备可以继续查询',async t => {
  let release,markEntered;
  const entered = new Promise(resolve => {markEntered=resolve});
  const gate = new Promise(resolve => {release=resolve});
  const r = await rig(t,{upstream:async(path,params) => {
    if (path.endsWith('commonSendSmsCaptcha')) return ok(null);
    if (path.endsWith('commonCheckSmsCaptcha')) {markEntered(); await gate; return ok(null);}
    return upstream(path);
  }});
  const a = await r.session();
  const b = await r.session(a.device);
  const other = await r.session();
  assert.equal(data(await a.call('bind_member',phone)).verificationSent,true);
  const first = a.call('bind_member',{...phone,captcha:mockCaptcha});
  await entered;
  const second = b.call('my_orders');
  data(await other.call('find_store',{query:'演示'}));
  assert.ok(r.requests.every(row=>!row.path.endsWith('OrderList')));
  release();
  data(await first); assert.equal(data(await second).count,0);
});

test('SES-08 SES-09 上一个绑定仍在等待时，同设备超额请求立即返回',async t => {
  let markEntered, release;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const r = await rig(t,{mockSms:true,env:{LICHA_RATE_CALLS_PER_DEVICE_PER_MIN:'1',LICHA_READ_TIMEOUT_MS:'5000'},
    upstream:async (path) => { markEntered(); await gate; return upstream(path); }});
  const a = await r.session();
  const b = await r.session(a.device);
  const first = a.call('bind_member',phone);
  try {
    await entered;
    const rejected = await b.call('my_orders');
    assert.match(rejected.content[0].text,/操作太频繁/);
    assert.equal(r.requests.length,1);
  } finally { release(); }
  data(await first);
});

test('LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏',async t => {
  const secretText = '请联系+8613800000000并带上FAKE_SECRET_MESSAGE';
  const r = await rig(t,{mockSms:true,upstream:path => path.endsWith('getShopList')
    ? {status:false,code:110004,message:secretText} : upstream(path)});
  const a = await r.session();
  await bind(a);
  const b = await r.session();
  await bind(b, otherPhone.code);
  assert.equal((await a.call('find_store',{query:'茶'})).isError,true);
  const fakeToken = randomUUID();
  assert.equal((await a.call('place_order',{confirmToken:fakeToken,confirmAmountYuan:1})).isError,true);
  const logs = createLogs(readConfig(r.env));
  const orderNo = 'D00000000000000000021';
  logs.access({event:'projection_example',orderNo,openKey:'FAKE_NEVER_WRITE',apiSecret:'FAKE_NEVER_WRITE',
    sample:{integer:1234567890123456,text:'甲008613800000000乙 8613800000000 +8613800000000 戊'+ 'A'.repeat(48)}});
  const access = await readFile(join(r.logDir,'access.jsonl'),'utf8');
  const attempts = await readFile(join(r.logDir,'upstream.jsonl'),'utf8');
  const writes = await readFile(join(r.logDir,'write.jsonl'),'utf8');
  const all = access+attempts+writes;
  for (const value of [a.device,b.device,customer,phone.code,otherPhone.code,mockCaptcha,secretText,'FAKE_NEVER_WRITE',fakeToken,...['QMAI_OPEN_KEY','QMAI_OPEN_ID','QMAI_GRANT_CODE','LICHA_ACCESS_KEYS'].map(key=>r.env[key])]) {
    assert.ok(!all.includes(value),'识别值进入日志');
  }
  assert.ok(!attempts.includes('FAKE_SECRET_MESSAGE'));
  assert.ok(!all.includes(r.requests[0].body.token));
  const rows = access.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.event==='startup').length,1);
  assert.equal(rows[0].dataDir,r.dataDir);
  assert.ok(rows.every(row=>/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+08:00$/.test(row.time)));
  const binds = rows.filter(row=>row.event==='bind');
  assert.deepEqual(binds.map(row=>row.deviceHash),[digest(a.device),digest(b.device)]);
  assert.equal(binds[0].memberHash,binds[1].memberHash);
  assert.equal(rows.at(-1).orderNo,'***0021');
  assert.equal(rows.at(-1).sample.integer,'***3456');
  assert.equal(rows.at(-1).sample.text,'甲***0000乙 ***0000 ***0000 戊***AAAA');
  const last = JSON.parse(attempts.trim().split('\n').at(-1));
  assert.equal(Number(last.code),110004); assert.equal(last.messageLength,secretText.length);
});

test('LOG-05 三本日志介质故障不改变业务结果',async t => {
  const r = await rig(t,{mockSms:true,upstream});
  await rm(r.logDir,{recursive:true});
  await writeFile(r.logDir,'模拟日志目录无法写入');
  const a = await r.session();
  await bind(a);
  assert.match((await a.call('place_order',{confirmToken:'FAKE_TOKEN',confirmAmountYuan:2})).content[0].text,/无效/);
  data(await a.call('find_store',{query:'演示'}));
});

test('OUT-02 错误文本投影按码点截断并移除网址、凭证、电话与长数字',() => {
  assert.equal(projectText({message:'不可见'}),'');
  assert.equal(projectText('前  https://example.invalid/path apiSecret:FAKE abcTOKEN：FAKE someKey=FAKE 后\n+8613800000000，9000000000000001234'),'前 后 ***0000，***1234');
  assert.equal(projectText('🍵'.repeat(81)),'🍵'.repeat(80)+'…');
});

test('§3.2 启动配置只在未设置时采用默认值，拒绝无效项且不回显',() => {
  const base = {LICHA_ACCESS_KEYS:'FAKE'};
  assert.equal(readConfig(base).PORT,3000);
  for (const [key,value] of Object.entries({
    LICHA_ACCESS_KEYS:' , ',PORT:'65536',HOST:'',QMAI_BASE_URL:'FAKE:',LICHA_DATA_DIR:'',
    LICHA_LOG_DIR:' ',LICHA_BLOCKED_DEVICES:'FAKE_DEVICE',LICHA_MAX_SESSIONS:'FAKE_NUMBER',
    LICHA_READ_BACKOFF_MS:'3,0',LICHA_WRITE_TIMEOUT_MS:'-1'
  })) assert.throws(()=>readConfig({...base,[key]:value}),error=>error.message==='配置无效：'+key);
  assert.throws(()=>readConfig({...base,LICHA_ENABLE_ORDERING:'1'}),/LICHA_DATA_DIR/);
});

test('SES-07 正在接收握手的连接占名额，中止后只归还一次',async t => {
  const {request} = await import('node:http');
  const r = await rig(t,{env:{LICHA_MAX_SESSIONS:'1',LICHA_ENABLE_ORDERING:'0'}});
  const headers = r.headers(randomUUID());
  const partial = request(r.url+'/mcp',{method:'POST',headers});
  partial.on('error',()=>{});
  t.after(()=>partial.destroy());
  await new Promise(resolve=>partial.write('{"jsonrpc":',resolve));
  await delay(50);
  const compete = () => fetch(r.url+'/mcp',{method:'POST',headers,body:JSON.stringify(initialize)});
  assert.equal((await compete()).status,503);
  partial.destroy();
  await delay(100);
  assert.equal((await compete()).status,200);
  assert.equal((await compete()).status,503);
});

test('SES-06 已进入会话的 POST 在接收消息期间保持活动',async t => {
  const {request} = await import('node:http');
  const r = await rig(t,{env:{LICHA_SESSION_IDLE_TTL_MS:'220',LICHA_ENABLE_ORDERING:'0'}});
  const s = await r.session();
  let partial;
  const answer = new Promise((resolve,reject) => {
    partial = request(r.url+'/mcp',{method:'POST',headers:s.headers},async response=>{
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      resolve([response.statusCode,JSON.parse(Buffer.concat(chunks).toString())]);
    });
    partial.on('error',reject);
    partial.write('{"jsonrpc":"2.0","id":93,');
  });
  t.after(()=>partial.destroy());
  await delay(550);
  partial.end('"method":"tools/list"}');
  const [status,body] = await answer;
  assert.equal(status,200);
  assert.equal(body.result.tools.length,4);
  await delay(350);
  assert.equal((await s.send(ping)).headers.get('x-licha-reason'),'session-not-found');
});

test('§3.2 凭证缺项仍可握手，非法环境变量阻止启动且不回显',async t => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const {serverPath} = await import('../test-support/rig.js');
  const r = await rig(t,{env:{QMAI_OPEN_ID:undefined}});
  const a = await r.session();
  assert.equal((await a.rpc('tools/list')).tools.length,9);
  for (const [name,args] of [['find_store',{query:'茶'}],['bind_member',phone]]) {
    const result = await a.call(name,args);
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/凭证不完整/);
  }
  assert.equal(r.requests.length,0);
  for (const env of [{LICHA_ENABLE_ORDERING:'1',LICHA_DATA_DIR:''},{LICHA_MAX_SESSIONS:'FAKE_INVALID_DO_NOT_ECHO'}]) {
    const name = Object.keys(env).at(-1);
    await assert.rejects(promisify(execFile)(process.execPath,[serverPath],{
      cwd:r.cwd,env:{...r.env,...env},timeout:5000
    }),error=>error.code===1 && error.stderr.includes(name) && !error.stderr.includes('FAKE_INVALID_DO_NOT_ECHO'));
  }
});

test('SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单',async t => {
  const seen = [];
  const r = await rig(t,{mockSms:true,env:{LICHA_BINDING_IDLE_TTL_MS:'700',LICHA_SMS_COOLDOWN_SEC:'1',LICHA_CONFIRM_TOKEN_TTL_MS:'60000'},
    upstream(path,params) {
      if (path.endsWith('getShopGoodsDetail')) return ok([{goodsId:'101',name:'测试茶',
        goodsSkuList:[{skuId:'202',salePrice:1000}]}]);
      if (path.endsWith('getShopList')) return ok({list:[{id:11,code:'',name:'编号测试门店'}]});
      if (path.endsWith('/create')) {seen.push(params); return ok({orderNo:'D00000000000000000501'});}
      if (path.endsWith('cyOrderDetail')) return ok({orderNo:params.orderNo,userId:customer,actualAmount:1000});
      return upstream(path);
    }});
  const a = await r.session();
  await bind(a);
  const args = {storeId:'00011',items:[{goodsId:'101',quantity:1}]};
  const first = data(await a.call('prepare_order',args));
  assert.deepEqual(first.store,{storeId:'11',name:'编号测试门店'});
  await a.close();
  const b = await r.session(a.device);
  data(await b.call('place_order',{confirmToken:first.confirmToken,confirmAmountYuan:10}));
  assert.equal(seen[0].storeId,11);
  const later = data(await b.call('prepare_order',args));
  await delay(820);
  assert.match((await b.call('my_orders')).content[0].text,/尚未绑定/);
  await bindAgain(b);
  assert.match((await b.call('place_order',{confirmToken:later.confirmToken,confirmAmountYuan:10})).content[0].text,/无效/);
  assert.equal(seen.length,1);
});

test('LOG-03 写审计默认掩码，伪造的令牌、订单回执和账本对象不能取得全值',async t => {
  const r = await rig(t,{upstream});
  const logs = createLogs(readConfig(r.env));
  const token = randomUUID();
  const orderNo = 'FAKEAUDIT00000000021';
  const key = digest('FAKE_UNVERIFIED_KEY');
  const fake = {token, orderNo, key};
  logs.write({
    reason:'unverified', tokenId:token, orderNo, dedupKey:key, requestKey:key, memberHash:key, deviceHash:key,
    quotaDate:'FAKE_RAW_DATE', path:'FAKE_RAW_PATH', nested:{orderNo,tokenId:token}
  }, {confirmation:fake, ledgerRecord:fake, order:fake, reservation:{day:'FAKE_RAW_DATE'}});
  const contents = await readFile(join(r.logDir,'write.jsonl'),'utf8');
  for (const value of [orderNo,token,key]) assert.ok(!contents.includes(value));
  const entry = JSON.parse(contents);
  assert.equal(entry.quotaDate,undefined);
  assert.equal(entry.path,undefined);
  assert.equal(entry.orderNo,'***0021');
  assert.equal(entry.tokenId,'***'+token.slice(-4));
  assert.equal(entry.requestKey,'***'+key.slice(-4));
  assert.deepEqual(entry.nested,{orderNo:entry.orderNo,tokenId:entry.tokenId});
});
