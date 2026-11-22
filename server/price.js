import {yuan, projectText, responseId} from './common.js';
import {id, list, optionPrice} from './catalog.js';

export class SelectionError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function requireId(item, part, name, value) {
  if (!id(value)) {
    throw new Error(`组单失败：商品「${item}」的${part}「${name}」缺少下单所需的信息，暂时点不了，请换一个或稍后再试`);
  }
}

function rejectDuplicateIds(options, field, kind, itemName) {
  const seen = new Set();
  for (const option of options) {
    const key = responseId(option[field]);
    if (key === null) continue;
    if (seen.has(key)) throw new SelectionError(`「${itemName}」有多个${kind}使用同一编号，没法确定是哪一个`, '请换个商品或稍后再试');
    seen.add(key);
  }
}

function selectSku(card, input) {
  if (!card.available) throw new SelectionError(`「${card.name}」${card.unavailableReason}`, '换一款试试');
  if (input.skuId === undefined && card.skus.length > 1) {
    throw new SelectionError(`「${card.name}」有 ${card.skus.length} 个规格`, '可选：' + card.skus.map(s => s.specName).join('、'));
  }
  const key = responseId(input.skuId);
  const sku = input.skuId === undefined ? card.skus[0]
    : key && card.skus.find(option => responseId(option.skuId) === key);
  if (!sku) throw new SelectionError(`「${card.name}」没有这个规格`, '重新选一下规格');
  if (sku.priceFen === null) throw new SelectionError(`「${card.name}」这个规格暂时没有价格`, '换个规格或商品');
  if (!sku.available) throw new SelectionError(`「${card.name}」该规格暂时估清`, '换个规格或商品');
  return sku;
}

function practiceMatches(input, groupName, valueName) {
  if (typeof valueName !== 'string') return false;
  return input === valueName || input === groupName + '：' + valueName || input === groupName + ':' + valueName;
}

function checkOptionSpacing(name, rawNames, itemName, kind) {
  // 已逐字选中一项。只用空白归一化查找会与它混淆的其他原名。
  const collapse = text => text.trim().replace(/\s+/gu, ' ');
  const spelling = collapse(name);
  if (rawNames.some(other => typeof other === 'string' && other !== name && collapse(other) === spelling)) {
    throw new SelectionError(`「${itemName}」的${kind}「${projectText(name)}」与另一项只差空白，没法确定是哪一个`,
      `请换一个可区分的${kind}，或到小程序确认`);
  }
}

function selectPractices(row, card, requested) {
  const selected = new Map();
  const all = list(row.sortedPracticeList).flatMap((rawGroup, groupIndex) => {
    const group = card.practices[groupIndex];
    return list(rawGroup.practiceValueList).map((rawValue, index) => ({
      group, groupIndex, rawGroup, rawValue, value:group.values[index]
    }));
  });
  for (const input of requested) {
    const matches = all.filter(({rawGroup, rawValue}) =>
      practiceMatches(input, rawGroup.practiceName || '做法', rawValue.practiceValue));
    // 投影名只用来发现歧义。顾客提交的名字必须还能逐字对上企迈的原文。
    const visible = all.filter(({group, value}) => practiceMatches(input, group.name, value.name));
    const candidates = [...new Set([...matches, ...visible])];
    if (candidates.length > 1) {
      const groups = [...new Set(candidates.map(m => m.group.name))];
      if (groups.length > 1) {
        const names = groups.map(name => `「${name}」`).join('');
        throw new SelectionError(`「${card.name}」的做法「${projectText(input)}」在${names}里都有，没法确定是哪一个`,
          '请问清顾客要的是哪一组，再用「分组名：做法名」的写法重试');
      }
      throw new SelectionError(`「${card.name}」有多个做法都对上了「${projectText(input)}」，没法确定是哪一个`,
        '请换一个可区分的做法，或到小程序确认');
    }
    if (!matches.length) throw new SelectionError(`「${card.name}」没有「${projectText(input)}」这个做法`,
      '可选做法：' + (all.map(entry => entry.value.name).join('、') || '无'));
    const match = matches[0];
    checkOptionSpacing(match.rawValue.practiceValue, all.map(entry => entry.rawValue.practiceValue), card.name, '做法');
    if (selected.has(match.groupIndex)) throw new SelectionError(`「${match.group.name}」这一组里只能选一个做法`, '去掉一个再试');
    selected.set(match.groupIndex, match);
  }
  return selected;
}

