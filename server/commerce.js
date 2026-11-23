import { createBindingFlow, memberView } from './binding.js';
import { isDeepStrictEqual } from 'node:util';
import { currentQuotaDay, issueConfirmation } from './logs.js';
import { beijingTime, couponInstanceId, couponTextMask, decimalId, digest, responseId, yuan } from './common.js';
import { PATHS, readHint } from './qmai.js';
import { Ledger } from './ledger.js';
import { couponView, listedProducts, sameProducts, nonnegativeInteger, pendingCount, orderNumber, orderView, placedView, reconciledPaymentNote, rowTime, statusView, toFen } from './commerce-view.js';

const bookProblem = '安全账本不可用，已拒绝下单。未决核对、当日额度、防重复都靠这本账本，读不出它就等于没有护栏。请稍后再试或直接在小程序下单；看菜单和查订单不受影响。';
const missingToken = '确认令牌无效（不存在或已被使用过）：请重新调用 prepare_order 组单，把新的待确认单念给顾客确认。';
const replaced = '这张待确认单已被更新的一版替代（顾客之后又重新组过单），不能再提交。请按最后念给顾客的那张确认；要用这一版就重新组单。';
const forbidden = new Set(['isPre', 'preTime', 'preTimeStart', 'preTimeEnd', 'isWaiterCheck', 'orderSubType', 'payModel']);
const couponKeys = new Set(['lastSelect', 'attendCouponIds', 'attendCouponType', 'useCouponId', 'couponId']);
const dayMs = 86400000;

function couponFields(choice, id) {
  if (choice === 'default') return {};
  return { lastSelect: { type: -1, value: choice === 'specific' ? id : '' },
    attendCouponIds: choice === 'specific' ? [id] : [], attendCouponType: 1 };
}

export function checkOrderFields(params, couponChoice = 'default', chosenId) {
  function rejectCoupon(path) {
    throw Error(`组单自检失败：下单参数里的用券字段与本单的用券选择不符（命中路径：${path}）`);
  }
  if (couponChoice === 'specific' && (typeof chosenId !== 'string' || couponInstanceId(chosenId) !== chosenId)) {
    rejectCoupon('params.lastSelect');
  }
  const expected = couponFields(couponChoice, chosenId);
  function visit(value, path) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
      if (forbidden.has(key)) throw Error(`组单自检失败：下单参数不得包含预约单字段 ${key}（命中路径：${childPath}）`);
      if (couponKeys.has(key) && !(value === params && Object.hasOwn(expected, key))) {
        rejectCoupon(childPath);
      }
      if (child && typeof child === 'object') visit(child, childPath);
    }
  }
  visit(params, 'params');
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.hasOwn(params, key) || !isDeepStrictEqual(params[key], value)) rejectCoupon('params.' + key);
  }
}

function unknownMessage(error) {
  const reason = {
    timeout: '请求已经发出去了，但门店系统没回话', http: `门店系统返回了错误（HTTP ${error.statusCode}）`,
    network: '网络中断'
  }[error.kind] || '门店系统的回执没法确认这一单';
  return `下单结果未知：${reason}，单子可能已经生成。请先让顾客打开小程序「我的订单」看一眼，有单就直接付款；我这边核对清楚之前不会再下新单。`;
}

function queryError(error, fallback) {
  if (error.kind === 'credentials') return error.message;
  return error.kind === 'business' ? (error.message === '未知错误' ? fallback : error.message) : readHint(error);
}

const owner = row => responseId(row?.userId);

