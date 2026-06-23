#!/usr/bin/env bash
# Stop hook：本轮任务结束的本机通知。装了 terminal-notifier 用桌面横幅，否则回退 afplay 提示音。不推手机。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
cat >/dev/null 2>&1 || true   # 消费 stdin
# 通知总开关：优先脚本入参 NOTIFY_ENABLED（直接调用兼容），否则读插件自动注入的 CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS，默认开。
# 不再在 hooks.json 命令串里内联 ${user_config.*}：那是 bash 参数展开，未被 harness 替换时会 bad substitution 导致整条 hook 失败、脚本根本不跑。
ENABLED="${NOTIFY_ENABLED:-${CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS:-true}}"
# [临时自检] 记录 hook 触发 + 实际开关值；确认横幅恢复后删除本行
echo "$(date '+%F %T') notify-done fired NOTIFY_ENABLED=[$NOTIFY_ENABLED] OPT=[$CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS] ENABLED=[$ENABLED]" >> "$HOME/.claude/.notify-debug.log" 2>/dev/null || true
case "$ENABLED" in false|0|off|no) exit 0 ;; esac   # 通知总开关关 → 不提醒
TN=$(command -v terminal-notifier 2>/dev/null)
ICON="$(cd "$(dirname "$0")/../assets" 2>/dev/null && pwd)/cc-icon.png"   # Claude Code logo（自包含于本插件 assets/）
if [ -n "$TN" ]; then
  "$TN" -title "Claude Code" -subtitle "✅ 完成" -message "本轮任务已结束" -sound Glass -appIcon "$ICON" -contentImage "$ICON" 2>/dev/null || true
else
  afplay /System/Library/Sounds/Glass.aiff 2>/dev/null || true
fi
exit 0
