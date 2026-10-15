// 币安 U 本位合约"聪明钱"数据工具
// 数据来源：https://developers.binance.com/zh-CN/docs（USDⓈ-M Futures REST API 行情接口）
// 说明：聚合 4 个接口——大户持仓量多空比、大户账户数多空比、全市场多空持仓人数比、合约主动买卖量
//
// 用法：
//   node tools/smart_money.js BTCUSDT                     # 默认 1h 周期，表格显示最新 10 条
//   node tools/smart_money.js BTCUSDT 15m 5               # 15m 周期，取 5 条
//   node tools/smart_money.js BTCUSDT --period 4h --rows 3
//   node tools/smart_money.js BTCUSDT --json              # 输出原始 JSON
//
// 选项：
//   --period <p>   周期: 5m/15m/30m/1h/2h/4h/6h/12h/1d（默认 1h）
//   --limit <n>    每个接口请求条数 1-500（默认 30）
//   --rows <n>     表格显示行数（默认 10，最新在前）
//   --json         输出原始 JSON
//   --proxy <url>  代理地址（默认 http://127.0.0.1:7897，可用环境变量 BINANCE_PROXY 覆盖）
//   --no-proxy     不走代理直连
//   --key <apikey> API Key（可选；默认读环境变量 BINANCE_API_KEY，会附加 X-MBX-APIKEY 请求头）
//   -h, --help     显示帮助
//
// 说明：fapi.binance.com 在国内网络直连不通，默认走本地 clash 代理端口；
//       大户接口官方标注需 API Key（MARKET_DATA），实测当前可不带 key 访问，但建议按需配置。

'use strict';

const net = require('net');
const tls = require('tls');

const BASE = 'https://fapi.binance.com';

// 4 个聪明钱相关接口（endpoint、中文名、是否需要 key）
const ENDPOINTS = [
  { key: 'topPosition', path: '/futures/data/topLongShortPositionRatio', name: '大户持仓量多空比', needKey: true },
  { key: 'topAccount', path: '/futures/data/topLongShortAccountRatio', name: '大户账户数多空比', needKey: true },
  { key: 'global', path: '/futures/data/globalLongShortAccountRatio', name: '全市场多空持仓人数比', needKey: false },
  { key: 'taker', path: '/futures/data/takerlongshortRatio', name: '合约主动买卖量', needKey: false },
];

const PERIODS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
const PERIOD_MS = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '12h': 43200000, '1d': 86400000 };

// 统一错误信息：Node 24 的 net.connect 失败可能抛出 message 为空的 AggregateError
const errText = (e) => (e && e.message) || (e && e.code) || String(e);

// ---------------------------------------------------------------------------
// 通过 HTTP CONNECT 代理（或直连）发起 HTTPS 请求并解析 JSON，零第三方依赖
// ---------------------------------------------------------------------------
function httpsJson(urlStr, { headers = {}, proxy = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const port = Number(u.port) || 443;
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error(`请求超时(${timeoutMs}ms): ${u.host}`)), timeoutMs);

    // 建立 TLS 通道后发送 GET 请求
    const onTunnelReady = (socket) => {
      const tlsSocket = tls.connect({ socket, servername: u.hostname }, () => {
        const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        const req = `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nConnection: close\r\nUser-Agent: binance-smart-money/1.0\r\n${headerLines}\r\n\r\n`;
        tlsSocket.write(req);
      });
      let buf = Buffer.alloc(0);
      tlsSocket.on('data', (d) => (buf = Buffer.concat([buf, d])));
      tlsSocket.on('end', () => {
        clearTimeout(timer);
        const str = buf.toString('utf8');
        const idx = str.indexOf('\r\n\r\n');
        const statusLine = str.split('\r\n')[0] || '';
        const status = Number(statusLine.split(' ')[1]);
        const body = idx >= 0 ? str.slice(idx + 4) : '';
        if (!/^HTTP\/\d(\.\d)? /.test(statusLine)) {
          return done(new Error('连接中断或收到空响应，请检查网络/代理'));
        }
        if (status !== 200) return done(new Error(`HTTP ${status}: ${body.slice(0, 200)}`));
        try { done(null, JSON.parse(body)); } catch { done(new Error('JSON 解析失败: ' + body.slice(0, 200))); }
      });
      tlsSocket.on('error', (e) => { clearTimeout(timer); done(new Error(errText(e))); });
    };

    const onTcpConnected = (socket) => {
      socket.on('error', (e) => { clearTimeout(timer); done(new Error(errText(e))); });
      onTunnelReady(socket);
    };

    if (proxy) {
      const p = new URL(proxy);
      const s = net.connect(Number(p.port) || 80, p.hostname);
      s.on('error', (e) => { clearTimeout(timer); done(new Error(`连接代理失败 ${p.hostname}:${p.port} - ${e.message}`)); });
      s.on('connect', () => {
        s.write(`CONNECT ${u.hostname}:${port} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\n\r\n`);
        s.once('data', (d) => {
          const headEnd = d.indexOf('\r\n\r\n');
          const statusLine = d.toString('utf8', 0, headEnd < 0 ? d.length : headEnd).split('\r\n')[0] || '';
          if (!/^HTTP\/\d(\.\d)? 200/.test(statusLine)) {
            clearTimeout(timer);
            return done(new Error(`代理 CONNECT 失败: ${statusLine}`));
          }
          // 极少数情况下代理会把 CONNECT 响应与后续 TLS 数据拼在一起，多余字节塞回缓冲
          const extra = d.subarray(headEnd < 0 ? d.length : headEnd + 4);
          if (extra.length > 0) s.unshift(extra);
          onTcpConnected(s);
        });
      });
    } else {
      const s = net.connect(port, u.hostname);
      s.on('error', (e) => { clearTimeout(timer); done(new Error(errText(e))); });
      s.on('connect', () => onTcpConnected(s));
    }
  });
}

