import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ledger } from './ledger.js';
import { orderNumber } from './commerce-view.js';
import { beijingTime, projectText } from './common.js';

function run() {
  const [action, key, outcome, ...args] = process.argv.slice(2);
  const usage = '请设置 LICHA_DATA_DIR；用法：list，或 resolve 请求键 found 订单号 说明，或 resolve 请求键 absent 说明。';
  if (!process.env.LICHA_DATA_DIR?.trim() || !['list', 'resolve'].includes(action)) throw Error(usage);
  if (action === 'list' && key !== undefined) throw Error(usage);
  let orderNo, note;
  if (action === 'resolve') {
    if (!key || !['found', 'absent'].includes(outcome)) throw Error(usage);
    if (outcome === 'found') {
      orderNo = orderNumber({ orderNo: args.shift() });
      if (!orderNo) throw Error('订单号格式无效');
    }
    note = projectText(args.join(' '));
    if (!note) throw Error('需要填写人工核对说明');
  }

  const directory = resolve(process.env.LICHA_DATA_DIR);
  if (!statSync(directory, {throwIfNoEntry:false})) {
    if (action === 'list') { console.log('[]'); return; }
    throw Error('没有这笔未决请求');
  }
  const book = new Ledger(directory, {initializeIfEmpty:false});
  try {
    if (book.fault) throw Error('安全账本不可用，需要人工检查');
    if (action === 'list') {
      const unresolved = [...book.records.values()].filter(row => ['sent', 'unknown'].includes(row.state));
      console.log(JSON.stringify(unresolved.map(row => ({
        key: row.key, member: row.memberHash, storeId: row.storeId,
        requestedAt: beijingTime(row.time), estimatedFen: row.totalFen
      })), null, 2));
      return;
    }
    const row = book.records.get(key);
    if (!['sent', 'unknown'].includes(row?.state)) throw Error('没有这笔未决请求');
    if (orderNo && book.knownOrders().has(orderNo)) throw Error('订单号已被认领');
    book.update({ ...row, state: outcome, ...(orderNo && { orderNo }), operatorNote: note, resolvedAt: Date.now() });
    console.log('核对结论已保存。');
  } finally {
    book.close();
  }
}

try { run(); } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
