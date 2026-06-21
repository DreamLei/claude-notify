#!/usr/bin/env bash
# Notification hook：Claude 等待用户（idle 超时未响应）→ 本机横幅 + 推手机。
# 从 stdin 的 message 字段取具体内容带进通知；无 jq 则用默认文案。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
case "$NOTIFY_ENABLED" in false|0|off|no) cat >/dev/null 2>&1; exit 0 ;; esac   # 通知总开关关 → 不提醒
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MSG=""
if command -v jq >/dev/null 2>&1; then
  MSG=$(cat 2>/dev/null | jq -r '.message // empty' 2>/dev/null)
else
  cat >/dev/null 2>&1 || true
fi
[ -z "$MSG" ] && MSG="需要你确认或选择，请回到终端"

afplay /System/Library/Sounds/Ping.aiff 2>/dev/null || true   # 等待提示音（零依赖）
bash "$DIR/notify-push.sh" "⏳ 等待你" "$MSG" 2>/dev/null || true
exit 0
