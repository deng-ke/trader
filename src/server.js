// 聪明钱仓位总览 Web 服务：API + 静态页面（可视化界面）
// 用法：
//   node src/server.js                 # 默认监听 3000 端口，走本地代理 127.0.0.1:7897
//   PORT=8080 node src/server.js       # 自定义端口
//   BINANCE_PROXY=http://127.0.0.1:7897 node src/server.js   # 自定义代理
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchOverview, fetchSymbols, fetchOverviewBatch } = require('./lib/overview');

const PORT = Number(process.env.PORT) || 3000;
const PROXY = process.env.BINANCE_PROXY || 'http://127.0.0.1:7897';
const PUBLIC_DIR = path.join(__dirname, 'public');
// 界面配置持久化文件（桌面模式随机端口下 localStorage 按 origin 隔离会丢失，故存服务端）
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LEGACY_PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const MAX_CONFIG_SYMBOLS = 30;
// 合约名：英文字母/数字/中文（币安存在中文命名的合约，如 哈基米USDT）
const SYMBOL_RE = /^[A-Z0-9\u4e00-\u9fa5]{2,20}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// 读取请求体（JSON，限 1MB）
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

// 界面配置持久化（服务端文件）：hasConfig 区分"无记录"与"记录为空列表"
// config.json 结构: { symbols: [SYMBOL], dotColors: { SYMBOL: '#RRGGBB' }, savedAt }
function readConfig() {
  try {
    const obj = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (obj && typeof obj === 'object') {
      return {
        hasConfig: true,
        symbols: Array.isArray(obj.symbols) ? obj.symbols : [],
        dotColors: obj.dotColors && typeof obj.dotColors === 'object' ? obj.dotColors : {},
      };
    }
  } catch (e) { /* 无文件或损坏 */ }
  // 兼容迁移旧版 data/prefs.json（仅含 symbols）
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_PREFS_FILE, 'utf8'));
    if (legacy && Array.isArray(legacy.symbols)) {
      return { hasConfig: true, symbols: legacy.symbols, dotColors: {} };
    }
  } catch (e) { /* 无旧文件 */ }
  return { hasConfig: false, symbols: [], dotColors: {} };
}

function writeConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...cfg, savedAt: Date.now() }, null, 2));
}

// 校验合约列表：大写、正则、去重、上限 30
function sanitizeSymbols(raw) {
  return [...new Set(raw.map((s) => String(s).toUpperCase()).filter((s) => SYMBOL_RE.test(s)))]
    .slice(0, MAX_CONFIG_SYMBOLS);
}

// 校验色块颜色映射：key 为合约名，value 为 #RRGGBB
function sanitizeDotColors(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (SYMBOL_RE.test(k) && typeof v === 'string' && COLOR_RE.test(v)) out[k] = v.toUpperCase();
    }
  }
  return out;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, rel);
  // 防目录穿越：解析后必须仍在 public 目录内
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname === '/api/overview') {
      const symbol = (u.searchParams.get('symbol') || '').toUpperCase();
      if (!/^[A-Z0-9\u4e00-\u9fa5]{2,20}$/.test(symbol)) return sendJson(res, 400, { error: '无效的合约名称' });
      try {
        const data = await fetchOverview(symbol, PROXY);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, e.statusCode || 502, { error: e.message });
      }
    }
    if (u.pathname === '/api/overviews') {
      const raw = (u.searchParams.get('symbols') || '').toUpperCase();
      const symbols = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Z0-9\u4e00-\u9fa5]{2,20}$/.test(s)))];
      if (symbols.length === 0) return sendJson(res, 400, { error: 'symbols 参数缺失或非法' });
      if (symbols.length > 40) return sendJson(res, 400, { error: '合约数量超过上限 40' });
      try {
        const results = await fetchOverviewBatch(symbols, { ttlMs: 30000, proxy: PROXY });
        return sendJson(res, 200, { results, fetchedAt: Date.now() });
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }
    if (u.pathname === '/api/symbols') {
      try {
        const list = await fetchSymbols(PROXY);
        return sendJson(res, 200, { symbols: list });
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }
    if (u.pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, readConfig());
    }
    if (u.pathname === '/api/config' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const cur = readConfig();
        // 部分更新：body 中提供的字段才覆盖，未提供则保留现有值
        const next = {
          symbols: body.symbols !== undefined ? sanitizeSymbols(Array.isArray(body.symbols) ? body.symbols : []) : cur.symbols,
          dotColors: body.dotColors !== undefined ? sanitizeDotColors(body.dotColors) : cur.dotColors,
        };
        writeConfig(next);
        return sendJson(res, 200, { ok: true, ...next });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    return serveStatic(res, u.pathname);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

// 启动 HTTP 服务；port=0 时自动选择空闲端口。返回 Promise<http.Server>
function startServer(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startServer };

// 直接运行时以网页服务模式启动
if (require.main === module) {
  startServer(PORT)
    .then(() => {
      console.log(`聪明钱总览服务已启动: http://localhost:${PORT}`);
      console.log(`代理: ${PROXY}`);
    })
    .catch((e) => {
      console.error('启动失败:', e.message);
      process.exit(1);
    });
}
