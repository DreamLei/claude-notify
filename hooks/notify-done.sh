#!/usr/bin/env bash
# Stop hook：本轮任务结束的本机通知。装了 terminal-notifier 用桌面横幅，否则回退 afplay 提示音。不推手机。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
cat >/dev/null 2>&1 || true   # 消费 stdin
case "$NOTIFY_ENABLED" in false|0|off|no) exit 0 ;; esac   # 通知总开关关 → 不提醒
TN=$(command -v terminal-notifier 2>/dev/null)
ICON="$(cd "$(dirname "$0")/../assets" 2>/dev/null && pwd)/cc-icon.png"   # Claude Code logo（自包含于本插件 assets/）
if [ -n "$TN" ]; then
  "$TN" -title "Claude Code" -subtitle "✅ 完成" -message "本轮任务已结束" -sound Glass -appIcon "$ICON" -contentImage "$ICON" 2>/dev/null || true
else
  afplay /System/Library/Sounds/Glass.aiff 2>/dev/null || true
fi
exit 0
