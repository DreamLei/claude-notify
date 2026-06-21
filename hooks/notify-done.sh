#!/usr/bin/env bash
# Stop hook：本轮任务结束的本机桌面通知（完成不推手机，避免每轮骚扰）。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
cat >/dev/null 2>&1 || true   # 消费 stdin
TN=$(command -v terminal-notifier 2>/dev/null)
[ -n "$TN" ] && "$TN" -title "Claude Code" -subtitle "✅ 完成" -message "本轮任务已结束" -sound Glass 2>/dev/null || true
exit 0
