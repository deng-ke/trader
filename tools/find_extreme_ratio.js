#!/usr/bin/env node
// 扫描全部 USDT 永续合约，找出聪明钱多空占比极端且综合仓位大的合约
// （条件组合：多头占比 > --high 且综合仓位 > --min-position，或
//   多头占比 < --low 且综合仓位 > --min-position）
// 数据来源：币安聪明钱总览 bapi（与桌面应用同口径：多头占比 = 名义多空比率换算）
//
// 用法：
//   node tools/find_extreme_ratio.js                 # 默认 占比>70%或<30% 且 综合仓位>5M，全部列出
//   node tools/find_extreme_ratio.js --high 75 --low 25 --min-position 10000000
//   node tools/find_extreme_ratio.js --top 10 --json
//   node tools/find_extreme_ratio.js --concurrency 15 --proxy http://127.0.0.1:7897
//   node tools/find_extreme_ratio.js -h              # 帮助
'use strict';

const { dispWidth } = require('./smart_money.js');
const { fetchSymbols, fetchOverviewBatch } = require('../src/lib/overview');

const DEFAULT_HIGH = 50;
const DEFAULT_LOW = 30;
const DEFAULT_TOP = 0; // 0 表示不限制，全部列出
const DEFAULT_MIN_POSITION = 5000000; // 综合仓位阈值（USDT）
const MAX_BATCH = 20; // /api/overviews 风格批量上限，逐批请求避免单次过大

function printHelp() {
  console.log(`用法: node tools/find_extreme_ratio.js [选项]

扫描全部 USDT 永续合约，筛选满足组合条件的合约：
  1. 多头占比 >= --high（默认 ${DEFAULT_HIGH}%）且综合仓位 > --min-position   极端偏多+大仓位
  2. 多头占比 <= --low（默认 ${DEFAULT_LOW}%）且综合仓位 > --min-position    极端偏空+大仓位

选项:
  --high <pct>       偏多阈值（默认 ${DEFAULT_HIGH}，范围 51-100）
  --low <pct>        偏空阈值（默认 ${DEFAULT_LOW}，范围 0-49）
  --min-position <usdt>  综合仓位（多仓+空仓）阈值，默认 ${DEFAULT_MIN_POSITION}
  --top <n>          每个方向最多显示条数（默认 ${DEFAULT_TOP} = 全部列出）
  --concurrency <n>  并发批大小，1-${MAX_BATCH}（默认 ${MAX_BATCH}）
  --json             输出 JSON（含全部命中结果）
  --proxy <url>      代理地址（默认 http://127.0.0.1:7897，环境变量 BINANCE_PROXY 可覆盖）
  --no-proxy         不走代理直连
  -h, --help         显示帮助

说明:
  多头占比 = 名义多空比率 longShortRatio 换算（多头/(多头+空头)），与桌面应用卡片一致。
  综合仓位 = 交易员多仓 USDT + 交易员空仓 USDT。
  无聪明钱数据的合约会被跳过。
`);
}

function parseArgs(argv) {
  const opts = {
    high: DEFAULT_HIGH,
    low: DEFAULT_LOW,
    top: DEFAULT_TOP,
    minPosition: DEFAULT_MIN_POSITION,
    concurrency: MAX_BATCH,
    json: false,
    proxy: process.env.BINANCE_PROXY || 'http://127.0.0.1:7897',
  };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`选项 ${a} 缺少参数值`);
      return argv[++i];
    };
    switch (a) {
      case '--high': opts.high = Number(next()); break;
      case '--low': opts.low = Number(next()); break;
      case '--min-position': opts.minPosition = Number(next()); break;
      case '--top': opts.top = Number(next()); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--proxy': opts.proxy = next(); break;
      case '--no-proxy': opts.proxy = null; break;
      case '-h': case '--help': return { help: true };
      default: if (!a.startsWith('-')) positional.push(a);
    }
  }
  return { ...opts, positional };
}

// 多头占比（%）：由名义多空比率换算，与前端卡片口径一致
function longPct(summary) {
  const ratio = Number(summary.longShortRatio) || 0;
  if (ratio <= 0) return 50;
  return (ratio / (1 + ratio)) * 100;
}

