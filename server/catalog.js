import {integerDigits, projectText, responseId, yuan} from './common.js';

export const list = value => Array.isArray(value)
  ? value.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
export function id(value) {
  const digits = responseId(value);
  if (!digits) return '';
  return typeof value === 'string' && /^\d+$/.test(value) ? value : digits;
}
export function numeric(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d.*)$/.exec(value.trim());
  if (!match) return null;
  const digits = integerDigits(match[2]);
  if (digits === null) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? (match[1] ? -n : n) : null;
}
const price = value => {
  const n = numeric(value);
  return n !== null && n >= 0 ? n : null;
};
const missingPrice = value => value == null || (typeof value === 'string' && !value.trim());
export const optionPrice = value => missingPrice(value) ? 0 : value;

function labels(row) {
  return list(row.labelList).filter(label => numeric(label.type) !== 2)
    .map(label => projectText(label.text) || projectText(label.labelTypeText)).filter(Boolean);
}

function validSkuIds(sku) {
  return (sku.skuId == null || !!id(sku.skuId)) && list(sku.skuItemList).every(spec =>
    (spec.specId == null || id(spec.specId)) && (spec.specValueId == null || id(spec.specValueId)));
}

export function menuItem(row) {
  if (numeric(row.status) === 20 || numeric(row.type) === 2 || !id(row.goodsId)) return;
  const rows = list(row.goodsSkuList);
  const skus = rows.filter(validSkuIds);
  if (rows.length && !skus.length) return;
  const salePrice = skus[0]?.salePrice;
  const fen = price(missingPrice(salePrice) ? row.showPriceLow : salePrice);
  if (!(fen > 0)) return;
  return {
    goodsId: id(row.goodsId), name: projectText(row.name), priceYuan: yuan(fen),
    hasPractice: row.isPractice === true || numeric(row.isPractice) === 1,
    hasAttach: row.isAttach === true || numeric(row.isAttach) === 1, labels: labels(row),
    ...(skus.length && skus.every(sku => numeric(sku.clearStatus) === 0) ? {soldOut:true} : {})
  };
}

export function itemCard(row) {
  const skus = list(row.goodsSkuList).map(sku => {
    const fen = price(sku.salePrice);
    const stock = numeric(sku.inventory);
    return {
      skuId: id(sku.skuId),
      specName: projectText(sku.specName) || projectText(sku.skuName) || projectText(sku.skuItemList?.[0]?.specValue) || '标准杯',
      priceFen: fen > 0 ? fen : null, priceYuan: fen > 0 ? yuan(fen) : '价格待询', stock,
      available: fen > 0 && numeric(sku.clearStatus) !== 0 && (stock === null || stock > 0)
        && validSkuIds(sku)
    };
  });
  const practices = list(row.sortedPracticeList).map(group => ({
    name: projectText(group.practiceName) || '做法', required: numeric(group.isRequired) === 1,
    values: list(group.practiceValueList).map(option => {
      const fen = price(optionPrice(option.price));
      return {name: projectText(option.practiceValue), priceFen: fen,
        priceDeltaYuan: fen === null ? '价格待询' : fen ? '+' + yuan(fen) : '+0'};
    })
  }));
  const attaches = list(row.attachGoodsList).map(option => {
    const fen = price(optionPrice(option.attachGoodsPrice));
    return {name: projectText(option.attachGoodsName), priceFen:fen, priceYuan:fen === null ? '价格待询' : yuan(fen)};
  });
  const type = numeric(row.type) ?? 1;
  const categoryName = projectText(row.categoryList?.[0]?.categoryName);
  let unavailableReason;
  if (numeric(row.status) === 20) unavailableReason = '已下架';
  else if (!skus.some(sku => sku.priceFen > 0)) unavailableReason = '非售卖条目';
  else if (!skus.some(sku => sku.available)) unavailableReason = '暂时估清，点不了';
  return {
    goodsId:id(row.goodsId), name:projectText(row.name), type, isSetMeal:type === 3,
    ...(categoryName && {categoryName}), labels:labels(row), available:!unavailableReason,
    ...(unavailableReason && {unavailableReason}), skus, practices, attaches
  };
}
