#!/usr/bin/env bash
# Notification hook：Claude 等待用户时本机通知。装了 terminal-notifier 用桌面横幅，否则回退 afplay 提示音。
# 不推手机——手机推送只由 ask_dialog 弹窗「超时未处理」精准触发，避免轰炸。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
# 通知总开关：优先 NOTIFY_ENABLED，否则读插件自动注入的 CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS，默认开（理由同 notify-done.sh）。
ENABLED="${NOTIFY_ENABLED:-${CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS:-true}}"
case "$ENABLED" in false|0|off|no) cat >/dev/null 2>&1; exit 0 ;; esac   # 通知总开关关
MSG=""
if command -v jq >/dev/null 2>&1; then MSG=$(cat 2>/dev/null | jq -r '.message // empty' 2>/dev/null); else cat >/dev/null 2>&1 || true; fi
[ -z "$MSG" ] && MSG="需要你确认或选择，请回到终端"

# 若 ask_dialog 弹窗正活跃（MCP server 已弹自己的浮顶提问框），跳过本横幅，避免「提问框 + 等待你」双弹。
# Notification 事件可能略早于 MCP server 写锁，故首查不到时给一点缓冲再判一次。
LOCK="$HOME/.claude/.ask-dialog-active"
REGDIR="$HOME/.claude/.ask-dialog-registry"
ask_dialog_active() {
  now=$(date +%s)
  # ① 单锁快路径（单会话/旧版兼容）：纯数字时间戳且 1800s 内（兜底防 server 异常退出残留死锁）
  if [ -f "$LOCK" ]; then
    ts=$(cat "$LOCK" 2>/dev/null)
    case "$ts" in ''|*[!0-9]*) ;; *) [ $((now - ts)) -lt 1800 ] && return 0 ;; esac
  fi
  # ② 多会话：锁是全机共享的，可能被另一会话关窗时误删，故再扫按 pid 隔离的注册表——
  #    任一会话的 <pid>.json 仍有活跃弹窗(dialogs 非空)且文件 1800s 内新鲜，即视为活跃。
  [ -d "$REGDIR" ] || return 1
  for f in "$REGDIR"/*.json; do
    [ -f "$f" ] || continue
    mt=$(stat -f %m "$f" 2>/dev/null); [ -n "$mt" ] || continue
    [ $((now - mt)) -lt 1800 ] || continue
    grep -q '"dialogs":\[{' "$f" 2>/dev/null && return 0   # 非空 dialogs 数组（紧凑 JSON，无空格）
  done
  return 1
}
ask_dialog_active || sleep 1.2
ask_dialog_active && exit 0

TN=$(command -v terminal-notifier 2>/dev/null)
ICON="$(cd "$(dirname "$0")/../assets" 2>/dev/null && pwd)/cc-icon.png"   # Claude Code logo（自包含于本插件 assets/）
if [ -n "$TN" ]; then
  # 渲染横幅的是常驻 GUI 进程 terminal-notifier.app，它继承 launchd 环境而非本脚本的 export。
  # 在 launchd 全局 locale 为空(C)的机器上，中文会被按 Latin-1 渲染成 æµ 乱码 → 此处把 launchd
  # 环境强制为 UTF-8，保证 app 下次冷启动以 UTF-8 正确渲染中文(幂等，失败静默不影响通知)。
  launchctl setenv LANG en_US.UTF-8 2>/dev/null || true
  launchctl setenv LC_CTYPE en_US.UTF-8 2>/dev/null || true
  "$TN" -title "Claude Code" -subtitle "⏳ 等待你" -message "$MSG" -sound Ping -appIcon "$ICON" -contentImage "$ICON" 2>/dev/null || true
else
  afplay /System/Library/Sounds/Ping.aiff 2>/dev/null || true
fi
exit 0
