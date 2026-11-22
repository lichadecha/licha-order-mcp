import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rig} from '../test-support/rig.js';
import {Qmai, PATHS} from '../server/qmai.js';
import {Ledger} from '../server/ledger.js';
import {readConfig} from '../server/config.js';
import {beijingTime, digest} from '../server/common.js';

test('ORD-02 WRT-11 写出口拒绝缺失、伪造、跨次复用的落盘凭据', async t => {
  const r = await rig(t);
  const config = readConfig(r.env);
  const api = new Qmai(config,()=>{});
  const send = callback => api.write(PATHS.create,{},callback && {beforeSend:callback});
  assert.throws(()=>send(),/落盘凭据/);
  for (const value of [undefined, true, {}, {persisted:true}]) {
    await assert.rejects(send(()=>value),/落盘凭据/);
  }
  const ledger = new Ledger(join(r.cwd,'write-gate-ledger'));
  t.after(()=>ledger.close());
  const record = {key:digest('FAKE_REQUEST'),memberHash:digest('FAKE_MEMBER'),storeId:'1',
    time:Date.now(),day:beijingTime().slice(0,10),totalFen:10,state:'sent'};
  const other = ledger.recordSending({...record,key:digest('FAKE_OTHER')},{});
  await assert.rejects(send(()=>other),/落盘凭据/);
  assert.equal(r.requests.length,0);
  let proof;
  await send(attempt=>{
    proof = ledger.recordSending(record,attempt);
    return proof;
  });
  await assert.rejects(send(()=>proof),/落盘凭据/);
  assert.equal(r.requests.length,1);
});

test('ORD-02 增加路径常量不会自动获得读权限', async t => {
  const r = await rig(t);
  // 模拟维护者只登记了一个新接口。用临时副本测试扩展路径表后的真实出口行为。
  const original = new URL('../server/qmai.js',import.meta.url);
  const code = (await readFile(original,'utf8')).replace('export const PATHS = Object.freeze({',
    "export const PATHS = Object.freeze({futureAction:'v3/future/action',")
    .replace(/from '(\.\/[^']+)'/g,(_,relative)=>"from '"+new URL(relative,original).href+"'");
  const variant = join(r.cwd,'qmai-extended.mjs');
  await writeFile(variant,code);
  const extended = await import(pathToFileURL(variant).href);
  assert.equal(extended.PATHS.futureAction,'v3/future/action');
  const api = new extended.Qmai(readConfig(r.env),()=>{});
  await assert.rejects(async()=>api.read(extended.PATHS.futureAction,{}),/读出口/);
  assert.equal(r.requests.length,0);
});
