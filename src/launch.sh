#!/usr/bin/env bash
# 聪明钱仓位总览桌面应用启动脚本（供 .desktop 快捷方式调用）
# 说明：桌面环境 PATH 有限，优先用项目内 electron，找不到则回退 nvm 的 node 全局 electron
set -euo pipefail

cd "$HOME/5_个人/binance"

ELECTRON_BIN=""
if [ -x "./node_modules/.bin/electron" ]; then
  ELECTRON_BIN="$(pwd)/node_modules/.bin/electron"
elif [ -x "$HOME/.nvm/versions/node/v24.14.1/bin/electron" ]; then
  ELECTRON_BIN="$HOME/.nvm/versions/node/v24.14.1/bin/electron"
fi

if [ -z "$ELECTRON_BIN" ]; then
  notify-send "聪明钱仓位总览" "未找到 Electron，请先执行 npm install" 2>/dev/null || true
  exit 1
fi

exec "$ELECTRON_BIN" src/electron/main.js
