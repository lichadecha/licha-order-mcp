import { beijingTime, couponInstanceId, digest, integerDigits, projectText, responseId, yuan } from './common.js';

export const pendingCount = rows => `${rows.length} 笔状态未知${rows[0]?.time ? '，最早一笔发生在 ' + beijingTime(rows[0].time) : ''}`;

export function toFen(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value).trim());
  if (!match) return null;
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return 0;
  if (sign) return null;
  // 小数点右移两位后，截取整分，只用下一位决定四舍五入。
  const point = digits.length - fraction.length + Number(exponent) + 2;
  if (point < 0) return 0;
  if (point > String(Number.MAX_SAFE_INTEGER).length) return null;
  const wholeFen = BigInt(digits.slice(0, point).padEnd(point, '0'));
  const fen = digits[point] >= '5' ? wholeFen + 1n : wholeFen;
  return fen <= Number.MAX_SAFE_INTEGER ? Number(fen) : null;
}

export function nonnegativeInteger(value) {
  const digits = integerDigits(value);
  if (digits === null) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

function eligibleCouponRows(rows, memberId) {
  const instances = new Map();
  for (const row of rows) {
    const id = couponInstanceId(row?.id);
    const owners = ['customerId', 'user_id'].filter(key => row != null && Object.hasOwn(row, key));
    const wrongOwner = owners.some(key => responseId(row[key]) !== memberId);
    const rawTitle = typeof row?.title === 'string' ? row.title : '';
    const usable = nonnegativeInteger(row?.unUseStatus) === 1;
    const fen = toFen(row?.userCouponCanDisAmount) ?? 0;
    const type = nonnegativeInteger(row?.couponCenterType);
    const reason = typeof row?.unUseDesc === 'string' ? row.unUseDesc : '';
    const existing = instances.get(id);
    if (existing) {
      existing.excluded ||= wrongOwner || existing.usable !== usable || existing.fen !== fen || existing.rawTitle !== rawTitle;
      existing.hasOwner ||= owners.length > 0;
      if (existing.type !== type) existing.type = null;
      if (existing.reason !== reason) existing.reason = '';
    } else {
      // 没有 ID 的行彼此无法认定为同一张券，逐行列出。
      instances.set(id ?? Symbol(), { id, usable, fen, rawTitle, type, reason, hasOwner: owners.length > 0, excluded: wrongOwner });
    }
  }
  return [...instances.values()].filter(row => !row.excluded);
}

export function couponView(rows, totalFen, hasCode, choice, binding, selected, maskCouponIds) {
  if (choice === 'none') {
    return { coupons: { choice, note: '顾客选了这单不用券。念完合计要加一句：「这单按你说的不用券。」下单后会核对门店系统有没有照办。' } };
  }
  const usable = [];
  const unusable = [];
  const coupons = { choice, available: Array.isArray(rows), usable, unusable };
  if (!coupons.available) {
    if (choice === 'specific') throw Error(hasCode
      ? '券信息暂时没查到，没法确认这张券能不能用，所以这次不能指定用券。可以按默认或不用券组单，或稍后再试。'
      : '这家门店暂时查不了券，没法指定用券。可以按默认或不用券组单。');
    coupons.note = hasCode
      ? '券信息暂时没查到。念单时优惠一项说：「系统没提示会用券，以门店收银台为准。」下单后以门店系统读回的实付为准，如有优惠会在读回里体现。'
      : '这家门店暂时查不了券；下单后以门店系统读回的实付为准。';
    return { coupons };
  }
  const eligible = eligibleCouponRows(rows, binding.id);
  let chosen;
  if (choice === 'specific') {
    chosen = eligible.find(row => row.id === selected.id);
    if (!chosen?.hasOwner || !chosen.usable || chosen.fen <= 0) {
      const reason = projectText(chosen?.reason, maskCouponIds);
      throw Error(`「${maskCouponIds(selected.title)}」这单用不了${reason ? '：' + reason : ''}。可以换一张，或按默认、不用券组单。`);
    }
  }
  for (const row of eligible) {
    const title = projectText(row.rawTitle, maskCouponIds) || '（未命名的券）';
    if (!row.usable) {
      unusable.push({ title, reason: projectText(row.reason, maskCouponIds) || '本单不可用' });
      continue;
    }
    const { id, fen, type } = row;
    const entry = { ...(id && row.hasOwner && { ref: binding.couponRefs.issue(id, title) }),
      title, canDisYuan: yuan(fen), ...(type !== null && { couponCenterType: type }) };
    usable.push(entry);
    if (choice === 'default' && entry.ref && fen > 0 && fen < totalFen && (!chosen || fen > chosen.fen)) {
      chosen = row;
    }
  }
  if (chosen) {
    const title = projectText(chosen.rawTitle, maskCouponIds) || '（未命名的券）';
    const canDisYuan = yuan(chosen.fen);
    const payAfterYuan = yuan(Math.max(0, totalFen - chosen.fen));
    coupons.chosen = { title, canDisYuan, payAfterYuan };
    if (choice === 'specific') {
      coupons.note = `顾客指定用『${title}』。念完合计要加一句：「这单用你的『${title}』，省 ${canDisYuan} 元，实付大约 ¥${payAfterYuan}。」下单后会核对门店系统用的是不是这张。`;
    } else {
      coupons.autoPicked = true;
      coupons.note = usable.length === 1
        ? `顾客有 1 张券可用于本单，系统替顾客选了『${title}』，下单时会指定用这张。念完合计要加一句：「这单会用你的『${title}』，省 ${canDisYuan} 元，实付大约 ¥${payAfterYuan}；不想用券的话跟我说。」顾客说不用，就带 couponChoice="none" 重新组单；顾客没意见就照这张待确认单下单。`
        : `顾客有 ${usable.length} 张券可用于本单，系统替顾客选了抵得最多的『${title}』（省 ${canDisYuan} 元，实付大约 ¥${payAfterYuan}），下单时会指定用这张。念完合计要把 usable 里的券逐张念给顾客（券名、能省多少），然后问：「用这张、换一张，还是这单不用券？」顾客说用这张或随便，就照这张待确认单下单；点名另一张（只能是带 ref 的），就带 couponChoice="specific" 和那张的 ref 重新组单；说不用券，就带 couponChoice="none" 重新组单。`;
    }
    return { coupons, chosenId: chosen.id };
  }
  if (eligible.some(row => row.usable && row.fen > 0)) {
    const reason = eligible.some(row => row.usable && row.fen > 0 && row.id && row.hasOwner)
      ? '能用的券会把这单抵成 0 元，用不用要顾客自己定' : '这些券缺少指定所需的信息';
    coupons.note = `顾客有 ${usable.length} 张券可用于本单，但系统这次没法替顾客挑（${reason}）。念单时优惠一项说：「门店系统可能会自动用你的一张券，实付以下单后为准；想指定用哪张或不用券跟我说。」顾客点名 usable 里带 ref 的某一张，就带 couponChoice="specific" 和那张的 ref 重新组单；说不用券，就带 couponChoice="none" 重新组单。`;
  } else if (usable.length) {
    coupons.note = '查到可用券但抵扣金额都为 0。念单时优惠一项说：「系统没提示会用券，以门店收银台为准。」';
  } else {
    coupons.note = `顾客没有可用于本单的券${unusable.length ? '（' + unusable.length + ' 张不可用）' : ''}。念单时优惠一项说：「系统没提示会用券，以门店收银台为准。」`;
  }
  return { coupons };
}

// 企迈契约 §4 提供了这些非券类型；新类型需有依据才能分类。
const otherDiscountTypes = new Set([3, 5, 6, 8, 10, 12, 21, 70, 71]);

function discountView(detail, { couponChoice, chosenCoupon, maskCouponIds }, actualFen) {
  const noCoupon = couponChoice === 'none';
  const couponIds = [];
  const items = [];
  const totalFen = nonnegativeInteger(detail.discountAmount);
  const listIsArray = Array.isArray(detail.discountList);
  const zeroDiscount = totalFen === 0 && (listIsArray || !Object.hasOwn(detail, 'discountList'));
  let itemSumFen = 0;
  if (listIsArray) {
    for (const raw of detail.discountList) {
      const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const fen = nonnegativeInteger(row.discountAmount);
      itemSumFen = itemSumFen === null || fen === null ? null : itemSumFen + fen;
      const type = nonnegativeInteger(row.discountType);
      const name = projectText(row.discountName, maskCouponIds) || '优惠';
      const summary = projectText(row.discountSummary, maskCouponIds);
      const entry = { name, ...(summary && { summary }), amountYuan: fen === null ? null : yuan(fen) };
      if (type === 2 || otherDiscountTypes.has(type)) entry.isCoupon = type === 2;
      if (chosenCoupon && entry.isCoupon) couponIds.push(couponInstanceId(row.discountId));
      items.push(entry);
    }
  }
  if (!chosenCoupon && !noCoupon && !items.length) return;
  const result = { items };
  const totalMismatch = items.length > 0 && totalFen !== null && itemSumFen !== null && itemSumFen !== totalFen;
  const description = items.map(item => (item.summary || item.name)
    + (item.amountYuan === null ? '（金额未知）' : `（抵 ¥${item.amountYuan}）`)).join('；');
  if (chosenCoupon) {
    const title = chosenCoupon.title;
    const knownTypes = items.every(item => item.isCoupon !== undefined);
    const rejection = '请先如实告诉顾客，并说明付款页改不了券；这种情况我们这边改不了，不要重新组单再下。';
    // 已知用了别的券就足以判定未照办。要确认只用了指定的券，还须排除其余条目的歧义。
    if (couponIds.some(id => id !== null && id !== chosenCoupon.id)) {
      result.matchesChoice = false;
      result.note = `顾客指定了『${title}』，但门店系统读回用的是：${description}。${rejection}`;
    } else if (knownTypes && !totalMismatch && couponIds.length === 1 && couponIds[0] === chosenCoupon.id) {
      result.matchesChoice = true;
      const extraFen = actualFen - toFen(chosenCoupon.payAfterYuan);
      result.amountAsPromised = extraFen <= 0;
      if (result.amountAsPromised) {
        result.note = `按顾客的选择用了『${title}』：${description}。`;
      } else {
        const { amountYuan } = items.find(item => item.isCoupon);
        const discount = amountYuan === null ? '实际抵了多少没读到' : `只抵了 ¥${amountYuan}`;
        result.note = `用了顾客指定的『${title}』，但这张${discount}（念单时说省 ¥${chosenCoupon.canDisYuan}），实付 ¥${yuan(actualFen)}，比念单时说的 ¥${chosenCoupon.payAfterYuan} 多 ¥${yuan(extraFen)}。请先如实告诉顾客这个差额，并说明付款页改不了券；这种情况我们这边改不了，不要重新组单再下。`;
      }
    } else if (knownTypes && !totalMismatch && !couponIds.length && (items.length || zeroDiscount)) {
      result.matchesChoice = false;
      const details = items.length ? `；门店系统另给的优惠：${description}` : '';
      result.note = `顾客指定了『${title}』，但读回显示这单没有用上任何券${details}。${rejection}`;
    } else {
      const details = items.length ? `：${description}` : '';
      result.note = `顾客指定了『${title}』，读回里没法确认用的是不是这张${details}。请如实告知顾客，并请他在小程序「我的订单」里看一下这一单用的是哪张券。`;
    }
    return result;
  }
  if (items.some(item => item.isCoupon)) {
    if (noCoupon) {
      result.matchesChoice = false;
      result.note = `顾客选了这单不用券，但门店系统读回显示还是用了券：${description}。请先如实告诉顾客，并说明付款页改不了券；这种情况我们这边改不了，不要重新组单再下。`;
    } else {
      result.note = `门店系统自动使用了优惠券：${description}。请如实告知顾客「系统自动用了你的券」，不是算错。`;
    }
  } else if (totalMismatch || items.some(item => item.isCoupon === undefined)) {
    result.note = noCoupon
      ? `顾客选了这单不用券；门店系统给了优惠：${description}，读回里看不出这是不是优惠券。请如实告知顾客这笔优惠，并请他在小程序「我的订单」里看一下这一单有没有用券。`
      : `门店系统自动给了优惠：${description}。读回里看不出这是不是优惠券，请如实告知顾客有这笔优惠。`;
  } else if (items.length) {
    if (noCoupon) {
      result.matchesChoice = true;
      result.note = `按顾客的选择没有用券；门店系统另外自动给了优惠：${description}。这不是用券，请如实告知顾客。`;
    } else {
      result.note = `门店系统自动给了优惠：${description}。这不是用券，请如实告知顾客。`;
    }
  } else if (zeroDiscount) {
    result.matchesChoice = true;
    result.note = '按顾客的选择，这单没有用券（读回显示没有任何优惠）。';
  } else {
    result.note = '顾客选了这单不用券，但读回里没取到优惠明细，无法确认门店系统有没有用券；请按读回实付如实告知，并请顾客在小程序「我的订单」里看一下这一单有没有用券。';
  }
  return result;
}

export function placedView(created, detail, readError, draft, binding) {
  const { orderNo } = created;
  const actual = nonnegativeInteger(detail?.actualAmount);
  const result = { placed: true, orderNo };
  let problem;
  if (!detail || !Object.keys(detail).length) problem = `没读到门店系统的最终金额（${readError || '响应为空'}）`;
  else if (detail.orderNo !== orderNo) problem = '读回的内容对不上这一单，已丢弃';
  else if (responseId(detail.userId) !== binding.id) problem = '读回的订单归属校验不通过，内容已丢弃';
  else if (actual === null) problem = '读回里没有可用的实付金额';
  if (problem) {
    result.readbackFailed = true;
    result.readbackNote = `订单已创建成功（订单号 ${orderNo}），但${problem}。请让顾客在小程序「我的订单」核对金额后再付款。`;
    if (draft.couponChoice === 'none') result.readbackNote += '这单顾客选了不用券，核对金额时请顺便看一下有没有用券。';
    if (draft.chosenCoupon) result.readbackNote += `这单顾客指定了用『${draft.chosenCoupon.title}』，核对金额时请顺便看一下用的是不是这张。`;
    result.nextStep = '订单已创建，但最终金额没有核实，不要向顾客报金额。请让顾客在小程序「我的订单」核对金额后再付款——我们不代付、不碰任何支付凭据。';
    return result;
  }
  result.estimatedTotalYuan = yuan(draft.totalFen);
  result.qmaiActualAmountYuan = yuan(actual);
  result.diffYuan = yuan(actual - draft.totalFen);
  const applied = discountView(detail, draft, actual);
  if (applied) result.couponApplied = applied;
  const expectedFen = draft.chosenCoupon ? toFen(draft.chosenCoupon.payAfterYuan) : draft.totalFen;
  const diff = actual - expectedFen;
  if (Math.abs(diff) > Math.min(100, Math.round(expectedFen / 20))) {
    result.warning = `金额与念单时说的不一致：企迈实付 ¥${yuan(actual)}，念单时说的实付约 ¥${yuan(expectedFen)}，差额 ¥${yuan(diff)}。请先向顾客说清这个差额并核对。`;
  }
  const createFen = toFen(created.payAmount);
  if (createFen !== null) result.qmaiPayAmountYuanFromCreate = yuan(createFen);
  if (actual === 0) {
    result.nextStep = `这单读回的实付是 ¥0.00。${applied ? '请按 couponApplied.note 如实说明优惠，' : ''}请让顾客到小程序「我的订单」确认这一单的状态；不要说「去付款」。`;
  } else if (applied?.matchesChoice === false || applied?.amountAsPromised === false) {
    const choice = draft.chosenCoupon ? '按顾客指定的券办' : '按顾客的选择不用券';
    result.nextStep = `订单已创建但尚未支付。门店系统没有${choice}（见 couponApplied.note），请先如实说明${result.warning ? '并说清金额差额' : ''}：顾客接受这个金额，再引导他去小程序「我的订单」完成付款；不接受，就请他在小程序「我的订单」里取消这一单（没付款的单门店不会做，也不会扣钱）。我们不代付、不碰任何支付凭据。`;
  } else {
    result.nextStep = `订单已创建但尚未支付。请把企迈实付金额${applied ? '与优惠（按 couponApplied.note）' : ''}如实告诉顾客，${result.warning ? '先说清金额差额并核对，再' : ''}引导顾客去小程序「我的订单」完成付款——我们不代付、不碰任何支付凭据。`;
  }
  return result;
}

const statuses = new Map([[10, '待支付'], [15, '支付中'], [20, '已支付'], [30, '待备餐'],
  [40, '待取餐'], [50, '已完成'], [60, '已取消'], [70, '已关闭']]);
export function statusView(raw, hints = false) {
  const status = nonnegativeInteger(raw);
  const statusText = status === null ? '状态未知' : statuses.get(status) ?? `未知状态(${status})`;
  if (!hints) return { status, statusText };
  let paymentHint = '这张单的状态暂时没查清，请按小程序订单页显示的为准。';
  if (status === 10) paymentHint = '这张单还没付款，请引导顾客去小程序「我的订单」完成付款。';
  if (status === 15) paymentHint = '这张单正在支付中，请顾客在小程序里看支付结果。';
  if ([20, 30, 40].includes(status)) paymentHint = `这张单已经付款（当前「${statusText}」），按小程序订单页的提示取餐即可。`;
  if ([50, 60, 70].includes(status)) paymentHint = `这张单已经是「${statusText}」，不需要再付款。`;
  return { status, statusText, paymentHint };
}

export function reconciledPaymentNote(rows) {
  const codes = rows.map(row => nonnegativeInteger(row.status));
  const unpaid = codes.filter(code => code === 10).length;
  const other = codes.filter(code => statuses.has(code) && code !== 10).length;
  const unknown = rows.length - unpaid - other;
  return (unpaid ? '请引导顾客去小程序「我的订单」付款。' : '')
    + (other ? `其中 ${other} 笔不是待支付状态，按小程序订单页显示的为准。` : '')
    + (unknown ? `其中 ${unknown} 笔状态未查清，请在小程序「我的订单」核对状态。` : '');
}

function parseBeijingTime(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const time = Date.parse(text.replace(' ', 'T') + '+08:00');
  // Date.parse 会将 4 月 31 日等值顺延，转回北京时间核对原文。
  return Number.isFinite(time) && beijingTime(time) === text + ' +08:00' ? time : null;
}

export function pointsView(data) {
  if (data?.totalPoints == null) return;
  const points = { total: data.totalPoints };
  if (data.soonExpiredPoints != null && data.soonExpiredPoints !== '0') {
    points.expiringSoon = data.soonExpiredPoints;
    const time = parseBeijingTime(data.expiredTime);
    if (time !== null) points.nextExpireAt = beijingTime(time);
  }
  return points;
}

export function levelView(data, memberId) {
  if (!data || (Object.hasOwn(data, 'customerId') && responseId(data.customerId) !== memberId)) return;
  const name = projectText(data.levelName);
  if (name) return { name };
}

export function rowTime(row) {
  if (row?.createdAt != null) return parseBeijingTime(row.createdAt);
  const digits = integerDigits(row?.orderAt ?? row?.createTime);
  return digits?.length === 13 ? Number(digits) : null;
}

export function orderNumber(row) {
  return typeof row?.orderNo === 'string' && /^[A-Za-z0-9]{12,40}$/.test(row.orderNo) ? row.orderNo : '';
}

function productName(item) {
  for (const name of [item?.itemName, item?.goodsName]) {
    if (typeof name === 'string' && name.trim()) return name;
  }
  return '';
}

// undefined 表示上游没有提供商品字段，null 表示字段形状有误。
export function listedProducts(row) {
  if (!Object.hasOwn(row, 'itemList')) return undefined;
  if (!Array.isArray(row.itemList)) return null;
  const items = [];
  for (const item of row.itemList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if ([item.itemName, item.goodsName].some(name => name != null && typeof name !== 'string')) return null;
    const goodsId = responseId(item.goodsId);
    const name = productName(item);
    const quantity = nonnegativeInteger(item.num);
    if ((Object.hasOwn(item, 'goodsId') && !goodsId) || (!goodsId && !name)
      || quantity === null || quantity < 1) return null;
    items.push({ goodsId, nameHash: name ? digest(name) : null, quantity });
  }
  return items;
}

export function sameProducts(expected, observed) {
  if (observed === undefined) return true;
  if (!expected || !observed) return false;
  const quantities = new Map();
  for (const product of expected) {
    quantities.set(product.goodsId, (quantities.get(product.goodsId) || 0) + product.quantity);
  }
  for (const item of observed) {
    const matches = expected.filter(product => (!item.goodsId || product.goodsId === item.goodsId)
      && (!item.nameHash || item.nameHash === product.nameHash));
    const ids = new Set(matches.map(product => product.goodsId));
    if (ids.size !== 1) return false;
    const [id] = ids;
    const remaining = quantities.get(id) - item.quantity;
    if (remaining < 0) return false;
    quantities.set(id, remaining);
  }
  return [...quantities.values()].every(count => count === 0);
}

export function orderView(row) {
  const items = [];
  for (const item of Array.isArray(row?.itemList) ? row.itemList : []) {
    const name = projectText(productName(item));
    const quantity = nonnegativeInteger(item?.num);
    if (name) items.push(name + (quantity > 1 ? ' ×' + quantity : ''));
  }
  const time = rowTime(row);
  const amount = nonnegativeInteger(row?.actualAmount);
  return { orderNo: orderNumber(row), ...statusView(row?.status), actualAmountYuan: amount === null ? null : yuan(amount),
    ...(time !== null && { orderTime: beijingTime(time) }), items };
}
