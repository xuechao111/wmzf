#!/bin/bash
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$HOME/Library/Application Support/CodeMaoTeachingWorkbench/data"
PORT="8765"
URL="http://127.0.0.1:${PORT}/"
LOG_FILE="$RUNTIME_DIR/bridge.log"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
mkdir -p "$RUNTIME_DIR"

missing=""
command -v pwsh >/dev/null 2>&1 || missing="$missing PowerShell"
command -v python3 >/dev/null 2>&1 || missing="$missing Python"
command -v node >/dev/null 2>&1 || missing="$missing Node.js"
if [ -n "$missing" ]; then
  osascript -e "display alert \"需要先安装运行环境\" message \"缺少：$missing。请双击‘首次安装一键配置.command’。\" as critical" 2>/dev/null || true
  exit 1
fi

# Migrate a locally configured package once; later upgrades never overwrite runtime data.
for name in dashboard-config.json share-config.json status.json scholarship-status.json service-status.json service-data.json; do
  if [ ! -e "$RUNTIME_DIR/$name" ] && [ -e "$APP_DIR/$name" ]; then
    cp "$APP_DIR/$name" "$RUNTIME_DIR/$name"
  fi
done

if curl -fsS --max-time 2 "$URL/service-info" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

# Remove only a stale workbench process. Never terminate an unrelated service on this port.
port_pid="$(lsof -ti tcp:${PORT} 2>/dev/null | head -n 1 || true)"
if [ -n "$port_pid" ]; then
  command_line="$(ps -p "$port_pid" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *bridge.ps1*) kill "$port_pid" 2>/dev/null || true ;;
    *)
      osascript -e "display alert \"端口 ${PORT} 已被其他程序占用\" message \"请关闭占用程序后重试，工作台不会强制结束无关程序。\" as critical" 2>/dev/null || true
      exit 1
      ;;
  esac
fi

export HF_DASHBOARD_ROOT="$RUNTIME_DIR"
export HF_DASHBOARD_SOURCE_ROOT="$APP_DIR"
export HF_DASHBOARD_PORT="$PORT"
export HF_DASHBOARD_INSTANCE="macos"
export HF_DASHBOARD_NO_OPEN="1"
nohup pwsh -NoLogo -NoProfile -File "$APP_DIR/bridge.ps1" >>"$LOG_FILE" 2>&1 &

ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$URL/service-info" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -eq 1 ]; then
  open "$URL"
else
  open -R "$LOG_FILE"
  osascript -e 'display alert "工作台启动失败" message "已在访达中定位 bridge.log，请将该文件发给维护人员。" as critical' 2>/dev/null || true
  exit 1
fi
