// 聪明钱仓位总览 - 多合约同屏视图
// 每张卡片精简展示：现价/涨跌幅、交易员与巨鲸的多空仓位占比、净仓位、未实现盈亏
'use strict';

const $ = (id) => document.getElementById(id);

// Electron 桌面模式：显示自定义标题栏并绑定窗口控制按钮
if (window.electronAPI) {
  $('titlebar').classList.remove('hidden');
  document.getElementById('min-btn').addEventListener('click', () => window.electronAPI.minimize());
  document.getElementById('close-btn').addEventListener('click', () => window.electronAPI.close());
}

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'SUIUSDT', 'LINKUSDT', 'AVAXUSDT', 'METUSDT'];
const STORAGE_KEY = 'sm_symbols_v1';
const USER_DOT_COLORS_KEY = 'sm_dot_colors_v1';
const MAX_SYMBOLS = 30;
const REFRESH_MS = 30000;

const els = {
  tabOverview: $('tab-overview'),
  tabScan: $('tab-scan'),
  overviewView: $('overview-view'),
  scanView: $('scan-view'),
  addInput: $('add-input'),
  addDropdown: $('add-dropdown'),
  autoRefresh: $('auto-refresh'),
  dotPicker: $('dot-picker'),
  refreshBtn: $('refresh-btn'),
  updateTime: $('update-time'),
  statusBox: $('status-box'),
  statusText: $('status-text'),
  spinner: $('spinner'),
  grid: $('grid'),
  scanHigh: $('scan-high'),
  scanLow: $('scan-low'),
  scanMin: $('scan-min'),
  scanBtn: $('scan-btn'),
  scanProgress: $('scan-progress'),
  scanResults: $('scan-results'),
};

const state = {
  symbols: [...DEFAULT_SYMBOLS], // 启动时由 loadSymbols 异步填充为上次展示的合约
  candidates: [], // /api/symbols 全量合约（用于添加搜索）
  loading: false,
  filterIdx: 0,
  lastResults: [], // 最近一次渲染结果，供颜色变更后重渲染
};

// ---------- 界面配置持久化 ----------
// 优先读服务端 /api/config（data/config.json，桌面模式随机端口下 localStorage 按 origin 隔离会丢失），
// 回退 localStorage 旧数据，再回退默认列表；"记录为空列表"会保持空（记忆用户删光的状态）
function loadSymbolsFromLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        return list.map((s) => String(s).toUpperCase()).slice(0, MAX_SYMBOLS);
      }
    }
  } catch (e) { /* 忽略损坏的存储 */ }
  return [...DEFAULT_SYMBOLS];
}

function loadUserColorsFromLocal() {
  try {
    const raw = localStorage.getItem(USER_DOT_COLORS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return obj;
    }
  } catch (e) { /* 忽略损坏的存储 */ }
  return {};
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const json = await res.json();
    if (res.ok && json && typeof json === 'object') return json;
  } catch (e) { /* 忽略，回退本地存储 */ }
  return null;
}

// 界面改动后写回：localStorage 兜底 + 服务端 data/config.json 全量保存（即发即走）
function saveConfig() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.symbols)); } catch (e) { /* 忽略 */ }
  try { localStorage.setItem(USER_DOT_COLORS_KEY, JSON.stringify(userColors)); } catch (e) { /* 忽略 */ }
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: state.symbols, dotColors: userColors }),
  }).catch(() => { /* 忽略 */ });
}