async function fetchEndpoint(ep, { symbol, period, limit, apiKey, proxy }) {
  const url = `${BASE}${ep.path}?symbol=${symbol}&period=${period}&limit=${limit}`;
  const headers = {};
  if (apiKey) headers['X-MBX-APIKEY'] = apiKey;
  const data = await httpsJson(url, { headers, proxy });
  if (!Array.isArray(data)) {
    const msg = data && data.msg ? data.msg : JSON.stringify(data).slice(0, 200);
    throw new Error(`接口返回异常: ${msg}`);
  }
  return { key: ep.key, name: ep.name, data };
}

// ---------------------------------------------------------------------------
// 表格渲染
// ---------------------------------------------------------------------------
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtNum(v, digits = 4) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : String(v);
}

function fmtRow(t, r) {
  const topPos = r.topPosition ? Number(r.topPosition.longShortRatio) : NaN;
  const topAcc = r.topAccount ? Number(r.topAccount.longShortRatio) : NaN;
  const glob = r.global ? Number(r.global.longShortRatio) : NaN;
  const taker = r.taker ? Number(r.taker.buySellRatio) : NaN;
  const sign = !Number.isFinite(topPos) ? '-' : topPos >= 1.2 ? '大户偏多' : topPos <= 0.8 ? '大户偏空' : '中性';
  return [
    fmtTime(t),
    fmtNum(topPos),
    r.topPosition ? `${fmtNum(r.topPosition.longAccount * 100, 2)}% / ${fmtNum(r.topPosition.shortAccount * 100, 2)}%` : '-',
    fmtNum(topAcc),
    fmtNum(glob),
    fmtNum(taker),
    sign,
  ];
}

// 终端显示宽度：CJK 等宽字符算 2，其余算 1
function dispWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

function padStr(s, w) {
  return s + ' '.repeat(Math.max(0, w - dispWidth(s)));
}

function renderTable(symbol, period, rows) {
  const header = ['时间', '大户持仓多空比', '大户多仓/空仓占比', '大户账户多空比', '全市场多空比', '主动买卖比', '信号'];
  const colW = header.map((h, i) => Math.max(dispWidth(h), ...rows.map((r) => dispWidth(fmtRow(r.ts, r)[i]))));
  const line = (cells) => cells.map((c, i) => padStr(c, colW[i])).join('  ').trimEnd();
  const sep = colW.map((w) => '-'.repeat(w)).join('  ');
  const out = [`${symbol} 聪明钱数据（周期 ${period}，最新 ${rows.length} 条，本地时间）`, '', line(header), sep];
  for (const r of rows) out.push(line(fmtRow(r.ts, r)));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    symbol: null,
    period: '1h',
    limit: 30,
    rows: 10,
    json: false,
    proxy: process.env.BINANCE_PROXY || 'http://127.0.0.1:7897',
    apiKey: process.env.BINANCE_API_KEY || '',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--period': opts.period = next(); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--rows': opts.rows = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--proxy': opts.proxy = next(); break;
      case '--no-proxy': opts.proxy = null; break;
      case '--key': opts.apiKey = next(); break;
      case '-h': case '--help': return { help: true };
      default: if (!a.startsWith('-')) positional.push(a);
    }
  }
  opts.symbol = positional[0] ? positional[0].toUpperCase() : null;
  if (positional[1]) opts.period = positional[1];
  if (positional[2]) opts.limit = Number(positional[2]);
  return opts;
}

