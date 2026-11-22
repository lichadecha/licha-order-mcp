import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rig } from './rig.js';
import { PATHS } from '../server/qmai.js';

export const memberA = '9000000000000001234';
export const memberB = '9000000000000005678';
export const phone = '13800000000';
export const goodsId = '8100000000000000001';
export const skuId = '8100000000000000002';
export const shop = '111111';
export const basket = { storeId: shop, items: [{ goodsId, quantity: 1 }] };
export const number = i => 'D' + String(i).padStart(20, '0');
export const ok = data => ({ code: 0, status: true, data });

export async function setup(t, env = {}) {
  const mock = {
    price: 2000, couponRows: [], orders: [], last: null, writes: 0, override: new Map(), code: '01'
  };
  const r = await rig(t, {
    env: { LICHA_RATE_CALLS_PER_DEVICE_PER_MIN: '200', ...env },
    upstream: async (path, params, context) => {
      if (mock.override.has(path)) return mock.override.get(path)(params, context);
      switch (path) {
      case PATHS.member: {
        const id = { [phone]: memberA, FAKE_CARD_A: memberA, FAKE_CARD_B: memberB, ABCD: memberB,
          '0000': 0, '0001': '0', '0002': null }[params.customerCode.code];
        return ok({ customerId: id ?? null });
      }
      case PATHS.item: return ok([{ goodsId, name: '测试茶', type: 1, status: 10,
        goodsSkuList: [{ skuId, salePrice: mock.price, clearStatus: 1, inventory: 99 }] }]);
      case PATHS.stores: return ok({ list: [{ id: Number(shop), code: mock.code, name: '模拟门店', openStatus: 1 }], total: 1 });
      case PATHS.coupons: return ok(mock.couponRows);
      case PATHS.create: {
        const orderNo = number(++mock.writes);
        mock.last = { orderNo, userId: params.userId, actualAmount: mock.price, discountAmount: 0 };
        mock.orders.push({ ...mock.last, storeId: params.storeId, orderAt: Date.now(), status: 10 });
        return ok({ orderNo, payAmount: mock.price / 100 });
      }
      case PATHS.orderDetail: return ok(mock.last);
      case PATHS.orderList: return ok({ data: mock.orders, total: mock.orders.length });
      case PATHS.orderStatus: return ok({ userId: memberA, status: 10 });
      default: return ok([]);
      }
    }
  });
  return { ...r, mock };
}
export async function success(s, tool, args) {
  const result = await s.call(tool, args);
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
export async function failure(s, tool, args, regex) {
  const result = await s.call(tool, args);
  assert.equal(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, regex);
  return result.content[0].text;
}
export const bind = (s, code = phone, codeType = 'phone') => success(s, 'bind_member', { code, codeType });
export const prepare = s => success(s, 'prepare_order', basket);
export const argsFor = d => ({ confirmToken: d.confirmToken, confirmAmountYuan: Number(d.estimatedTotalYuan) });
export const place = (s, draft) => success(s, 'place_order', argsFor(draft));
export const count = (r, path) => r.requests.filter(x => x.path === path).length;
export const bookFile = r => join(r.dataDir, 'orders.json');
export async function withBound(t, env) {
  const r = await setup(t, env);
  const s = await r.session();
  await bind(s);
  return { r, s, m: r.mock };
}