// ---------- 格式化 ----------
function fmtMoney(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function fmtPnl(v) {
  return `${v >= 0 ? '+' : ''}${fmtMoney(v)}`;
}

function fmtPrice(v) {
  if (v >= 1000) return v.toFixed(1);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function fmtPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// ---------- 数据加载 ----------
async function loadAll() {
  if (state.loading) return;
  if (state.symbols.length === 0) {
    els.spinner.classList.add('hidden');
    els.statusText.textContent = '列表为空，请添加合约';
    els.statusBox.classList.remove('hidden');
    els.grid.innerHTML = '';
    return;
  }
  state.loading = true;
  els.spinner.classList.remove('hidden');
  els.statusBox.classList.remove('hidden');
  els.statusText.textContent = `正在加载 ${state.symbols.length} 个合约数据…`;
  try {
    const res = await fetch(`/api/overviews?symbols=${state.symbols.join(',')}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    state.lastResults = json.results || [];
    renderGrid(state.lastResults);
    els.statusBox.classList.add('hidden');
    els.updateTime.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (e) {
    els.spinner.classList.add('hidden');
    els.statusText.textContent = `加载失败: ${e.message}`;
    els.grid.innerHTML = '';
  } finally {
    state.loading = false;
  }
}

// ---------- 渲染 ----------
// 合约标识色：同一合约名稳定映射到一种高亮色，同屏已占用时顺延避让保证互异；
// 用户自定义颜色（点击色块选择，存 data/config.json）优先于哈希分配
const DOT_COLORS = ['#f0b90b', '#4f8ef7', '#b47aff', '#2ed5c9', '#ff8a34', '#ff5ecf',
  '#9bd94d', '#8fd0ff', '#ffd24d', '#ff7a7a', '#5ee6a0', '#c9a2ff',
  '#ff9f43', '#54a0ff', '#f368e0', '#00d2d3', '#48dbfb', '#e056fd', '#10ac84', '#c44569'];

// 用户自定义色块颜色（{ SYMBOL: '#RRGGBB' }）：启动时由 init 填充，config 优先、localStorage 兜底
const userColors = {};

function dotColor(symbol, used) {
  if (userColors[symbol]) return userColors[symbol];
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  let idx = h % DOT_COLORS.length;
  // 同屏避让：顺延寻找空闲色，最多尝试一轮；颜色全部占用时接受重复（避免合约数超过色板数时死循环）
  let tries = 0;
  while (used.has(idx) && tries < DOT_COLORS.length) {
    idx = (idx + 1) % DOT_COLORS.length;
    tries++;
  }
  used.add(idx);
  return DOT_COLORS[idx];
}

function renderGrid(results) {
  els.grid.innerHTML = '';
  const usedDots = new Set();
  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.setProperty('--dot', dotColor(r.symbol, usedDots));
    if (!r.ok) {
      card.innerHTML = `
        <div class="card-head">
          <span class="sym"><span class="dot" title="点击自定义颜色"></span>${escapeHtml(r.symbol)}</span>
          <button class="remove" data-symbol="${escapeHtml(r.symbol)}" title="移除">×</button>
        </div>
        <div class="card-error">${escapeHtml(r.error || '加载失败')}</div>`;
    } else {
      card.innerHTML = buildCardHtml(r.data);
    }
    els.grid.appendChild(card);
  }
  // 移除按钮
  for (const btn of els.grid.querySelectorAll('.remove')) {
    btn.addEventListener('click', () => removeSymbol(btn.dataset.symbol));
  }
  // 色块点击自定义颜色
  for (const dot of els.grid.querySelectorAll('.dot')) {
    dot.addEventListener('click', (e) => openDotPicker(e, dot.closest('.card')));
  }
}

// ---------- 色块颜色自定义（点击色块弹出预设色板） ----------
const dotPickerState = { symbol: '' };

function openDotPicker(e, card) {
  dotPickerState.symbol = card.querySelector('.sym').textContent.trim();
  const custom = userColors[dotPickerState.symbol] || '';
  els.dotPicker.innerHTML =
    DOT_COLORS.map((c) =>
      `<button class="swatch${c === custom ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`)
      .join('') +
    '<button class="swatch-clear" title="恢复为按合约名自动分配的颜色">恢复默认颜色</button>';
  els.dotPicker.classList.remove('hidden');
  const rect = e.target.getBoundingClientRect();
  const pw = els.dotPicker.offsetWidth;
  const ph = els.dotPicker.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - pw - 8);
  let top = rect.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  els.dotPicker.style.left = `${Math.max(8, left)}px`;
  els.dotPicker.style.top = `${Math.max(8, top)}px`;
}

function setDotColor(color) {
  const symbol = dotPickerState.symbol;
  if (!symbol) return;
  if (color) userColors[symbol] = color;
  else delete userColors[symbol]; // 恢复默认
  saveConfig();
  closeDotPicker();
  renderGrid(state.lastResults); // 重渲染应用新颜色
}

function closeDotPicker() {
  els.dotPicker.classList.add('hidden');
  dotPickerState.symbol = '';
}

els.dotPicker.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (sw) { setDotColor(sw.dataset.color); return; }
  if (e.target.closest('.swatch-clear')) setDotColor(null);
});

// 卡片 HTML：头部（合约/价格/涨跌）+ 交易员、巨鲸各两行（多空条 + 净仓位与盈亏）
function buildCardHtml(d) {
  const g = d.groups; // [交易员多, 交易员空, 巨鲸多, 巨鲸空]
  const chg = d.priceChangePercent;
  const chgClass = chg >= 0 ? 'up' : 'down';
  return `
    <div class="card-head">
      <span class="sym"><span class="dot" title="点击自定义颜色"></span>${escapeHtml(d.symbol)}</span>
      <span class="price">${fmtPrice(d.price)}</span>
      <span class="chg ${chgClass}">${fmtPct(chg)}</span>
      <span class="volume" title="24h成交额">量 ${fmtMoney(d.quoteVolume)}</span>
      <button class="remove" data-symbol="${escapeHtml(d.symbol)}" title="移除">×</button>
    </div>
    <div class="row">
      <span class="tag">交易员</span>
      <div class="track"><div class="track-long" style="width:${pct(g[0], g[1])}%"></div></div>
      <span class="track-label">${pct(g[0], g[1])}% 多</span>
    </div>
    <div class="row">
      <span class="pos long"><span>多 +${fmtMoney(g[0].positionUsdt)}</span><span class="entry">均价 ${entryText(g[0].avgEntry)}</span></span>
      <span class="pos short"><span>空 -${fmtMoney(g[1].positionUsdt)}</span><span class="entry">均价 ${entryText(g[1].avgEntry)}</span></span>
      <span class="pnl ${clsPnl(g[0], g[1])}" title="交易员未实现盈亏合计">${fmtPnl(g[0].pnl + g[1].pnl)}</span>
    </div>
    <div class="row">
      <span class="tag">巨鲸</span>
      <div class="track"><div class="track-long" style="width:${pct(g[2], g[3])}%"></div></div>
      <span class="track-label">${pct(g[2], g[3])}% 多</span>
    </div>
    <div class="row">
      <span class="pos long"><span>多 +${fmtMoney(g[2].positionUsdt)}</span><span class="entry">均价 ${entryText(g[2].avgEntry)}</span></span>
      <span class="pos short"><span>空 -${fmtMoney(g[3].positionUsdt)}</span><span class="entry">均价 ${entryText(g[3].avgEntry)}</span></span>
      <span class="pnl ${clsPnl(g[2], g[3])}" title="巨鲸未实现盈亏合计">${fmtPnl(g[2].pnl + g[3].pnl)}</span>
    </div>`;
}

// 多头仓位占比（%）
function pct(long, short) {
  const total = long.positionUsdt + short.positionUsdt;
  if (total <= 0) return 50;
  return Math.round((long.positionUsdt / total) * 100);
}

// 开仓均价显示文本（无数据时为 0，显示占位符）
function entryText(v) {
  return v > 0 ? fmtPrice(v) : '—';
}

function clsPnl(long, short) {
  return long.pnl + short.pnl >= 0 ? 'up' : 'down';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 状态提示 ----------
function flashStatus(msg) {
  // 扫描页显示时，提示写在扫描进度行（总览的提示框在隐藏视图里不可见）
  if (!els.scanView.classList.contains('hidden')) {
    els.scanProgress.textContent = msg;
    clearTimeout(flashStatus.timer);
    flashStatus.timer = setTimeout(() => { els.scanProgress.textContent = ''; }, 2500);
    return;
  }
  els.spinner.classList.add('hidden');
  els.statusText.textContent = msg;
  els.statusBox.classList.remove('hidden');
  clearTimeout(flashStatus.timer);
  flashStatus.timer = setTimeout(() => els.statusBox.classList.add('hidden'), 2500);
}

// ---------- 合约增删 ----------
function addSymbol(symbol) {
  const s = symbol.toUpperCase();
  if (state.symbols.includes(s)) {
    flashStatus(`${s} 已在展示列表中`);
    els.addInput.value = '';
    closeDropdown();
    return;
  }
  if (state.symbols.length >= MAX_SYMBOLS) {
    flashStatus(`最多展示 ${MAX_SYMBOLS} 个合约，请先移除部分`);
    return;
  }
  state.symbols.push(s);
  saveConfig();
  els.addInput.value = '';
  closeDropdown();
  loadAll();
}

function removeSymbol(symbol) {
  state.symbols = state.symbols.filter((s) => s !== symbol);
  saveConfig();
  if (state.symbols.length === 0) {
    els.spinner.classList.add('hidden');
    els.statusText.textContent = '列表为空，请添加合约';
    els.statusBox.classList.remove('hidden');
    els.grid.innerHTML = '';
    return;
  }
  loadAll();
}

// ---------- 添加合约下拉搜索 ----------
async function loadCandidates() {
  if (state.candidates.length > 0) return;
  try {
    const res = await fetch('/api/symbols');
    const json = await res.json();
    if (json.symbols) state.candidates = json.symbols;
  } catch (e) { /* 忽略，输入 Enter 仍可添加 */ }
}

async function openDropdown() {
  if (state.candidates.length === 0) {
    await loadCandidates(); // 候选列表未就绪时等待加载（启动即预加载，通常已就绪）
    if (state.candidates.length === 0) return;
  }
  const kw = els.addInput.value.trim().toUpperCase();
  // 已展示的合约也显示（标注"已展示"），避免用户搜索不到产生困惑
  const matches = state.candidates
    .filter((c) => !kw || c.symbol.includes(kw) || c.baseAsset.startsWith(kw))
    .sort((a, b) => {
      const aStarts = a.symbol.startsWith(kw) ? 1 : 0;
      const bStarts = b.symbol.startsWith(kw) ? 1 : 0;
      if (aStarts !== bStarts) return bStarts - aStarts;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 8);
  if (matches.length === 0) { closeDropdown(); return; }
  state.filterIdx = 0;
  els.addDropdown.innerHTML = matches
    .map((c, i) => {
      const exists = state.symbols.includes(c.symbol);
      return `<div class="dd-item${i === 0 ? ' active' : ''}${exists ? ' exists' : ''}" data-symbol="${c.symbol}">${c.symbol}<span class="muted">${exists ? '已展示' : c.baseAsset}</span></div>`;
    })
    .join('');
  els.addDropdown.classList.remove('hidden');
  for (const item of els.addDropdown.querySelectorAll('.dd-item')) {
    item.addEventListener('mousedown', (e) => { e.preventDefault(); addSymbol(item.dataset.symbol); });
  }
}

function closeDropdown() {
  els.addDropdown.classList.add('hidden');
  els.addDropdown.innerHTML = '';
}

function moveDropdown(dir) {
  const items = els.addDropdown.querySelectorAll('.dd-item');
  if (items.length === 0) return;
  state.filterIdx = (state.filterIdx + dir + items.length) % items.length;
  items.forEach((it, i) => it.classList.toggle('active', i === state.filterIdx));
}

els.addInput.addEventListener('input', openDropdown);
els.addInput.addEventListener('focus', () => { loadCandidates(); openDropdown(); });
els.addInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveDropdown(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveDropdown(-1); }
  else if (e.key === 'Enter') {
    const active = els.addDropdown.querySelector('.dd-item.active');
    const symbol = (active ? active.dataset.symbol : els.addInput.value.trim()).toUpperCase();
    // 允许英文/数字/中文合约名（如 哈基米USDT）
    if (/^[A-Z0-9\u4e00-\u9fa5]{2,20}$/.test(symbol)) addSymbol(symbol);
  } else if (e.key === 'Escape') { closeDropdown(); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) closeDropdown();
  if (!e.target.closest('.dot') && !e.target.closest('.dot-picker')) closeDotPicker();
});

// ---------- 极端多空比扫描页（对应 tools/find_extreme_ratio.js 的 CLI 功能） ----------
// 扫描全部 USDT 永续合约，筛选组合条件：多头占比 >= high 且综合仓位 > minPosition（偏多组），
// 或多头占比 <= low 且综合仓位 > minPosition（偏空组）。前端分批复用 /api/overviews 批量接口。
const SCAN_BATCH = 20; // 每批请求数（≤ /api/overviews 单次上限 40）
const SCAN_AUTO_MS = 10 * 60 * 1000; // 扫描页可见时每 10 分钟自动扫描一次
const scanState = { running: false, stop: false };

// 多头占比（%）：由名义多空比率换算，与 CLI 口径一致
function longPct(summary) {
  const ratio = Number(summary.longShortRatio) || 0;
  if (ratio <= 0) return 50;
  return (ratio / (1 + ratio)) * 100;
}

async function runScan(auto) {
  if (scanState.running) { scanState.stop = true; return; } // 扫描中：按钮变为停止
  const high = Number(els.scanHigh.value);
  const low = Number(els.scanLow.value);
  const minPosition = Number(els.scanMin.value);
  if (!(high > low && high > 50 && low < 50)) {
    if (!auto) flashStatus('参数错误: 需要 偏空阈值 < 50 < 偏多阈值，且偏空 < 偏多');
    return;
  }
  if (!Number.isFinite(minPosition) || minPosition < 0) {
    if (!auto) flashStatus('综合仓位阈值无效');
    return;
  }
  scanState.running = true;
  scanState.stop = false;
  els.scanBtn.textContent = '停止扫描';
  els.scanProgress.textContent = '';
  els.scanResults.innerHTML = '';

  if (state.candidates.length === 0) await loadCandidates();
  const symbols = state.candidates.map((c) => c.symbol);
  const longSide = [];  // 极端偏多且大仓位
  const shortSide = []; // 极端偏空且大仓位
  let done = 0, failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < symbols.length; i += SCAN_BATCH) {
    if (scanState.stop) break;
    const batch = symbols.slice(i, i + SCAN_BATCH);
    let results = [];
    try {
      const res = await fetch(`/api/overviews?symbols=${batch.join(',')}`);
      const json = await res.json();
      if (res.ok) results = json.results || [];
      else failed += batch.length;
    } catch (e) { failed += batch.length; }
    for (const r of results) {
      done++;
      if (!r.ok) continue; // 无聪明钱数据的合约跳过
      const d = r.data;
      const pctLong = longPct(d.summary);
      const totalPos = d.groups[0].positionUsdt + d.groups[1].positionUsdt;
      if (totalPos <= minPosition) continue; // 综合仓位不足
      if (pctLong >= high || pctLong <= low) {
        const item = {
          symbol: r.symbol,
          price: d.price,
          chg: d.priceChangePercent,
          pctLong,
          tradersLong: d.groups[0].positionUsdt,
          tradersShort: d.groups[1].positionUsdt,
          volume: d.quoteVolume, // 24h 成交额（USDT）
        };
        if (pctLong >= high) longSide.push(item);
        else shortSide.push(item);
      }
    }
    els.scanProgress.textContent = `扫描进度: ${done + failed}/${symbols.length}（命中 ${longSide.length + shortSide.length}），已用时 ${Math.round((Date.now() - t0) / 1000)}s`;
  }

  // 排序：两组均按 24h 成交额从高到低
  longSide.sort((a, b) => b.volume - a.volume);
  shortSide.sort((a, b) => b.volume - a.volume);

  const stopped = scanState.stop;
  scanState.running = false;
  scanState.stop = false;
  els.scanBtn.textContent = '开始扫描';
  renderScanResults({ longSide, shortSide, high, low, minPosition, done, failed, ms: Date.now() - t0, stopped });
  els.scanProgress.textContent = `${stopped ? '已停止' : '扫描完成'}: 共 ${done + failed} 个合约（失败 ${failed}），命中 ${longSide.length + shortSide.length} 个，用时 ${Math.round((Date.now() - t0) / 1000)}s`;
}

