// 聪明钱仓位总览 - Electron 桌面应用主进程
// 功能：内部启动 HTTP 服务（随机端口）+ 无边框应用窗口 + 系统托盘（驻留后台）
// 窗口关闭按钮 → 隐藏到托盘；托盘菜单可恢复窗口或退出。
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { startServer } = require('../server');

// 应用名与 .desktop 的 StartupWMClass 对应，确保任务栏图标正确归组
app.setName('smart-money');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 960;

let mainWindow = null;
let tray = null;
let server = null;
let isQuitting = false;

// 单实例锁：重复启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(startApp);
}

async function startApp() {
  // 内部 HTTP 服务（API + 前端页面）
  server = await startServer(0);
  const url = `http://127.0.0.1:${server.address().port}/?desktop=1`;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    icon: ICON_PATH,
    frame: false, // 无系统边框，前端自定义标题栏
    backgroundColor: '#0b0e11',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 关闭窗口 → 隐藏到托盘（真正退出走托盘菜单的"退出"）
  const onWindowClose = (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  };
  mainWindow.on('close', onWindowClose);

  await mainWindow.loadURL(url);
  createTray(onWindowClose);

  // 调试截图模式：SCREENSHOT_PATH=/tmp/x.png electron src/electron/main.js
  if (process.env.SCREENSHOT_PATH) {
    setTimeout(async () => {
      const status = await mainWindow.webContents.executeJavaScript(
        `(async () => {
           const input = document.getElementById('add-input');
           input.value = 'DOGEUSDT';
           input.dispatchEvent(new Event('input', { bubbles: true }));
           await new Promise((r) => setTimeout(r, 7000));
           const items = [...document.querySelectorAll('#add-dropdown .dd-item')].map((it) => it.innerText);
           return { hasAPI: !!window.electronAPI,
                    titlebarHidden: document.getElementById('titlebar').classList.contains('hidden'),
                    cardCount: document.querySelectorAll('.card').length,
                    searchItems: items };
         })()`
      ).catch(() => null);
      console.log('[调试] 页面状态:', JSON.stringify(status));
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.SCREENSHOT_PATH, img.toPNG());
      isQuitting = true;
      app.quit();
    }, 8000);
  }
}

// 系统托盘：图标 + 菜单（显示主窗口 / 退出）；图标由 Electron 运行时缩放
function createTray(onWindowClose) {
  try {
    const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 24, height: 24 });
    tray = new Tray(icon);
    tray.setToolTip('聪明钱仓位总览');
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => showMainWindow());
  } catch (e) {
    // 桌面环境不支持托盘（如未安装 AppIndicator 扩展）时降级：关闭窗口即退出
    console.warn('托盘不可用，关闭窗口将直接退出:', e.message);
    mainWindow.removeListener('close', onWindowClose);
  }
}

function showMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

// 前端标题栏按钮
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-hide', () => mainWindow && mainWindow.hide());

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});
