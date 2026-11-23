import {createHmac, randomInt} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {decimalId, integerDigits, maskNumbers, projectText} from './common.js';
import {consumeSendReceipt, consumeSmsReceipt} from './ledger.js';

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
  create: 'v3/newPattern/cateringApiserver/post/order/v1/create',
  smsSend: 'v3/message/commonSendSmsCaptcha',
  smsCheck: 'v3/message/commonCheckSmsCaptcha'
});
const smsPaths = new Set([PATHS.smsSend, PATHS.smsCheck]);
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
const catalogPaths = new Set([PATHS.stores, PATHS.storeStatus, PATHS.categories, PATHS.categoryItems, PATHS.search, PATHS.item]);
const catalogIntegers = new Set(['salePrice', 'showPriceLow', 'price', 'attachGoodsPrice', 'type', 'status',
  'categorySort', 'openStatus', 'isPractice', 'isAttach', 'clearStatus', 'inventory', 'isRequired']);
const orderIntegerFields = new Set(['userId', 'total', 'status', 'actualAmount', 'discountAmount',
  'discountType', 'discountId', 'goodsId', 'num', 'storeId', 'orderAt', 'createTime']);

export function parseResponse(raw, path) {
  const orderRead = orderReadPaths.has(path);
  return JSON.parse(raw, function (key, value, context) {
    if (key === 'code' && this.status === false) {
      const token = typeof value === 'number' ? context.source : value;
      if (typeof token === 'string' && /[.eE]/.test(token)) {
        const digits = integerDigits(token);
        if (digits === null) return null;
        return typeof value === 'number' ? Number(digits) : digits;
      }
    }
    if (typeof value !== 'number') return value;
    // R23：大整数保留原文之前，先排除以 JSON 数字返回的订单号。
    if ((orderRead || path === PATHS.create) && key === 'orderNo') return null;
    const token = context.source;
    if ((path === PATHS.create && key === 'payAmount')
      || (path === PATHS.coupons && key === 'userCouponCanDisAmount')) return token;
    if (catalogPaths.has(path) && /[.eE]/.test(token)
      && (key === 'id' || key.endsWith('Id') || catalogIntegers.has(key) || Array.isArray(this))) {
      // 做法和加料的数值价格仍以数值透传；只有精确的小整数才能使用解析后的 Number。
      return Number.isSafeInteger(value) && integerDigits(token) !== null ? value : token;
    }
    // 大整数直接取原文。交易证据中的分数和指数也保留词法，让整数校验能识别舍入前的值。
    const integerField = (orderRead && orderIntegerFields.has(key))
      || (path === PATHS.coupons && (['id', 'customerId', 'user_id', 'unUseStatus', 'couponCenterType'].includes(key)))
      || (path === PATHS.member && (key === 'customerId' || key === 'data'));
    return /^-?\d{15,}$/.test(token) || (integerField && /[.eE]/.test(token)) ? token : value;
  });
}