function renderScanResults({ longSide, shortSide, high, low, minPosition, done, failed, ms, stopped }) {
  const header = ['合约', '现价', '24h涨跌', '多头占比', '多仓(USDT)', '空仓(USDT)', '综合仓位', '24h成交额', ''];
  els.scanResults.innerHTML = `
    <div class="scan-summary">条件: 多头占比 ≥ ${high}% 或 ≤ ${low}%，且综合仓位（多仓+空仓） &gt; ${fmtMoney(minPosition)} USDT${stopped ? '（已手动停止）' : ''}</div>
    ${buildScanTable('long', `极端偏多且大仓位（多头占比 ≥ ${high}%）`, longSide, header)}
    ${buildScanTable('short', `极端偏空且大仓位（多头占比 ≤ ${low}%）`, shortSide, header)}`;
  // 加入总览按钮
  for (const btn of els.scanResults.querySelectorAll('.scan-add')) {
    btn.addEventListener('click', () => {
      addSymbol(btn.dataset.symbol);
      btn.disabled = true;
      btn.textContent = '已关注';
    });
  }
}

function buildScanTable(side, title, rows, header) {
  if (rows.length === 0) {
    return `<div class="scan-group"><div class="scan-group-title ${side}">${escapeHtml(title)}</div><div class="scan-empty">无命中合约</div></div>`;
  }
  const body = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.symbol)}</td>
      <td>${fmtPrice(r.price)}</td>
      <td class="${r.chg >= 0 ? 'up' : 'down'}">${fmtPct(r.chg)}</td>
      <td class="${side === 'long' ? 'long-pct' : 'short-pct'}">${r.pctLong.toFixed(1)}%</td>
      <td>${fmtMoney(r.tradersLong)}</td>
      <td>${fmtMoney(r.tradersShort)}</td>
      <td>${fmtMoney(r.tradersLong + r.tradersShort)}</td>
      <td>${fmtMoney(r.volume)}</td>
      <td><button class="scan-add" data-symbol="${escapeHtml(r.symbol)}" title="加入仓位总览展示">＋关注</button></td>
    </tr>`).join('');
  return `<div class="scan-group">
    <div class="scan-group-title ${side}">${escapeHtml(title)}（${rows.length} 个）</div>
    <table class="scan-table">
      <thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

