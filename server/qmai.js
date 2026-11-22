import {createHmac, randomInt} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {projectText} from './common.js';
import {consumeSendReceipt} from './ledger.js';

export const PATHS = Object.freeze({
  stores: 'v3/org/shop/getShopList',
  storeStatus: 'v3/org/shop/getShopColsById',
  categories: 'v3/goods/item/getShopCategory',
  categoryItems: 'v3/goods/item/getShopGoodsListByCategory',
  search: 'v3/goods/item/getShopGoodsList/search',
  item: 'v3/goods/item/getShopGoodsDetail',
  member: 'v3/crm/customer/getCustomerIdByCode',
  coupons: 'v3/bsns/customer/chooseCouponAsOne',
  orderDetail: 'v3/order/standard/cyOrderDetail',
  orderStatus: 'v3/order/status',
  orderList: 'v3/order/userAppointTimeOrderList',
  create: 'v3/newPattern/cateringApiserver/post/order/v1/create'
});
const readPaths = new Set([
  PATHS.stores, PATHS.storeStatus, PATHS.categories, PATHS.categoryItems, PATHS.search,
  PATHS.item, PATHS.member, PATHS.coupons, PATHS.orderDetail, PATHS.orderStatus, PATHS.orderList
]);
// 只为实际 HTTP 成功回执签发审计依据，保留收到时的值，调用方不能用同形对象代替。
const orderResponses = new WeakMap();
export function receivedOrderNumber(row) {
  return orderResponses.get(row);
}

export const MISSING_CREDENTIALS = '凭证不完整：服务端缺少企迈凭证，暂时无法查询。';
export const READ_TIMEOUT = '门店系统这会儿反应慢，刚才那一步没查到结果，稍等几秒我再帮你问一次。';

export function sign(key, {grantCode, nonce, openId, timestamp}) {
  const fields = `grantCode=${grantCode}&nonce=${nonce}&openId=${openId}&timestamp=${timestamp}`;
  return encodeURIComponent(createHmac('sha1', key).update(fields).digest('base64'));
}

export function checkSignature() {
  // 企迈文档 id=264 的公开测试向量。
  const token = sign('LyvrkvkxRkG2R6aM55bXpPwjYAbkEXTbVnKwfDYvVHjNwNFAmx', {
    openId: 'd14c1559e87b747d577c834b275a4310', grantCode: 'ba67d4fa46', nonce: 11886, timestamp: 1465185768
  });
  if (token !== 'cFw0t9IuvL9jVo9qAzk0qMcw5BM%3D') throw new Error('企迈签名自检失败');
}

const orderReadPaths = new Set([PATHS.orderList, PATHS.orderDetail, PATHS.orderStatus]);
const orderIntegerFields = new Set(['userId', 'total', 'status', 'actualAmount', 'discountAmount',
  'discountType', 'goodsId', 'num', 'storeId', 'orderAt', 'createTime']);

export function parseResponse(raw, path) {
  const orderRead = orderReadPaths.has(path);
  return JSON.parse(raw, (key, value, context) => {
    if (typeof value !== 'number') return value;
    const token = context.source;
    // 大整数直接取原文。交易证据中的分数和指数也保留词法，让整数校验能识别舍入前的值。
    const integerField = (orderRead && orderIntegerFields.has(key))
      || (path === PATHS.member && (key === 'customerId' || key === 'data'));
    return /^-?\d{15,}$/.test(token) || (integerField && /[.eE]/.test(token)) ? token : value;
  });
}

const numericKeys = new Set(['userId', 'customerId', 'goodsId', 'skuId', 'id', 'valueId', 'frontCategoryId', 'storeId', 'shopId']);
function encode(body) {
  return JSON.stringify(body, (key, value) => {
    if (!numericKeys.has(key)) return value;
    const digits = String(value);
    if (!/^\d+$/.test(digits) || (typeof value === 'number' && !Number.isSafeInteger(value))) {
      throw new Error('企迈请求中的标识无效');
    }
    return JSON.rawJSON(digits.replace(/^0+(?=\d)/, ''));
  });
}

export class QmaiError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function readHint(error, fallback) {
  if (error.kind === 'timeout') return READ_TIMEOUT;
  if (error.kind !== 'business') return '网络异常，稍后再试';
  return ({110004:'验签失败，检查凭证配置', 100002:'参数格式不对', 100007:'搜索词为空或不支持'})[error.code]
    ?? (error.code == null ? fallback : undefined) ?? '接口暂时异常，换个问法试试';
}

