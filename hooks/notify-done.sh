#!/usr/bin/env bash
# Stop hook：本轮任务结束的本机桌面通知（完成不推手机，避免每轮骚扰）。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
cat >/dev/null 2>&1 || true   # 消费 stdin
case "$NOTIFY_ENABLED" in false|0|off|no) exit 0 ;; esac   # 通知总开关关 → 不提醒
afplay /System/Library/Sounds/Glass.aiff 2>/dev/null || true   # 完成提示音（零依赖，免 terminal-notifier）
exit 0