export function priceLine(row, card, input, preparing) {
  const groups = list(row.sortedPracticeList);
  const rawAttaches = list(row.attachGoodsList);
  rejectDuplicateIds(card.skus, 'skuId', '规格', card.name);
  rejectDuplicateIds(groups, 'practiceId', '做法分组', card.name);
  rejectDuplicateIds(groups.flatMap(group => list(group.practiceValueList)), 'practiceValueId', '做法', card.name);
  rejectDuplicateIds(rawAttaches, 'attachGoodsId', '加料', card.name);
  const sku = selectSku(card, input);
  const selected = selectPractices(row, card, input.practices ?? []);
  let unitFen = sku.priceFen;
  const practices = [], practiceList = [];
  for (const {group, value, rawGroup, rawValue} of selected.values()) {
    if (value.priceFen === null) throw new SelectionError(`「${value.name}」做法价格待询`, '换个做法或商品');
    if (preparing) {
      requireId(card.name, '做法', value.name, rawGroup.practiceId);
      requireId(card.name, '做法', value.name, rawValue.practiceValueId);
    }
    practiceList.push({id:id(rawGroup.practiceId), name:rawGroup.practiceName || group.name, value:rawValue.practiceValue,
      valueId:id(rawValue.practiceValueId), price:optionPrice(rawValue.price)});
    practices.push(value.name);
    unitFen += value.priceFen;
  }
  const attaches = [], attachByIndex = new Map();
  for (const name of input.attaches ?? []) {
    const candidates = rawAttaches.map((option,index) => ({option,index}))
      .filter(({option,index}) => option.attachGoodsName === name || card.attaches[index].name === name);
    if (candidates.length > 1) throw new SelectionError(`「${card.name}」有多个加料都对上了「${projectText(name)}」，没法确定是哪一个`,
      '请换一个可区分的加料，或到小程序确认');
    const match = candidates[0];
    if (!match || match.option.attachGoodsName !== name) throw new SelectionError(`「${card.name}」没有「${projectText(name)}」这个加料`,
      '可加：' + (card.attaches.map(a => a.name).join('、') || '无'));
    checkOptionSpacing(name, rawAttaches.map(option => option.attachGoodsName), card.name, '加料');
    const {option:raw, index} = match;
    if (card.attaches[index].priceFen === null) throw new SelectionError(`「${card.attaches[index].name}」加料价格待询`, '换个加料或商品');
    if (preparing) requireId(card.name, '加料', card.attaches[index].name, raw.attachGoodsId);
    const item = attachByIndex.get(index) ?? {id:id(raw.attachGoodsId), name:raw.attachGoodsName, price:optionPrice(raw.attachGoodsPrice), num:0};
    item.num++;
    attachByIndex.set(index, item);
    attaches.push(card.attaches[index].name);
    unitFen += card.attaches[index].priceFen;
  }
  if (preparing) {
    requireId(card.name, '规格', sku.specName, sku.skuId);
    const missing = card.practices.filter((group, index) => group.required && !selected.has(index));
    if (missing.length) {
      const groups = missing.map(g => g.name + (g.values.length
        ? `（可选：${g.values.map(v => v.name).join(' / ')}）` : '（详情里没给可选值，请让顾客到店确认）')).join('；');
      throw new Error(`组单失败：「${card.name}」还有必选做法没选：${groups}。请逐项问顾客后重新组单。`);
    }
  }
  const lineFen = unitFen * input.quantity;
  if (!Number.isSafeInteger(lineFen)) throw new SelectionError('商品价格无法计算', '换个商品试试');
  return {
    lineFen, line:{name:card.name, specName:sku.specName, practices, attaches, unitPriceYuan:yuan(unitFen),
      quantity:input.quantity, lineTotalYuan:yuan(lineFen)},
    item:{goodsId:card.goodsId, skuId:sku.skuId, num:input.quantity, practiceList, attachList:[...attachByIndex.values()]},
    tradeMark:{tradeMark:card.goodsId, num:input.quantity, price:JSON.rawJSON(yuan(unitFen))}
  };
}