function post(url, path, payload, timeout, onFlush) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const failed = () => reject(timedOut
      ? new QmaiError('timeout', READ_TIMEOUT)
      : new QmaiError('network', '网络异常，稍后再试'));
    const request = transport.request(url, {
      method: 'POST', headers: {'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(payload)}
    }, response => {
      response.once('error', failed);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new QmaiError('http', `HTTP ${response.statusCode}`, {statusCode: response.statusCode}));
        response.destroy();
        return;
      }
      const chunks = [];
      response.on('data', part => chunks.push(part));
      response.once('end', () => {
        try {
          const envelope = parseResponse(Buffer.concat(chunks).toString('utf8'), path);
          if (envelope?.status === false) {
            const {message, code} = envelope;
            reject(new QmaiError('business', projectText(message) || '未知错误', {
              code: Number.isSafeInteger(code) || (typeof code === 'string' && /^\d{1,9}$/.test(code)) ? code : undefined,
              messageLength: typeof message === 'string' ? [...message].length : 0
            }));
          } else if (envelope?.status === true) resolve(envelope.data);
          else reject(new QmaiError('invalid', '回执无法识别'));
        } catch {
          reject(new QmaiError('invalid', '回执无法识别'));
        }
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      request.destroy();
    }, timeout);
    request.once('error', failed);
    request.once('finish', onFlush);
    request.once('close', () => {
      clearTimeout(timer);
      onFlush();
    });
    request.end(payload);
  });
}

export class Qmai {
  #turn = Promise.resolve();
  #lastFlush = -Infinity;
  constructor(config, logAttempt) {
    checkSignature();
    this.config = config;
    this.logAttempt = logAttempt;
    const key = config.QMAI_OPEN_KEY;
    const prefix = 'go-keyring-base64:';
    this.key = key;
    if (key?.startsWith(prefix)) {
      const encoded = key.slice(prefix.length);
      const decoded = Buffer.from(encoded, 'base64');
      if (!decoded.length || decoded.toString('base64') !== encoded) throw new Error('配置无效：QMAI_OPEN_KEY');
      this.key = decoded;
    }
  }

  read(path, params = {}, options = {}) {
    if (!readPaths.has(path)) throw new Error('读出口拒绝此路径');
    return this.#read(path, params, options.retry !== false);
  }
  async #read(path, params, retry) {
    const backoff = this.config.LICHA_READ_BACKOFF_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#attempt(path, params, false);
      } catch (error) {
        const transient = ['timeout','network','invalid'].includes(error.kind)
          || (error.kind === 'http' && error.statusCode >= 500);
        if (!retry || !transient || attempt >= 2) throw error;
        await delay(backoff[attempt]);
      }
    }
  }
  write(path, params, {beforeSend} = {}) {
    if (path !== PATHS.create || ![true, '1'].includes(this.config.LICHA_ENABLE_ORDERING)) throw new Error('写出口拒绝此请求');
    if (typeof beforeSend !== 'function') throw new Error('写出口要求发送前落盘凭据');
    return this.#attempt(path, params, true, beforeSend);
  }

  #attempt(path, params, write, beforeSend) {
    const c = this.config;
    if (!this.key?.length || !c.QMAI_OPEN_ID || !c.QMAI_GRANT_CODE) throw new QmaiError('credentials', MISSING_CREDENTIALS);
    const timeout = write ? c.LICHA_WRITE_TIMEOUT_MS : c.LICHA_READ_TIMEOUT_MS;
    const deadline = write ? performance.now() + timeout : Infinity;
    const url = new URL(path, c.QMAI_BASE_URL.replace(/\/?$/, '/'));
    return new Promise((resolve, reject) => {
      let expired = false;
      const expire = () => {
        expired = true;
        reject(new QmaiError('queue_timeout', '发送前排队超时'));
      };
      const timer = write ? setTimeout(expire, timeout) : undefined;
      this.#turn = this.#turn.then(async () => {
        if (expired) return;
        const earliest = this.#lastFlush + c.LICHA_UPSTREAM_MIN_INTERVAL_MS;
        while (performance.now() < Math.min(earliest, deadline)) {
          await delay(Math.ceil(Math.min(earliest, deadline) - performance.now()));
        }
        if (expired || performance.now() >= deadline) { expire(); return; }
        clearTimeout(timer);
        const fields = {openId: c.QMAI_OPEN_ID, grantCode: c.QMAI_GRANT_CODE, nonce: randomInt(1000000, 1000000000),
          timestamp: Math.floor(Date.now() / 1000)};
        const payload = encode({...fields, token: sign(this.key, fields), params});
        if (write) {
          const attempt = Object.freeze({});
          consumeSendReceipt(beforeSend(attempt), attempt);
        }
        const started = performance.now();
        const flushed = Promise.withResolvers();
        const report = (outcome, error) => this.logAttempt({
          path, outcome, elapsedMs: Math.round(performance.now() - started),
          ...(error?.code !== undefined && {code:error.code}), ...(error?.messageLength !== undefined && {messageLength:error.messageLength})
        });
        const response = post(url, path, payload, timeout, flushed.resolve);
        response.then(data => {
          const rows = path === PATHS.orderList && Array.isArray(data?.data) ? data.data
            : path === PATHS.create ? [data] : [];
          for (const row of rows) {
            if (typeof row?.orderNo === 'string') orderResponses.set(row, row.orderNo);
          }
          report('success');
          resolve(data);
        }, error => {
          report(error.kind, error);
          reject(error);
        });
        // 放行下一次发送不依赖本次响应。finish 表示底层 socket 已收到完整请求。
        await flushed.promise;
        this.#lastFlush = performance.now();
      }).catch(error => { clearTimeout(timer); reject(error); });
    });
  }
}
