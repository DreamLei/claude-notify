#!/usr/bin/env bash
# PreToolUse/Bash「全权限弹窗门」：开关开启时，非白名单、非危险的普通命令弹桌面授权窗。
# 开关由 plugin userConfig enable_permission_gate 控制，作为 $1 传入（"true" 开）。
# 危险命令在此避让（交给独立的危险护栏，如个人版 db-guard），不重复弹窗。
# 测试：PGATE_DRYRUN=1。
set -o pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
case "$1" in true|1|on|yes) ;; *) exit 0 ;; esac   # 开关关 → 放行，走正常流程

c=$(jq -r '.tool_input.command // empty')
[ -z "$c" ] && exit 0
S="$HOME/.claude/settings.json"

allow() { printf '%s' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"$1\"}}"; }
deny()  { printf '%s' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$1\"}}"; }

# 命中 settings.json 白名单（Bash(prefix*) 前缀匹配）→ 放行
in_allowlist() {
  local cmd="$1" pat prefix
  while IFS= read -r pat; do
    case "$pat" in Bash\(*\)) prefix="${pat#Bash(}"; prefix="${prefix%)}";; *) continue;; esac
    prefix="${prefix%\*}"; prefix="${prefix%% }"
    [ -z "$prefix" ] && continue
    case "$cmd" in "$prefix"*) return 0;; esac
  done < <(jq -r '.permissions.allow[]?' "$S" 2>/dev/null)
  return 1
}

# 通用危险检测（命中则避让给危险护栏，不在此重复弹窗）
is_dangerous() {
  echo "$1" | grep -qiE 'drop[[:space:]]+(database|schema|table)|truncate[[:space:]]' && return 0
  echo "$1" | grep -qE '(^|[;&|[:space:]])rm[[:space:]]+-[a-zA-Z]*[rR]' && return 0
  echo "$1" | grep -qE 'git[[:space:]]+push[[:space:]].*(--force|[[:space:]]-f([[:space:]]|$))|git[[:space:]]+reset[[:space:]]+--hard|git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f|git[[:space:]]+branch[[:space:]]+-D' && return 0
  return 1
}

in_allowlist "$c" && exit 0       # 白名单 → 放行
is_dangerous "$c" && exit 0       # 危险 → 避让给危险护栏

if [ -n "$PGATE_DRYRUN" ]; then echo "WOULD-PROMPT-GATE"; exit 0; fi

CMD=$(printf '%s' "$c" | tr -d '"\\`$' | cut -c1-200)
FIRST=$(printf '%s' "$c" | sed -E 's/^[[:space:]]+//' | awk '{print $1}')
afplay /System/Library/Sounds/Ping.aiff 2>/dev/null &
R=$(osascript -e "display dialog \"Claude 申请执行命令：\" & return & return & \"$CMD\" buttons {\"拒绝\",\"允许\",\"总是允许\"} default button \"允许\" with title \"权限申请\" with icon note giving up after 60" 2>/dev/null)
case "$R" in
  *总是允许*)   # 把命令首词加入 settings 白名单，以后该类命令自动放行
    if [ -n "$FIRST" ]; then
      jq --arg p "Bash($FIRST *)" '.permissions.allow += (if (.permissions.allow|index($p)) then [] else [$p] end)' "$S" > "/tmp/pgate.$$" 2>/dev/null && jq empty "/tmp/pgate.$$" 2>/dev/null && mv "/tmp/pgate.$$" "$S"
    fi
    allow "用户选择总是允许，已加入白名单 Bash($FIRST *)"
    ;;
  *允许*) allow "用户在权限弹窗中点击允许" ;;
  *)      deny "用户在权限弹窗中拒绝(或超时)" ;;
esac
exit 0
