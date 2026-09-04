#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

echo "正在配置 macOS 组长教学工作台……"
if ! command -v brew >/dev/null 2>&1; then
  echo "正在安装 Homebrew（系统可能要求输入本机登录密码）……"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
fi

command -v python3 >/dev/null 2>&1 || brew install python@3.12
command -v node >/dev/null 2>&1 || brew install node
command -v pwsh >/dev/null 2>&1 || brew install --cask powershell
if [ ! -d "/Applications/Google Chrome.app" ]; then brew install --cask google-chrome; fi

chmod +x "$APP_DIR/启动组长工作台.command" "$APP_DIR/首次安装一键配置.command"
mkdir -p "$HOME/Library/Application Support/CodeMaoTeachingWorkbench/data"

echo "运行环境配置完成。接下来请在 Chrome 中加载连接器。"
open -a "Google Chrome" "chrome://extensions/"
open "$APP_DIR/chrome-extension"
osascript -e 'display dialog "请在 Chrome 扩展程序页面打开‘开发者模式’，点击‘加载已解压的扩展程序’，选择刚刚打开的 chrome-extension 文件夹。完成后点击继续。" buttons {"继续"} default button "继续" with title "安装编程猫 CRM 连接器"' 2>/dev/null || true
"$APP_DIR/启动组长工作台.command"
