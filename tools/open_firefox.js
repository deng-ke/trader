// 使用 Playwright 打开 Firefox 浏览器（有头模式），启动时在同一个窗口打开多个标签页
// 用法：node tools/open_firefox.js [url1] [url2] ...
//   第一个 URL 由 Firefox 初始窗口打开（避免空白初始页），其余用 newPage 打开
const { firefox } = require('playwright');
const path = require('path');

// snap 版 Firefox 因沙箱隔离无法访问 /tmp（Playwright 默认在此创建临时 profile），
// 把临时目录改到工作区内，snap 可以访问家目录下的路径
const tmpDir = path.join(__dirname, '..', 'tmp');
require('fs').mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;

// 要打开的页面：命令行参数优先，未传参时用默认列表
const urls = process.argv.slice(2);
const targets = urls.length > 0 ? urls : [
  'https://www.baidu.com',
  'https://www.zhihu.com',
  'https://www.bilibili.com',
];

(async () => {
  // 使用系统已安装的 Firefox：
  // - channel: 'moz-firefox' 让 Playwright 走 WebDriver BiDi 协议
  // - executablePath 指定系统 Firefox 路径（优先于 channel 的默认路径）
  const browser = await firefox.launch({
    headless: false,
    channel: 'moz-firefox',
    executablePath: '/usr/bin/firefox',
    // 防止把请求转发给已运行的 Firefox 实例，确保 BiDi 在当前进程初始化
    args: ['-no-remote'],
    // 初始窗口直接加载第一个页面，避免出现空白初始页
    firefoxUserPrefs: {
      'browser.startup.page': 1, // 启动时打开主页
      'browser.startup.homepage': targets[0],
      'browser.aboutwelcome.enabled': false, // 禁用首次启动欢迎页
      'browser.newtabpage.enabled': false, // 禁用新标签页推荐内容
    },
  });

  // 其余页面用 Playwright 打开（patch 后 newPage 创建的是标签页而非窗口）
  for (const url of targets.slice(1)) {
    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    }).catch(() => console.log(`页面加载超时: ${url}`));
  }

  console.log(`Firefox 已启动，共打开 ${targets.length} 个标签页:`);
  targets.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  console.log('浏览器将保持打开，按 Ctrl+C 退出');
  // 保持运行，直到用户手动中断
  await new Promise(() => {});
})().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
