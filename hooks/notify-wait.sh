#!/usr/bin/env bash
# Notification hook：Claude 等待用户（idle 超时未响应）→ 本机横幅 + 推手机。
# 从 stdin 的 message 字段取具体内容带进通知；无 jq 则用默认文案。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MSG=""
if command -v jq >/dev/null 2>&1; then
  MSG=$(cat 2>/dev/null | jq -r '.message // empty' 2>/dev/null)
else
  cat >/dev/null 2>&1 || true
fi
[ -z "$MSG" ] && MSG="需要你确认或选择，请回到终端"

TN=$(command -v terminal-notifier 2>/dev/null)
[ -n "$TN" ] && "$TN" -title "Claude Code" -subtitle "⏳ 等待你" -message "$MSG" -sound Ping 2>/dev/null || true
bash "$DIR/notify-push.sh" "⏳ 等待你" "$MSG" 2>/dev/null || true
exit 0
