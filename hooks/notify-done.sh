#!/usr/bin/env bash
# Stop hook：本轮任务结束的本机通知。装了 terminal-notifier 用桌面横幅，否则回退 afplay 提示音。不推手机。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
IN=$(cat 2>/dev/null)   # 读入 stdin（Stop hook 的 JSON，含 transcript_path），供取任务主题用
# 通知总开关：优先脚本入参 NOTIFY_ENABLED（直接调用兼容），否则读插件自动注入的 CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS，默认开。
# 不再在 hooks.json 命令串里内联 ${user_config.*}：那是 bash 参数展开，未被 harness 替换时会 bad substitution 导致整条 hook 失败、脚本根本不跑。
ENABLED="${NOTIFY_ENABLED:-${CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS:-true}}"
case "$ENABLED" in false|0|off|no) exit 0 ;; esac   # 通知总开关关 → 不提醒
DIR="$(cd "$(dirname "$0")" && pwd)"
# 任务主题：从 stdin 的 transcript_path 取 ai-title（精确对应本会话）；取不到回退固定文案。
MSG="本轮任务已结束"
if command -v jq >/dev/null 2>&1; then
  TR=$(printf '%s' "$IN" | jq -r '.transcript_path // empty' 2>/dev/null)
  TOPIC=$(bash "$DIR/session-topic.sh" "$TR" 2>/dev/null)
  [ -n "$TOPIC" ] && MSG="$TOPIC"
fi
TN=$(command -v terminal-notifier 2>/dev/null)
ICON="$(cd "$(dirname "$0")/../assets" 2>/dev/null && pwd)/cc-icon.png"   # Claude Code logo（自包含于本插件 assets/）
if [ -n "$TN" ]; then
  # 渲染横幅的是常驻 GUI 进程 terminal-notifier.app，它继承 launchd 环境而非本脚本的 export。
  # 在 launchd 全局 locale 为空(C)的机器上，中文会被按 Latin-1 渲染成 æµ 乱码 → 此处把 launchd
  # 环境强制为 UTF-8，保证 app 下次冷启动以 UTF-8 正确渲染中文(幂等，失败静默不影响通知)。
  launchctl setenv LANG en_US.UTF-8 2>/dev/null || true
  launchctl setenv LC_CTYPE en_US.UTF-8 2>/dev/null || true
  "$TN" -title "Claude Code" -subtitle "✅ 完成" -message "$MSG" -sound Glass -appIcon "$ICON" -contentImage "$ICON" 2>/dev/null || true
else
  afplay /System/Library/Sounds/Glass.aiff 2>/dev/null || true
fi
exit 0