const HELP = `用法: node tools/smart_money.js <symbol> [period] [limit] [选项]

获取币安 U 本位合约"聪明钱"数据（大户多空比 + 主动买卖量）。

  symbol        交易对，如 BTCUSDT（必填）
  period        周期: 5m/15m/30m/1h/2h/4h/6h/12h/1d（默认 1h）
  limit         每个接口请求条数 1-500（默认 30）

选项:
  --period <p>  周期（同 position 参数）
  --limit <n>   请求条数（默认 30，最大 500）
  --rows <n>    表格显示行数（默认 10，最新在前）
  --json        输出原始 JSON
  --proxy <url> 代理地址（默认 http://127.0.0.1:7897，环境变量 BINANCE_PROXY 可覆盖）
  --no-proxy    不走代理直连
  --key <k>     API Key（可选，默认读环境变量 BINANCE_API_KEY）
  -h, --help    显示本帮助

数据接口（fapi.binance.com）:
  大户持仓量多空比   /futures/data/topLongShortPositionRatio    (官方标注需 API Key)
  大户账户数多空比   /futures/data/topLongShortAccountRatio     (官方标注需 API Key)
  全市场多空持仓人数比 /futures/data/globalLongShortAccountRatio
  合约主动买卖量     /futures/data/takerlongshortRatio

信号解读: 大户持仓多空比 >= 1.2 视为大户偏多，<= 0.8 视为大户偏空；主动买卖比 > 1 主动买盘占优。`;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.symbol) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  const { symbol, period, limit } = opts;
  if (!PERIODS.includes(period)) return fail(`无效周期: ${period}，可选值 ${PERIODS.join('/')}`);
  if (!(limit >= 1 && limit <= 500)) return fail('limit 必须在 1-500 之间');

  const results = await Promise.all(
    ENDPOINTS.map((ep) =>
      fetchEndpoint(ep, { symbol, period, limit, apiKey: opts.apiKey, proxy: opts.proxy })
        .catch((e) => ({ key: ep.key, name: ep.name, error: e.message }))
    )
  );

  const failed = results.filter((r) => r.error != null);
  if (failed.length === results.length) {
    return fail('所有接口请求失败: ' + failed.map((f) => `${f.name}(${f.error})`).join('; '));
  }

  if (opts.json) {
    const out = { symbol, period, fetchedAt: new Date().toISOString(), endpoints: {} };
    for (const r of results) out.endpoints[r.key] = r.error ? { name: r.name, error: r.error } : { name: r.name, data: r.data };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // 按时间戳对齐合并（taker 的时间戳是周期开始时间，加一个周期时长后对齐到结束时间）
  const map = new Map();
  for (const r of results) {
    if (r.error || !Array.isArray(r.data)) continue;
    for (const item of r.data) {
      const ts = r.key === 'taker' ? item.timestamp + PERIOD_MS[period] : item.timestamp;
      if (!map.has(ts)) map.set(ts, {});
      map.get(ts)[r.key] = item;
    }
  }
  const rows = [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, opts.rows)
    .map(([ts, row]) => ({ ts, ...row }));

  if (rows.length === 0) {
    return fail(`未获取到 ${symbol} 的任何数据，请检查合约名称是否正确（U 本位合约，如 BTCUSDT）`);
  }

  console.log(renderTable(symbol, period, rows));

  if (failed.length > 0) {
    console.log(`\n注意: 以下接口请求失败 - ${failed.map((f) => `${f.name}: ${f.error}`).join('; ')}`);
  }
  if (rows.length > 0 && rows[0].topPosition) {
    const latest = rows[0];
    const topPos = Number(latest.topPosition.longShortRatio);
    const taker = latest.taker ? Number(latest.taker.buySellRatio) : null;
    console.log(`\n最新信号: 大户持仓多空比 ${topPos.toFixed(4)}（${topPos >= 1.2 ? '偏多' : topPos <= 0.8 ? '偏空' : '中性'}）` +
      (taker !== null ? `，主动买卖比 ${taker.toFixed(4)}（${taker >= 1 ? '主动买盘占优' : '主动卖盘占优'}）` : ''));
  }
}

function fail(msg) {
  console.error('错误:', msg);
  process.exit(1);
}

module.exports = { httpsJson, errText, dispWidth, padStr };

if (require.main === module) {
  main().catch((e) => fail(e.message));
}
