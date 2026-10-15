// 临时验证脚本：检查 Firefox 启动后标签页情况
const path = require('path');
const fs = require('fs');
const { firefox } = require('playwright');

const tmpDir = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;

(async () => {
  const browser = await firefox.launch({
    headless: false,
    channel: 'moz-firefox',
    executablePath: '/usr/bin/firefox',
    args: ['-no-remote'],
  });
  browser.on('context', () => console.log('[事件] context 创建'));
  browser.on('page', (p) => console.log('[事件] page 出现:', p.url()));
  browser.on('disconnected', () => console.log('[事件] 断开连接'));
  // 等待 Firefox 启动自开页被 Playwright 感知
  await new Promise((r) => setTimeout(r, 5000));
  for (const ctx of browser.contexts()) {
    const pages = ctx.pages();
    console.log('启动后 5 秒，context 中的页面:', pages.map((p) => p.url()));
  }
  await browser.close();
  console.log('验证完成');
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