// ---------- 页签切换 ----------
function switchTab(name) {
  const overview = name === 'overview';
  els.overviewView.classList.toggle('hidden', !overview);
  els.scanView.classList.toggle('hidden', overview);
  els.tabOverview.classList.toggle('active', overview);
  els.tabScan.classList.toggle('active', !overview);
}
els.tabOverview.addEventListener('click', () => switchTab('overview'));
els.tabScan.addEventListener('click', () => switchTab('scan'));
els.scanBtn.addEventListener('click', runScan);

// ---------- 色块大小固定 12px（--dot-size 变量见 style.css） ----------

// ---------- 刷新控制 ----------
els.refreshBtn.addEventListener('click', loadAll);

let timer = null;
function syncAutoRefresh() {
  if (timer) { clearInterval(timer); timer = null; }
  if (els.autoRefresh.checked) {
    timer = setInterval(() => { if (!document.hidden) loadAll(); }, REFRESH_MS);
  }
}
els.autoRefresh.addEventListener('change', syncAutoRefresh);

// 扫描自动刷新：全局定时器，任一页签下都每 10 分钟自动扫描一次（页面隐藏/正在扫描时跳过该轮）
let scanTimer = null;
function syncScanAuto() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  scanTimer = setInterval(() => {
    if (!document.hidden && !scanState.running) runScan(true);
  }, SCAN_AUTO_MS);
}

// ---------- 启动 ----------
(async function init() {
  const cfg = await loadConfig();
  if (cfg && cfg.hasConfig && Array.isArray(cfg.symbols)) {
    state.symbols = cfg.symbols.slice(0, MAX_SYMBOLS);
    Object.assign(userColors, loadUserColorsFromLocal(), cfg.dotColors || {}); // config 优先
  } else {
    state.symbols = loadSymbolsFromLocal();
    Object.assign(userColors, loadUserColorsFromLocal());
  }
  saveConfig(); // 首次启动（无服务端记录）时创建记录，下次启动即按上次展示恢复
  syncAutoRefresh();
  syncScanAuto();
  runScan(true); // 启动即自动扫描一轮，之后由定时器每 10 分钟一轮
  loadCandidates(); // 预加载合约候选列表，保证首次搜索即有结果
  loadAll();
})();
