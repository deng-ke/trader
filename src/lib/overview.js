// 聪明钱仓位总览数据层（src 服务端使用）
// 复用 tools/smart_money.js 导出的 httpsJson/errText（走本地代理的零依赖 HTTPS 客户端）
// 功能与 tools/smart_money_overview.js 一致：交易员/巨鲸的仓位、平均开仓价、未实现盈亏
'use strict';

const { httpsJson, errText } = require('../../tools/smart_money.js');

// 总览接口（币安内部 bapi，无需 API Key）；现价/24h 行情走公开 fapi
const BAPI_OVERVIEW = 'https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview';
const FAPI_TICKER = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const FAPI_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

// 默认代理（与 tools 口径一致，可用环境变量 BINANCE_PROXY 覆盖）
const DEFAULT_PROXY = process.env.BINANCE_PROXY || 'http://127.0.0.1:7897';

// 展示分组：类别（交易员/巨鲸）× 方向（多/空），字段对应 overview 接口返回
const GROUPS = [
  { type: '交易员', side: '多', qty: 'longTradersQty', count: 'longTraders', avgEntry: 'longTradersAvgEntryPrice', profit: 'longProfitTraders' },
  { type: '交易员', side: '空', qty: 'shortTradersQty', count: 'shortTraders', avgEntry: 'shortTradersAvgEntryPrice', profit: 'shortProfitTraders' },
  { type: '巨鲸', side: '多', qty: 'longWhalesQty', count: 'longWhales', avgEntry: 'longWhalesAvgEntryPrice', profit: 'longProfitWhales' },
  { type: '巨鲸', side: '空', qty: 'shortWhalesQty', count: 'shortWhales', avgEntry: 'shortWhalesAvgEntryPrice', profit: 'shortProfitWhales' },
];

// 计算每个分组的仓位市值与未实现盈亏（多空方向公式不同，与币安页面口径一致）
function buildGroups(overview, price) {
  return GROUPS.map((g) => {
    const qty = Number(overview[g.qty] || 0);
    const count = Number(overview[g.count] || 0);
    const avgEntry = Number(overview[g.avgEntry] || 0);
    const profitCount = Number(overview[g.profit] || 0);
    const positionUsdt = qty * price;
    const pnl = g.side === '多' ? (price - avgEntry) * qty : (avgEntry - price) * qty;
    const profitRatio = count > 0 ? profitCount / count : 0;
    return { type: g.type, side: g.side, count, positionUsdt, avgEntry, pnl, profitRatio };
  });
}

// 获取某合约的聪明钱总览（含现价与 24h 涨跌幅）
async function fetchOverview(symbol, proxy = DEFAULT_PROXY) {
  const [overviewRes, tickerRes] = await Promise.allSettled([
    httpsJson(`${BAPI_OVERVIEW}?symbol=${symbol}`, { proxy }),
    httpsJson(`${FAPI_TICKER}?symbol=${symbol}`, { proxy }),
  ]);

  if (overviewRes.status === 'rejected') throw new Error(`总览接口请求失败: ${errText(overviewRes.reason)}`);

  // 优先判断合约是否无聪明钱数据（此时行情接口也会因无效合约失败）
  const { code, data } = overviewRes.value;
  if (code !== '000000' || !data) {
    const err = new Error(`合约 ${symbol} 不存在或暂无聪明钱数据`);
    err.statusCode = 404;
    throw err;
  }

  if (tickerRes.status === 'rejected') throw new Error(`行情接口请求失败: ${errText(tickerRes.reason)}`);

  const ticker = tickerRes.value;
  const price = Number(ticker.lastPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`价格无效: ${JSON.stringify(ticker)}`);

  const groups = buildGroups(data, price);
  return {
    symbol,
    price,
    priceChangePercent: Number(ticker.priceChangePercent) || 0,
    quoteVolume: Number(ticker.quoteVolume) || 0, // 24h 成交额（USDT），判断合约活跃度
    updateTime: data.updateTime,
    fetchedAt: Date.now(),
    summary: {
      totalPositions: Number(data.totalPositions || 0),
      totalTraders: Number(data.totalTraders || 0),
      longShortRatio: Number(data.longShortRatio || 0),
    },
    overview: data,
    groups,
  };
}

// 获取 U 本位 USDT 永续合约列表（缓存 1 小时，供前端合约选择器使用）
let symbolCache = { time: 0, list: [] };

async function fetchSymbols(proxy = DEFAULT_PROXY) {
  if (Date.now() - symbolCache.time < 3600_000 && symbolCache.list.length > 0) return symbolCache.list;
  const data = await httpsJson(FAPI_EXCHANGE_INFO, { proxy });
  const list = (data.symbols || [])
    .filter((s) => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  symbolCache = { time: Date.now(), list };
  return list;
}

// ---------------------------------------------------------------------------
// 批量获取（供多合约同屏展示）：按合约缓存结果，TTL 内重复请求直接复用；失败不缓存
// ---------------------------------------------------------------------------
const overviewCache = new Map(); // symbol -> { time, promise }

function fetchOverviewCached(symbol, ttlMs, proxy = DEFAULT_PROXY) {
  const hit = overviewCache.get(symbol);
  if (hit && Date.now() - hit.time < ttlMs) return hit.promise;
  const promise = fetchOverview(symbol, proxy).catch((e) => {
    overviewCache.delete(symbol); // 失败不缓存，下次重试
    throw e;
  });
  overviewCache.set(symbol, { time: Date.now(), promise });
  return promise;
}

// 批量获取多个合约总览，返回 { results: [{ symbol, ok, data | error }] }（顺序与输入一致，单合约失败不影响其他）
async function fetchOverviewBatch(symbols, { ttlMs = 60000, proxy = DEFAULT_PROXY } = {}) {
  const settled = await Promise.allSettled(symbols.map((s) => fetchOverviewCached(s, ttlMs, proxy)));
  return symbols.map((symbol, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') return { symbol, ok: true, data: r.value };
    return { symbol, ok: false, error: r.reason && r.reason.message ? r.reason.message : String(r.reason) };
  });
}

module.exports = { fetchOverview, fetchSymbols, fetchOverviewBatch };
