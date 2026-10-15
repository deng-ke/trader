// 币安"聪明钱"仓位总览工具：获取某个 U 本位合约上交易员与巨鲸的当前仓位、
// 平均开仓价格、未实现盈亏（对应币安网页/App 合约行情页的"聪明钱总览"模块）
//
// 数据来源：币安内部 bapi 接口（币安合约聪明钱功能所用，无需 API Key）
//   GET https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview?symbol=XXX
// 当前价格：币安公开 REST API fapi/v1/ticker/price（用于计算未实现盈亏与仓位市值）
//
// 用法：
//   node tools/smart_money_overview.js METUSDT             # 表格视图
//   node tools/smart_money_overview.js METUSDT --json      # 原始 JSON
//   node tools/smart_money_overview.js BTCUSDT --no-proxy  # 不走代理直连
//
// 说明：交易员/巨鲸按多空方向分两组展示；当前仓位 = 持仓量 × 现价；
//   未实现盈亏 = (现价 - 平均开仓价) × 持仓量（多）/ (平均开仓价 - 现价) × 持仓量（空）。

'use strict';

const { httpsJson, errText, dispWidth, padStr } = require('./smart_money.js');

const BAPI_OVERVIEW = 'https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview';
const FAPI_PRICE = 'https://fapi.binance.com/fapi/v1/ticker/price';

// 展示分组：类别（交易员/巨鲸）× 方向（多/空），字段对应 overview 接口返回
const GROUPS = [
  { type: '交易员', side: '多', qty: 'longTradersQty', count: 'longTraders', avgEntry: 'longTradersAvgEntryPrice', profit: 'longProfitTraders' },
  { type: '交易员', side: '空', qty: 'shortTradersQty', count: 'shortTraders', avgEntry: 'shortTradersAvgEntryPrice', profit: 'shortProfitTraders' },
  { type: '巨鲸', side: '多', qty: 'longWhalesQty', count: 'longWhales', avgEntry: 'longWhalesAvgEntryPrice', profit: 'longProfitWhales' },
  { type: '巨鲸', side: '空', qty: 'shortWhalesQty', count: 'shortWhales', avgEntry: 'shortWhalesAvgEntryPrice', profit: 'shortProfitWhales' },
];

// 计算每个分组的仓位市值与未实现盈亏（多空方向公式不同）
function buildRows(data, price) {
  return GROUPS.map((g) => {
    const qty = Number(data[g.qty] || 0);
    const count = Number(data[g.count] || 0);
    const avgEntry = Number(data[g.avgEntry] || 0);
    const profitCount = Number(data[g.profit] || 0);
    const positionUsdt = qty * price;
    const pnl = g.side === '多' ? (price - avgEntry) * qty : (avgEntry - price) * qty;
    const profitRatio = count > 0 ? profitCount / count : 0;
    return { type: g.type, side: g.side, count, positionUsdt, avgEntry, pnl, profitRatio };
  });
}

function fmtNum(n, digits = 2) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(digits) : '-';
}

function fmtUsdt(n, digits = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(digits) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(digits) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(digits) + 'K';
  return v.toFixed(digits);
}

function renderTable(symbol, price, overview, rows) {
  const header = ['类别', '方向', '人数', '当前仓位(USDT)', '平均开仓价', '未实现盈亏(USDT)', '盈利占比'];
  const cells = rows.map((r) => [
    r.type,
    r.side,
    String(r.count),
    fmtUsdt(r.positionUsdt),
    fmtNum(r.avgEntry, 4),
    (r.pnl >= 0 ? '+' : '') + fmtUsdt(r.pnl),
    (r.profitRatio * 100).toFixed(2) + '%',
  ]);
  const colW = header.map((h, i) => Math.max(dispWidth(h), ...cells.map((c) => dispWidth(c[i]))));
  const line = (cs) => cs.map((c, i) => padStr(c, colW[i])).join('  ').trimEnd();
  const sep = colW.map((w) => '-'.repeat(w)).join('  ');

  const totalPositions = Number(overview.totalPositions || 0);
  const totalTraders = Number(overview.totalTraders || 0);
  const longShortRatio = Number(overview.longShortRatio || 0);
  const upd = overview.updateTime ? fmtTime(overview.updateTime) : '-';

  const out = [
    `${symbol} 聪明钱仓位总览（现价 ${fmtNum(price, 4)} USDT，数据更新时间 ${upd}）`,
    '',
    line(header),
    sep,
    ...cells.map((c) => line(c)),
    '',
    `交易员总持仓: ${fmtUsdt(totalPositions)} USDT  交易者总数: ${totalTraders}  名义多空比率: ${(longShortRatio * 100).toFixed(2)}%`,
  ];
  return out.join('\n');
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseArgs(argv) {
  const opts = {
    symbol: null,
    json: false,
    proxy: process.env.BINANCE_PROXY || 'http://127.0.0.1:7897',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--json': opts.json = true; break;
      case '--proxy': opts.proxy = argv[++i]; break;
      case '--no-proxy': opts.proxy = null; break;
      case '-h': case '--help': return { help: true };
      default: if (!argv[i].startsWith('-')) positional.push(argv[i]);
    }
  }
  if (positional[0]) opts.symbol = positional[0].toUpperCase();
  return opts;
}

const HELP = `用法: node tools/smart_money_overview.js <symbol> [选项]

获取币安合约"聪明钱总览"数据：某合约上交易员与巨鲸的当前仓位、平均开仓价、未实现盈亏。

  symbol        交易对，如 METUSDT（必填）

选项:
  --json        输出原始 JSON（overview 接口原始数据 + 计算后的分组）
  --proxy <url> 代理地址（默认 http://127.0.0.1:7897，环境变量 BINANCE_PROXY 可覆盖）
  --no-proxy    不走代理直连
  -h, --help    显示本帮助

数据来源:
  总览接口  https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview?symbol=XXX
  当前价格  https://fapi.binance.com/fapi/v1/ticker/price?symbol=XXX
说明: 当前仓位 = 持仓量 × 现价；未实现盈亏 = (现价 - 平均开仓价) × 持仓量（多单），
  空单方向相反。多空比率 = 名义多空比率。`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.symbol) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  const { symbol } = opts;

  // 并行获取 overview 与当前价格
  const [overviewRes, priceRes] = await Promise.allSettled([
    httpsJson(`${BAPI_OVERVIEW}?symbol=${symbol}`, { proxy: opts.proxy }),
    httpsJson(`${FAPI_PRICE}?symbol=${symbol}`, { proxy: opts.proxy }),
  ]);

  if (overviewRes.status === 'rejected') return fail(`总览接口请求失败: ${errText(overviewRes.reason)}`);
  const { code, data } = overviewRes.value;
  if (code !== '000000' || !data) {
    return fail(`接口返回异常(${code}): ${JSON.stringify(overviewRes.value).slice(0, 300)}`);
  }
  if (priceRes.status === 'rejected') return fail(`价格接口请求失败: ${errText(priceRes.reason)}`);
  const price = Number(priceRes.value.price);
  if (!Number.isFinite(price) || price <= 0) return fail(`价格无效: ${JSON.stringify(priceRes.value)}`);

  const rows = buildRows(data, price);

  if (opts.json) {
    console.log(JSON.stringify({
      symbol,
      price,
      fetchedAt: new Date().toISOString(),
      overview: data,
      groups: rows,
    }, null, 2));
    return;
  }

  console.log(renderTable(symbol, price, data, rows));
}

function fail(msg) {
  console.error('错误:', msg);
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => fail(e.message));
}
