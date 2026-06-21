#!/usr/bin/env bash
# Notification hook：Claude 等待用户输入时只响本机提示音。
# 不推手机——避免每次 idle 等待都推企业微信造成轰炸；
# 手机推送只由 ask_dialog 弹窗「超时未处理」精准触发（见 ask-dialog-server.js）。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
cat >/dev/null 2>&1 || true   # 消费 stdin
case "$NOTIFY_ENABLED" in false|0|off|no) exit 0 ;; esac   # 通知总开关关 → 不提醒
afplay /System/Library/Sounds/Ping.aiff 2>/dev/null || true
exit 0
