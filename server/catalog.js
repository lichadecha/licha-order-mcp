import {projectText, yuan} from './common.js';

export const list = value => Array.isArray(value)
  ? value.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
export function id(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return typeof value === 'string' && /^0*[1-9]\d*$/.test(value) ? value : '';
}
export function numeric(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const price = value => {
  const n = numeric(value);
  const rounded = n === null ? null : Math.round(n);
  return Number.isSafeInteger(rounded) ? rounded : null;
};

function labels(row) {
  return list(row.labelList).filter(label => numeric(label.type) !== 2)
    .map(label => projectText(label.text) || projectText(label.labelTypeText)).filter(Boolean);
}

export function menuItem(row) {
  if (numeric(row.status) === 20 || numeric(row.type) === 2 || !id(row.goodsId)) return;
  const skus = list(row.goodsSkuList);
  const fen = price(skus[0]?.salePrice) ?? price(row.showPriceLow);
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
    };
  });
  const practices = list(row.sortedPracticeList).map(group => ({
    name: projectText(group.practiceName) || '做法', required: numeric(group.isRequired) === 1,
    values: list(group.practiceValueList).map(option => {
      const fen = price(option.price) ?? 0;
      return {name: projectText(option.practiceValue), priceFen: fen, priceDeltaYuan: fen ? '+' + yuan(fen) : '+0'};
    })
  }));
  const attaches = list(row.attachGoodsList).map(option => {
    const fen = price(option.attachGoodsPrice) ?? 0;
    return {name: projectText(option.attachGoodsName), priceFen:fen, priceYuan:yuan(fen)};
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
