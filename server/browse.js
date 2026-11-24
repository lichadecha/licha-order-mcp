import {PATHS, isRetryableReadError, readHint} from './qmai.js';
import {beijingTime, decimalId, digest, projectText, responseId, yuan} from './common.js';
import {itemCard, menuItem, id, list, numeric} from './catalog.js';
import {priceLine, SelectionError} from './price.js';

const normalize = text => text.normalize('NFKC').toLowerCase().trim();
const itemMissing = '商品详情查询失败：商品不存在或已下架（换个商品试试）';
const listingHint = '列表不含当日估清状态，是否在售以 get_item_detail 点单卡片为准';
const channel = {saleType:1, saleChannel:3, appChannel:1};
const statusNames = ['休息中','营业中','繁忙'];
const statusText = n => statusNames[n] ?? '状态未知';

function readError(label, error = {}, fallback) {
  const hint = readHint(error, fallback);
  const reason = error.kind === 'business' ? error.message : '未知错误';
  if (label === '按分类查商品失败' && !isRetryableReadError(error)) {
    return new Error(`${label}：${reason}`);
  }
  return Object.assign(new Error(`${label}：${reason}（${hint}）`), {reason:error.kind === 'business' ? reason : hint});
}

function openedHours(entries) {
  const ranges = [];
  for (const group of list(entries).flatMap(entry => [...list(entry.opentime), ...list(entry.opentimes)])) {
    const week = Array.isArray(group.workweek) ? [...new Set(group.workweek.map(numeric))]
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 7).sort((a,b) => a-b) : [];
    const suffix = week.length === 7 ? '（周一至周日）' : week.length ? `（周${week.join('、')}）` : '';
    for (const range of list(group.worktime)) {
      if (Array.isArray(range.time) && range.time.length === 2 && range.time.every(v => /^\d{2}:\d{2}$/.test(v))) {
        ranges.push(range.time.join('-') + suffix);
      }
    }
  }
  return [...new Set(ranges)].join('、');
}

export class Browse {
  #cache = new Map();
  #nextSweep = 0;
  #revision = 0;
  constructor(config, qmai) {
    this.config = config;
    this.qmai = qmai;
  }
  async #cached(key, ttl, fetch, fresh = false) {
    key = JSON.stringify(key);
    const now = Date.now();
    if (now >= this.#nextSweep) {
      for (const [k,v] of this.#cache) if (v.expires <= now) this.#cache.delete(k);
      this.#nextSweep = now + 60000;
    }
    const hit = this.#cache.get(key);
    if (!fresh && hit && hit.expires > now) return hit.value;
    // 同一毫秒也可能发起多个读取。较早发起的慢响应不能覆盖组单时的现读结果。
    const revision = ++this.#revision;
    const value = await fetch();
    if (value !== undefined && (this.#cache.get(key)?.revision ?? 0) < revision) {
      this.#cache.set(key, {revision, expires:Date.now() + ttl, value});
    }
    return value;
  }

  async #read(path, params, label, fallback) {
    try {
      return await this.qmai.read(path, params);
    } catch (error) {
      if (error.kind === 'credentials') throw error;
      throw readError(label, error, fallback);
    }
  }

