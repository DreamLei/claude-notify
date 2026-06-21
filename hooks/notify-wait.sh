#!/usr/bin/env bash
# Notification hook：Claude 等待用户时本机通知。装了 terminal-notifier 用桌面横幅，否则回退 afplay 提示音。
# 不推手机——手机推送只由 ask_dialog 弹窗「超时未处理」精准触发，避免轰炸。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
case "$NOTIFY_ENABLED" in false|0|off|no) cat >/dev/null 2>&1; exit 0 ;; esac   # 通知总开关关
MSG=""
if command -v jq >/dev/null 2>&1; then MSG=$(cat 2>/dev/null | jq -r '.message // empty' 2>/dev/null); else cat >/dev/null 2>&1 || true; fi
[ -z "$MSG" ] && MSG="需要你确认或选择，请回到终端"
TN=$(command -v terminal-notifier 2>/dev/null)
if [ -n "$TN" ]; then
  "$TN" -title "Claude Code" -subtitle "⏳ 等待你" -message "$MSG" -sound Ping 2>/dev/null || true
else
  afplay /System/Library/Sounds/Ping.aiff 2>/dev/null || true
fi
exit 0