function fmtUsdt(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function fmtPrice(v) {
  if (v >= 1000) return v.toFixed(1);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function fmtPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function pad(s, width) {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

function printTable(rows) {
  if (rows.length === 0) return;
  const header = ['合约', '现价', '24h涨跌', '多头占比', '多仓(USDT)', '空仓(USDT)', '综合仓位'];
  const lines = rows.map((r) => [
    r.symbol,
    fmtPrice(r.price),
    fmtPct(r.chg),
    `${r.pctLong.toFixed(1)}%`,
    fmtUsdt(r.tradersLong),
    fmtUsdt(r.tradersShort),
    fmtUsdt(r.tradersLong + r.tradersShort),
  ]);
  const widths = header.map((h, i) => Math.max(dispWidth(h), ...lines.map((l) => dispWidth(l[i]))));
  const line = () => widths.map((w) => '-'.repeat(w)).join('-+-');
  console.log(line());
  console.log(header.map((h, i) => pad(h, widths[i])).join(' | '));
  console.log(line());
  for (const l of lines) console.log(l.map((c, i) => pad(c, widths[i])).join(' | '));
  console.log(line());
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }
  if (!(args.high > args.low && args.high > 50 && args.low < 50)) {
    console.error('参数错误: 需要 --low < 50 < --high，且 --low < --high');
    process.exit(1);
  }
  const batchSize = Math.min(Math.max(Number(args.concurrency) || MAX_BATCH, 1), MAX_BATCH);

  process.stderr.write('正在获取 USDT 永续合约列表…\n');
  const symbols = (await fetchSymbols(args.proxy)).map((s) => s.symbol);
  process.stderr.write(`共 ${symbols.length} 个合约，开始扫描（阈值: 占比 >${args.high}% / <${args.low}%，综合仓位 >${fmtUsdt(args.minPosition)}）…\n`);

  const longSide = [];  // 极端偏多且大仓位
  const shortSide = []; // 极端偏空且大仓位
  let done = 0;
  const t0 = Date.now();

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const results = await fetchOverviewBatch(batch, { ttlMs: 60000, proxy: args.proxy });
    for (const r of results) {
      done++;
      if (!r.ok) continue; // 无聪明钱数据的合约跳过
      const d = r.data;
      const pctLong = longPct(d.summary);
      const totalPos = d.groups[0].positionUsdt + d.groups[1].positionUsdt;
      if (totalPos <= args.minPosition) continue; // 综合仓位不足直接跳过
      if (pctLong >= args.high || pctLong <= args.low) {
        const item = {
          symbol: r.symbol,
          price: d.price,
          chg: d.priceChangePercent,
          pctLong,
          tradersLong: d.groups[0].positionUsdt,
          tradersShort: d.groups[1].positionUsdt,
        };
        if (pctLong >= args.high) longSide.push(item);
        else shortSide.push(item);
      }
    }
    process.stderr.write(`\r扫描进度: ${done}/${symbols.length}（命中 ${longSide.length + shortSide.length}），已用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  process.stderr.write('\n');

  // 排序：偏多组占比降序，偏空组占比升序
  longSide.sort((a, b) => b.pctLong - a.pctLong);
  shortSide.sort((a, b) => a.pctLong - b.pctLong);

  // --top 0 表示不限制（全部列出）
  const cap = (arr) => (args.top > 0 ? arr.slice(0, args.top) : arr);

  if (args.json) {
    console.log(JSON.stringify({
      scanned: done,
      matched: { longSide: longSide.length, shortSide: shortSide.length },
      thresholds: { high: args.high, low: args.low, minPosition: args.minPosition },
      longSide: cap(longSide),
      shortSide: cap(shortSide),
    }, null, 2));
    return;
  }

  console.log(`\n扫描完成: ${done} 个合约，命中 ${longSide.length + shortSide.length} 个（偏多+大仓位 ${longSide.length} / 偏空+大仓位 ${shortSide.length}）\n`);
  console.log(`=== 极端偏多且大仓位（多头占比 >= ${args.high}% 且综合仓位 > ${fmtUsdt(args.minPosition)}）===`);
  printTable(cap(longSide));
  console.log(`\n=== 极端偏空且大仓位（多头占比 <= ${args.low}% 且综合仓位 > ${fmtUsdt(args.minPosition)}）===`);
  printTable(cap(shortSide));
}

main().catch((e) => {
  console.error('\n执行失败:', e.message);
  process.exit(1);
});