  #directory(fresh = false) {
    return this.#cached(['stores'], this.config.LICHA_CACHE_STORES_MS, async () => {
      const records = new Map();
      const pageSize = 50;
      for (let pageNum = 1; ; pageNum++) {
        const data = await this.#read(PATHS.stores, {pageNum, pageSize}, '门店列表拉取失败');
        if (!Array.isArray(data?.list)) throw readError('门店列表拉取失败');
        const previous = records.size;
        for (const row of list(data.list)) {
          const storeId = id(row.id);
          if (!storeId) continue;
          const rawCode = typeof row.code === 'string' ? row.code : id(row.code);
          const store = {
            name:projectText(row.name), storeId, shopCode:projectText(rawCode),
            address:projectText(row.address), cityName:projectText(row.cityName)
          };
          const searchable = [row.name, row.address, row.fullAddress, row.cityName, store.shopCode]
            .filter(value => typeof value === 'string').map(normalize);
          records.set(decimalId(storeId), {store, rawCode, searchable, status:numeric(row.openStatus)});
        }
        if (data.list.length < pageSize || records.size === previous) break;
      }
      return {records, sampled:beijingTime()};
    }, fresh);
  }

  async storeForOrder(storeId) {
    const directory = await this.#directory();
    const record = directory.records.get(decimalId(storeId));
    if (record) return {name:record.store.name, shopCode:record.rawCode};
  }

  async #liveStatus(storeId) {
    storeId = decimalId(storeId);
    const key = ['status', storeId];
    const ttl = this.config.LICHA_CACHE_STORE_STATUS_MS;
    let hours;
    const live = await this.#cached(key, ttl, async () => {
      let status;
      try {
        const detail = await this.qmai.read(PATHS.storeStatus, {shopId:storeId, cols:['openStatus','opentimes']});
        status = numeric(detail?.openStatus);
        hours = openedHours(detail?.opentimes);
      } catch { /* 门店详情失败，按 R14 重拉名录。 */ }
      let sampled = beijingTime();
      if (status === undefined || status === null || statusNames[status] === undefined) {
        try {
          const directory = await this.#directory(true);
          status = directory.records.get(storeId)?.status;
          sampled = directory.sampled;
        } catch { /* 两条路都失败时只报告状态未知。 */ }
      }
      if (statusNames[status] === undefined) return undefined;
      return {openStatusText:statusText(status), statusSampledAt:sampled, ...(hours && {opentimes:hours})};
    });
    return live ?? {openStatusText:'状态未知', ...(hours && {opentimes:hours})};
  }

  async #find({query}) {
    const directory = await this.#directory();
    const keyword = normalize(query);
    const matches = [...directory.records.values()].filter(({searchable}) => searchable.some(s => s.includes(keyword)));
    if (matches.length === 1) {
      const {store} = matches[0];
      return {matched:true, store:{...store, ...await this.#liveStatus(store.storeId)}};
    }
    const candidates = matches.sort((a,b) => a.store.shopCode.localeCompare(b.store.shopCode)).map(({store,status}) =>
      ({...store, openStatusText:statusText(status), statusSampledAt:directory.sampled}));
    return {matched:false, candidates, ...(!candidates.length && {hint:'没找到这家店，试试商场名或城市名'})};
  }

  async #menu({storeId, keyword = ''}) {
    storeId = String(storeId);
    keyword = keyword.trim();
    const categories = await this.#cached(['categories',storeId], this.config.LICHA_CACHE_CATEGORIES_MS, async () => {
      const data = await this.#read(PATHS.categories, {storeId,...channel}, '分类菜单拉取失败');
      if (!Array.isArray(data)) throw readError('分类菜单拉取失败');
      return list(data).filter(row => id(row.frontCategoryId)).sort((a,b) => (numeric(a.categorySort) ?? Infinity) - (numeric(b.categorySort) ?? Infinity))
        .map(row => ({categoryName:projectText(row.categoryName), frontCategoryId:id(row.frontCategoryId)}));
    });
    if (!keyword) return {mode:'categories', storeId, categories};
    const folded = normalize(keyword);
    const category = categories.find(c => c.categoryName &&
      (normalize(c.categoryName).includes(folded) || folded.includes(normalize(c.categoryName))));
    const via = category ? 'category' : 'search';
    const params = {storeId, ...channel, includeProperties:['SKU','LABEL'],
      ...(category ? {frontCategoryId:category.frontCategoryId} : {name:keyword})};
    const {items,count} = await this.#cached([via,storeId,category ? decimalId(category.frontCategoryId) : keyword],
      category ? this.config.LICHA_CACHE_CATEGORIES_MS : this.config.LICHA_CACHE_SEARCH_MS, async () => {
        const label = category ? '按分类查商品失败' : '搜索失败';
        const rows = await this.#read(category ? PATHS.categoryItems : PATHS.search, params, label, '换个商品名试试');
        if (!Array.isArray(rows)) throw readError(label);
        return {items:list(rows).map(menuItem).filter(Boolean), count:rows.length};
      });
    let hint = listingHint;
    if (items.length === 0) hint = category ? `「${category.categoryName}」分类下暂无可点商品`
      : `没找到「${projectText(keyword)}」相关的商品，试试换个名字或问有什么系列`;
    else if (!category && count >= 20) hint = '搜索结果较多，可能只显示了前 20 条的一部分，说更具体的名字能找得更准；' + listingHint;
    return {mode:'items', storeId, via, ...(category && {categoryName:category.categoryName}), items, hint};
  }

  #item(storeId, goodsId, fresh = false) {
    const key = responseId(goodsId);
    if (!key) throw Object.assign(new Error(itemMissing), {reason:'商品不存在或已下架'});
    return this.#cached(['item',String(storeId),key], this.config.LICHA_CACHE_ITEM_MS, async () => {
      const result = await this.#read(PATHS.item, {
        storeId, goodsIds:[id(goodsId)], ...channel,
        includeProperties:['SKU','PRACTICE','ATTACH','LABEL','CATEGORY'], includeExtras:['GOODS_DESC']
      }, '商品详情查询失败', '换个商品试试');
      const row = Array.isArray(result) ? result[0] : null;
      if (responseId(row?.goodsId) !== key) throw Object.assign(new Error(itemMissing), {reason:'商品不存在或已下架'});
      return {row, card:itemCard(row)};
    }, fresh);
  }

  async quote({storeId, items}, preparing = false) {
    const seen = new Map();
    const lines = [], orderItems = [], tradeMarks = [], productEvidence = [];
    let totalFen = 0;
    try {
      for (const input of items) {
        const key = responseId(input.goodsId);
        if (!seen.has(key)) {
          try {
            seen.set(key, await this.#item(storeId, input.goodsId, preparing));
          } catch (error) {
            if (error.kind === 'credentials') throw error;
            throw new SelectionError('商品查询失败：' + (error.reason ?? error.message), '换个商品试试');
          }
        }
        const {row,card} = seen.get(key);
        const {line, item, tradeMark, lineFen} = priceLine(row, card, input, preparing);
        totalFen += lineFen;
        if (!Number.isSafeInteger(totalFen)) throw new SelectionError('商品价格无法计算', '换个商品试试');
        if (preparing) productEvidence.push({ goodsId:decimalId(item.goodsId),
          nameHash:typeof row.name === 'string' && row.name.trim() ? digest(row.name) : null, quantity:item.num });
        lines.push(line);
        orderItems.push(item);
        tradeMarks.push(tradeMark);
      }
    } catch (error) {
      if (preparing && error instanceof SelectionError) throw new Error(`${error.message}（${error.hint}）`);
      throw error;
    }
    return {totalFen, lines, orderItems, tradeMarks, productEvidence};
  }

  async call(name,args) {
    switch (name) {
      case 'find_store': return this.#find(args);
      case 'get_menu': return this.#menu(args);
      case 'get_item_detail': return (await this.#item(args.storeId, args.goodsId)).card;
      case 'preview_order': {
        try {
          const {lines,totalFen} = await this.quote(args);
          return {ok:true, computedBy:'local', lines, totalYuan:yuan(totalFen)};
        } catch (error) {
          if (!(error instanceof SelectionError)) throw error;
          return {ok:false, computedBy:'local', error:{code:'PREVIEW_INVALID', message:error.message, hint:error.hint}};
        }
      }
      default: throw new Error('未知浏览工具');
    }
  }
}