export async function createCommerce(config, qmai, browse, logs) {
  const book = new Ledger(config.LICHA_DATA_DIR);
  if (book.fault) console.error(book.faultReason ?? '安全账本不可用，需要人工检查；已停用下单。');
  const bindings = new Map();
  const drafts = new Map();
  const flights = new Map();
  const bindingFlow = createBindingFlow({ config, qmai, book, logs, bindings, unresolved,
    discardDrafts: (device, hash) => supersede(draft => draft.device === device && draft.hash === hash, 'rebound') });
  const tokenTtl = config.LICHA_CONFIRM_TOKEN_TTL_MS;
  const minutes = tokenTtl / 60000;
  const windowMs = config.LICHA_ORDER_MATCH_WINDOW_MS;

  function sweep(now) {
    for (const [device, binding] of bindings) {
      if (now - binding.touched > config.LICHA_BINDING_IDLE_TTL_MS && !binding.busy) {
        bindings.delete(device);
        for (const [token, draft] of drafts) if (draft.device === device) drafts.delete(token);
      }
    }
    for (const [token, draft] of drafts) if (now >= draft.expires + tokenTtl) drafts.delete(token);
    bindingFlow.sweep(now);
  }

  function supersede(match, state = 'replaced') {
    let count = 0;
    const now = Date.now();
    for (const draft of drafts.values()) {
      if (draft.state === 'ready' && match(draft)) {
        if (now < draft.expires) count++;
        draft.state = state;
        delete draft.paramsJson;
      }
    }
    return count;
  }

  function unresolved(hash) {
    return book.unresolved(hash).filter(row => !flights.has(row.key));
  }

  function requireBinding(name, device) {
    const binding = bindings.get(device);
    if (!binding) {
      logs.access({event:'unbound', tool:name}, {device});
      throw Error('本会话尚未绑定会员身份，请先用 bind_member 绑定' + (name === 'place_order' ? '后再下单' : ''));
    }
    return binding;
  }

  async function prepare(args, b, device) {
    const { couponChoice = 'default', couponRef } = args;
    if ((couponChoice === 'specific') !== (couponRef !== undefined)) {
      throw Error('用券选择与券编号不配套：指定用某张券时要带上那张券的 couponRef；不指定时不要带 couponRef。');
    }
    const selected = b.couponRefs.get(couponRef);
    if (couponChoice === 'specific' && !selected) {
      throw Error('这张券的编号已失效（换过会员、绑定过期或服务重启都会失效）。请先不带 couponChoice 重新组单，从新列出的可用券里取 ref。');
    }
    if (book.fault) throw Error(bookProblem);
    const { totalFen, lines, orderItems, tradeMarks, productEvidence } = await browse.quote(args, true);
    if (totalFen > config.LICHA_MAX_ORDER_AMOUNT_FEN) throw Error(`单笔金额超上限：本单预估 ¥${yuan(totalFen)}，上限 ¥${yuan(config.LICHA_MAX_ORDER_AMOUNT_FEN)}。请减少商品后重新组单。`);
    const storeId = String(args.storeId);
    const params = { storeId, items: orderItems, orderType: 1, source: 18, userId: b.id,
      channelCode: 'AI_AGENT', scene: 'AI_AGENT', member: true,
      ...(b.phone && { mobile: b.phone, reservePhone: b.phone }),
      ...couponFields(couponChoice, selected?.id) };
    checkOrderFields(params, couponChoice, selected?.id);
    const paramsJson = JSON.stringify(params);
    let store;
    try { store = await browse.storeForOrder(storeId); } catch { /* 门店名录失败时仍可按门店 ID 组单 */ }
    let rows;
    const hasCode = !!store?.shopCode.trim();
    if (couponChoice !== 'none' && hasCode) {
      try {
        const data = await qmai.read(PATHS.coupons, {
          customerId: b.id, discountPrice: 0, multiMark: store.shopCode, typeCate: 1, tradeMarks
        }, { retry: false });
        rows = Array.isArray(data) ? data : data?.list;
      } catch { /* couponView 按选择处理未查到的券信息 */ }
    }
    const maskCouponIds = couponTextMask(rows);
    const { coupons, prediction } = couponView(rows, totalFen, !store || hasCode, couponChoice, b, selected, maskCouponIds);
    if (book.fault) throw Error(bookProblem);
    const now = Date.now();
    const confirmation = issueConfirmation();
    const confirmToken = confirmation.token;
    const discarded = supersede(draft => draft.hash === b.hash);
    drafts.set(confirmToken, { confirmation, paramsJson, couponChoice, maskCouponIds,
      ...(selected && { chosenCoupon: { id: selected.id, ...coupons.chosen } }),
      totalFen, products: productEvidence, prediction, storeId, hash: b.hash,
      device, expires: now + tokenTtl, state: 'ready' });
    logs.access({event:'prepare_order',totalFen}, {device,memberId:b.id,confirmation});
    const result = { confirmToken, member: memberView(b), store: { storeId, ...(store?.name && { name: maskCouponIds(store.name) }) },
      lines: lines.map(line => ({ ...line, name: maskCouponIds(line.name), specName: maskCouponIds(line.specName),
        practices: line.practices.map(maskCouponIds), attaches: line.attaches.map(maskCouponIds) })),
      estimatedTotalYuan: yuan(totalFen), coupons };
    const recent = [...book.records.values()].filter(row => row.memberHash === b.hash && orderNumber(row)
      && (row.state === 'success' || row.state === 'found'))
      .map(row => ({ row, at: row.state === 'found' ? row.time : row.completedAt }))
      .filter(entry => now - entry.at <= config.LICHA_RECENT_ORDER_HINT_MS).sort((a, b) => b.at - a.at)[0];
    if (recent) {
      const { row, at } = recent;
      const estimatedTotalYuan = yuan(row.totalFen);
      result.recentOrder = { orderNo: row.orderNo, orderTime: beijingTime(at), estimatedTotalYuan,
        note: `这位会员 ${Math.floor((now - at) / 60000)} 分钟前刚下过一单（${row.orderNo}，预估 ¥${estimatedTotalYuan}）。念单前先问顾客是不是要再下一单；如果顾客只是没看到上一单的结果，请用 my_orders 确认，不要重复下单。` };
    }
    if (discarded) Object.assign(result, { supersededPendingOrders: discarded,
      supersedeNote: '顾客之前还没确认的那张待确认单已作废，只有这张能提交；别拿旧的 confirmToken。' });
    return { ...result, pickup: '堂食（本店当前只开堂食）：付款后按小程序订单页的提示取餐', expiresInMinutes: minutes,
      note: `请把以上内容逐项念给顾客确认（下到哪位会员名下、门店、每杯商品与规格做法、杯数、总金额）。coupons.predicted 存在时，念完合计再按 coupons.note 说一句系统默认会用哪张券、实付大约多少；coupons.choice 为 none 或 specific 时，念完合计按 coupons.note 说一句这单不用券 / 用哪张券；其余情况不提券。顾客确认后调用 place_order，传入 confirmToken 与你刚念出的总金额（元，是券前的预估合计，不是券后实付）。令牌 ${minutes} 分钟内有效、只能用一次，过期请重新组单。` };
  }

  function deviceDraft(confirmToken, device) {
    const draft = drafts.get(confirmToken);
    return draft?.device === device ? draft : undefined;
  }

  function logPlaceRejection(reason, confirmToken, device) {
    const draft = deviceDraft(confirmToken, device);
    logs.write({outcome:'rejected', reason, couponChoice:draft?.couponChoice},
      {device, confirmation:draft?.confirmation});
  }

  async function place({ confirmToken, confirmAmountYuan }, device) {
    const start = Date.now();
    const audit = {tokenId:confirmToken};
    const source = {device};
    function log(outcome, reason, extra) {
      logs.write({ ...audit, outcome, reason, durationMs: Date.now() - start, ...extra }, source);
    }
    function reject(reason, message) {
      log('rejected', reason);
      throw Error(message);
    }
    let b;
    try { b = requireBinding('place_order', device); } catch (e) { reject('WRT-02', e.message); }
    source.memberId = b.id;
    const draft = deviceDraft(confirmToken, device);
    if (!draft) reject('WRT-03', missingToken);
    source.confirmation = draft.confirmation;
    audit.couponChoice = draft.couponChoice;
    if (start >= draft.expires) reject('WRT-03', `确认令牌已过期（有效期 ${minutes} 分钟）：请重新调用 prepare_order 组单，把新的待确认单念给顾客确认。`);
    if (draft.state === 'replaced') reject('WRT-03', replaced);
    if (draft.state === 'submitted') reject('WRT-03', missingToken);
    if (draft.hash !== b.hash) reject('WRT-04', '这张待确认单不属于当前绑定的会员，已拒绝。请重新用 prepare_order 组单。');
    if (draft.state !== 'ready') reject('WRT-03', missingToken);
    const key = digest(confirmToken);
    const params = JSON.parse(draft.paramsJson);
    Object.assign(audit, { storeId: draft.storeId, totalFen: draft.totalFen,
      lineCount: params.items.length, cupCount: params.items.reduce((sum, item) => sum + item.num, 0) });
    if (Number(confirmAmountYuan.toFixed(2)) !== confirmAmountYuan) reject('WRT-05',
      '复述金额要照待确认单上的金额，用两位小数（如 24.00）。请按待确认单的金额重新向顾客确认后再提交。');
    const amount = toFen(confirmAmountYuan);
    if (amount === null || Math.abs(amount - draft.totalFen) > 1) reject('WRT-05',
      `复述金额与待确认单不一致：你报的是 ¥${amount === null ? '超出范围' : yuan(amount)}，待确认单是 ¥${yuan(draft.totalFen)}。请按待确认单的金额重新向顾客确认，不要凭记忆报数。`);
    if (book.fault) reject('WRT-06', bookProblem);
    const pending = unresolved(b.hash);
    if (pending.length) reject('WRT-07', `上一次下单请求的结果还没有核对清楚（${pendingCount(pending)}），暂不放行新的下单。\n那次请求可能已经在企迈侧真的建了单——现在直接重下会变成两单、扣两次钱。\n请先调用 my_orders（查最近订单）核对企迈侧到底有没有那一单：\n　· 已经有那一单 → 不要再下，直接引导顾客去小程序付款；\n　· 确实没有那一单 → 核对动作本身会解除这道闸门，再重新走一次 prepare_order 组单即可。`);
    if (!(draft.totalFen > 0) || draft.totalFen > config.LICHA_MAX_ORDER_AMOUNT_FEN) reject('WRT-08',
      `单笔金额超上限（¥${yuan(config.LICHA_MAX_ORDER_AMOUNT_FEN)}），已拒绝下单。请减少商品后重新组单。`);
    if ([...flights.values()].some(row => row.memberHash === b.hash)) reject('WRT-09_in_flight',
      '这位会员的上一笔下单还在处理中，请等它有结果后再试，不要重复提交。');
    // 已经落盘的在途请求只从账本计一次；排队中的占位从内存计。
    const reservation = currentQuotaDay();
    const day = reservation.day;
    const occupied = [...book.records.values(), ...[...flights.values()].filter(row => !book.records.has(row.key))]
      .filter(row => row.day === day && row.state !== 'failed');
    if (occupied.filter(row => row.memberHash === b.hash).length >= config.LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY)
      reject('WRT-09_member', `今天的下单次数已到上限（每位会员每天最多 ${config.LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY} 单）。明天可以继续，或者这一单直接在小程序里下。`);
    if (occupied.length >= config.LICHA_MAX_ORDERS_PER_DAY) reject('WRT-09_global',
      '今天 AI 点单的总单量已到上限，暂时不能再下单。这一单可以直接在小程序里下。');
    const record = { key, memberHash: b.hash, day, storeId: draft.storeId, totalFen: draft.totalFen,
      products: draft.products, couponChoice: draft.couponChoice, state: 'sent' };
    flights.set(key, record);
    source.reservation = reservation;
    draft.state = 'submitted';
    delete draft.paramsJson;
    let created;
    try {
      if (book.records.get(key)?.state === 'success') reject('WRT-10', '这张待确认单已经下过单了，不能重复提交。要再买一单请重新组单。');
      try { checkOrderFields(params, draft.couponChoice, draft.chosenCoupon?.id); }
      catch (error) { reject('WRT-10', error.message); }
      let recorded = false;
      try {
        created = await qmai.write(PATHS.create, params, { maskCouponIds: draft.maskCouponIds, beforeSend(attempt) {
          record.time = Date.now();
          const receipt = book.recordSending(record, attempt);
          recorded = true;
          log('sending', 'WRT-11');
          return receipt;
        } });
        const orderNo = orderNumber(created);
        if (!orderNo) throw Object.assign(Error(), { kind: 'invalid' });
        source.order = created;
      } catch (error) {
        if (!recorded) {
          if (error.kind === 'queue_timeout') reject('queue_timeout', '门店系统这会儿排队的人多，这次下单请求没有发出。请稍后重新组单再试。');
          if (error.kind === 'credentials') reject('credentials', error.message);
          reject('ledger_failure', '安全账本写入失败，本次下单请求没有发出。请稍后重新组单再试。');
        }
        if (error.kind === 'business') {
          const hint = { 110004: '验签失败，检查凭证配置', 100002: '参数格式不对', 100007: '搜索词为空或不支持' }[error.code] || '接口暂时异常，换个问法试试';
          try { book.update({ ...record, state: 'failed' }); } catch { /* 重启后可能仍是未决，当场应返回上游的明确失败。 */ }
          log('failed', 'business', { qmaiCode: error.code, messageLength: error.messageLength });
          throw Error(`下单失败：${error.message || '未知错误'}（${hint}）。这一单没有创建，可以调整后重新组单。`);
        }
        try { book.update({ ...record, state: 'unknown', reason: error.kind || 'invalid' }); }
        catch { /* 两种提交结果都保留未决。 */ }
        log('unknown', error.kind || 'invalid');
        throw Error(unknownMessage(error));
      }
      try {
        book.update({ ...record, state: 'success', orderNo: created.orderNo, completedAt: Date.now() });
      } catch { /* 仍应向顾客如实返回企迈订单号 */ }
      log('success', book.fault ? 'terminal_save_failed' : 'created');
    } finally {
      flights.delete(key);
    }
    let detail, readError;
    try { detail = await qmai.read(PATHS.orderDetail, { orderNo: created.orderNo, bizType: 5, userId: b.id },
      { maskCouponIds: draft.maskCouponIds }); }
    catch (error) { readError = queryError(error, '响应为空'); }
    const result = placedView(created, detail, readError, draft, b);
    if (result.readbackFailed) {
      const reason = !detail || !Object.keys(detail).length ? 'unavailable'
        : detail.orderNo !== created.orderNo ? 'order_mismatch'
        : owner(detail) !== b.id ? 'ownership_rejected' : 'missing_amount';
      logs.access({event:'readback_failed', reason}, {device,memberId:b.id,order:created});
    }
    return result;
  }

  async function status({ orderNo }, b, device) {
    let row;
    try { row = await qmai.read(PATHS.orderStatus, { orderNo }); }
    catch (error) { throw Error(queryError(error, '查询失败：查无此单或接口异常')); }
    if (!row || typeof row !== 'object') throw Error('查询失败：查无此单或接口异常');
    if (Object.hasOwn(row, 'orderNo') && orderNumber(row) !== orderNo) throw Error('查询失败：返回的订单号与查询不符');
    if (owner(row) !== b.id) {
      logs.access({event:'ownership_rejected', orderNo}, {device,memberId:b.id});
      throw Error('无法查询：该订单不属于当前绑定的会员');
    }
    const result = { orderNo, ...statusView(row.status, true) };
    const pending = unresolved(b.hash);
    if (pending.length) Object.assign(result, { unresolvedPendingWrites: pending.length,
      pendingWriteNote: '此前有下单请求结果未知、下单闸门仍然关着。这一次按单号查到的单不能用来核对那笔请求——订单状态接口的回执里没有下单时间，无法判断它是不是那一次建出来的。请改用 my_orders（按时间段列最近订单）核对，那条路径带下单时间。' });
    return result;
  }

  async function orders({ days = 7 }, b, device) {
    const end = Date.now();
    const start = end - days * dayMs;
    // 列表返回时可能已有其他设备提交新单；旧查询不能核对在它之后才出现的未决。
    const eligible = new Set(unresolved(b.hash).map(row => row.key));
    let data;
    try { data = await qmai.read(PATHS.orderList, { orderAtStart: start, orderAtEnd: end, pageNo: 1, pageSize: 10, userId: b.id }); }
    catch (error) { throw Error('查询订单列表失败：' + queryError(error, '接口异常')); }
    if (!Array.isArray(data?.data)) throw Error('查询订单列表失败：接口异常');
    const visible = [];
    let outOfRange = 0, discarded = 0, unverifiedNotShown = 0;
    let hasMissingOwner = false;
    for (const row of data.data) {
      const missingOwner = row?.userId === undefined;
      // 即使时间越界，归属缺失也意味着上游可能给错了页，不能据此判无单。
      if (missingOwner) hasMissingOwner = true;
      const time = rowTime(row);
      if (time !== null && (time < start || time > end)) outOfRange++;
      else if (!orderNumber(row)) discarded++;
      else if (missingOwner) unverifiedNotShown++;
      else if (owner(row) !== b.id) discarded++;
      else visible.push(row);
    }
    if (outOfRange) logs.access({event:'orders_out_of_range', count:outOfRange}, {device,memberId:b.id});
    if (discarded) logs.access({event:'ownership_rejected', count:discarded}, {device,memberId:b.id});
    const list = visible.slice(0, 10).map(orderView);
    const result = { days, count: list.length, member: memberView(b), ...(discarded && { discardedNotOwned: discarded }),
      orders: list, note: `只列出最近 ${days} 天、最多 10 条本人订单。要看某一单的最新状态用 get_order_status。` };
    if (unverifiedNotShown) {
      result.unverifiedNotShown = unverifiedNotShown;
      result.note += `另有 ${unverifiedNotShown} 条订单门店系统没标明属于哪位会员，没有展示；请在小程序「我的订单」里查看。`;
    }
    const total = nonnegativeInteger(data.total);
    const evidence = visible.map(row => ({
      row, time: rowTime(row), products: listedProducts(row),
      store: Object.hasOwn(row, 'storeId') ? responseId(row.storeId) : undefined
    }));
    const distinctOrderNos = new Set(evidence.filter(entry => entry.time !== null).map(entry => entry.row.orderNo));
    const complete = total !== null && total <= distinctOrderNos.size && !discarded && !hasMissingOwner
      && evidence.every(entry => entry.time !== null && entry.store !== null && entry.products !== null);
    const known = book.knownOrders();
    const found = [];
    let absent = 0;
    const notes = [];
    for (const record of unresolved(b.hash)) {
      if (!eligible.has(record.key)) continue;
      const windowStart = record.time - windowMs;
      const windowEnd = record.time + windowMs;
      const nearby = evidence.filter(entry => entry.time !== null && entry.time >= windowStart && entry.time <= windowEnd);
      const candidates = nearby.filter(({row, store, products}) => !known.has(row.orderNo)
        && (store === undefined || (store !== null && store === decimalId(record.storeId))) && sameProducts(record.products, products));
      let match;
      if (candidates.length === 1) match = candidates[0].row;
      else if (!(complete && !nearby.length
        && start <= windowStart && end >= windowEnd)) continue;
      const state = match ? 'found' : 'absent';
      const orderNo = orderNumber(match);
      try { book.update({ ...record, state, ...(match && { orderNo }), resolvedAt: Date.now() }); }
      catch {
        notes.push((match ? `查到了对应订单（${orderNo}），但` : '')
          + '核对结论暂时没能保存，下单闸门还关着。请稍后再查一次。');
        break;
      }
      if (match) { known.add(orderNo); found.push(match); } else { absent++; }
      logs.write({outcome:'resolved', reason:state},
        {device,memberId:b.id,order:match,ledgerRecord:record});
    }
    if (found.length) {
      notes.push(`核对结果：此前 ${found.length} 笔结果未知的下单请求，在企迈侧查到了与它吻合的订单（${found.map(orderNumber).join('、')}），按这张处理，不要重下。`
        + reconciledPaymentNote(found));
    }
    if (absent) notes.push(`核对结果：此前 ${absent} 笔结果未知的下单请求，在这段时间里没有对应订单——企迈侧没有建单，可以重新走 prepare_order 组单。`);
    const remaining = unresolved(b.hash);
    if (remaining.length) {
      const manual = remaining.some(row => row.time - windowMs < end - 90 * dayMs || (end >= row.time + windowMs && (days === 90 || total > 10)));
      notes.push(manual ? `仍有 ${remaining.length} 笔下单请求用现有办法核对不了。请顾客先在小程序「我的订单」里看一眼那一单在不在，并联系门店人工核对；核对清楚之前这位会员暂时不能通过 AI 下单。确认那一单不在之后，可以直接在小程序里下。`
        : `仍有 ${remaining.length} 笔下单请求无法核对，下单闸门继续关着。可能的原因：它发生在本次查询的时间范围之外（用更大的 days 再查一次）、或本次返回的列表不完整、或它刚发出不久——订单可能还在门店系统落库，过 ${windowMs / 60000} 分钟再查一次才能下结论。在此期间请如实告诉顾客「那一单还没核对清楚，先别重下」，不要替他猜结果。`);
      result.unresolvedPendingWrites = remaining.length;
    }
    if (found.length + absent) result.resolvedPendingWrites = found.length + absent;
    if (notes.length) result.pendingWriteNote = notes.join('\n');
    return result;
  }

  async function call(name, args, device) {
    sweep(Date.now());
    const current = bindings.get(device);
    if (current) current.busy = true;
    try {
      let result;
      if (name === 'place_order') result = await place(args, device);
      else if (name === 'bind_member') result = await bindingFlow.bind(args, device);
      else {
        const binding = requireBinding(name, device);
        const handler = { prepare_order: prepare, get_order_status: status, my_orders: orders }[name];
        result = await handler(args, binding, device);
      }
      if (name !== 'bind_member' || result.bound) bindings.get(device).touched = Date.now();
      return result;
    } finally {
      if (current) current.busy = false;
    }
  }
  const cleanup = setInterval(() => sweep(Date.now()), Math.min(60000, tokenTtl, config.LICHA_BINDING_IDLE_TTL_MS)).unref();
  function isDeviceCouponRef(device, key) {
    return !!bindings.get(device)?.couponRefs.get(key);
  }
  return { call, logPlaceRejection, isDeviceCouponRef, close() { clearInterval(cleanup); book.close(); } };
}