const numericKeys = new Set(['userId', 'customerId', 'goodsId', 'skuId', 'id', 'valueId', 'frontCategoryId', 'storeId', 'shopId']);
function encode(body) {
  return JSON.stringify(body, (key, value) => {
    if (key === 'goodsIds' && (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !decimalId(id)))) {
      throw new Error('企迈请求中的商品编号无效');
    }
    if (key === 'tradeMark' && (typeof value !== 'string' || !decimalId(value))) throw new Error('企迈请求中的商品编号无效');
    if (!numericKeys.has(key)) return value;
    const digits = decimalId(value);
    if (!digits) throw new Error('企迈请求中的标识无效');
    return JSON.rawJSON(digits);
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

function post(url, path, payload, timeout, onFlush, maskText, phone) {
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
            const fallback = path === PATHS.smsSend ? '短信服务暂时不可用' : '未知错误';
            // 11 位电话可用 JSON 数字精确表示，回显时可能丢了前导零。
            const businessCode = Number.isSafeInteger(code) || (typeof code === 'string' && /^\d{1,9}$/.test(code)) ? code : undefined;
            reject(new QmaiError('business', projectText(message, maskText) || fallback, {
              code: phone !== undefined && Number(businessCode) === Number(phone) ? undefined : businessCode,
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
    return this.#read(path, params, options);
  }
  async #read(path, params, options) {
    const backoff = this.config.LICHA_READ_BACKOFF_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#attempt(path, params, options);
      } catch (error) {
        const transient = ['timeout','network','invalid'].includes(error.kind)
          || (error.kind === 'http' && error.statusCode >= 500);
        if (options.retry === false || !transient || attempt >= 2) throw error;
        await delay(backoff[attempt]);
      }
    }
  }
  write(path, params, options = {}) {
    if (path !== PATHS.create || ![true, '1'].includes(this.config.LICHA_ENABLE_ORDERING)) throw new Error('写出口拒绝此请求');
    if (typeof options.beforeSend !== 'function') throw new Error('写出口要求发送前落盘凭据');
    return this.#attempt(path, params, options);
  }

  async sms(path, {phone, bizId, captcha}, {beforeSend} = {}) {
    if (!smsPaths.has(path) || ![true, '1'].includes(this.config.LICHA_ENABLE_ORDERING)) throw Error('短信出口拒绝此请求');
    const c = this.config;
    if (path === PATHS.smsSend) {
      if (typeof beforeSend !== 'function') throw Error('短信出口要求发码前记账凭据');
      const params = {bizId, customerPhone:phone, eventNo:c.LICHA_SMS_EVENT_NO, expireTime:c.LICHA_SMS_CODE_TTL_SEC, source:3};
      // 企迈可能将号码或自行生成的验证码写进拒绝文案。只投影去除数字和凭证后的说明。
      const maskText = value => {
        for (const secret of [bizId, c.QMAI_OPEN_KEY, c.QMAI_OPEN_ID, c.QMAI_GRANT_CODE, ...c.LICHA_ACCESS_KEYS]) {
          if (secret) value = value.replaceAll(secret, '***');
        }
        return value.replace(/\d+/g, '***');
      };
      await this.#attempt(path, params, {beforeSend, maskText});
      return true;
    }
    try {
      const data = await this.#attempt(path, {bizId, captcha, phone}, {});
      return data == null || data === true || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0);
    } catch (error) {
      if (error.kind === 'business') return false;
      throw error;
    }
  }

  #attempt(path, params, {beforeSend, maskCouponIds, maskText = maskCouponIds ?? maskNumbers}) {
    const c = this.config;
    if (!this.key?.length || !c.QMAI_OPEN_ID || !c.QMAI_GRANT_CODE) throw new QmaiError('credentials', MISSING_CREDENTIALS);
    const write = path === PATHS.create || smsPaths.has(path);
    const phone = path === PATHS.create ? params.mobile : path === PATHS.member ? params.customerCode?.code : undefined;
    const project = phone === undefined ? maskText : text => {
      const normalized = String(Number(phone));
      return maskText(text).replaceAll(phone, '***').replace(/\d+/g, digits => digits === normalized ? '***' : digits);
    };
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
        if (path === PATHS.create || path === PATHS.smsSend) {
          const attempt = Object.freeze({});
          const receipt = beforeSend(attempt);
          if (path === PATHS.smsSend) consumeSmsReceipt(receipt, attempt, params.customerPhone);
          else consumeSendReceipt(receipt, attempt);
        }
        const started = performance.now();
        const flushed = Promise.withResolvers();
        const report = (outcome, error) => {
          const code = error?.code;
          this.logAttempt({path, outcome, elapsedMs:Math.round(performance.now() - started),
            ...(code !== undefined && !(smsPaths.has(path) && /\d{4}/.test(code)) && {code}),
            ...(error?.messageLength !== undefined && {messageLength:error.messageLength})});
        };
        const response = post(url, path, payload, timeout, flushed.resolve, project, phone);
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
