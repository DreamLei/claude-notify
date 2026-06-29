#!/usr/bin/env bash
# PreToolUse/Bash「全权限弹窗门」：开关开启时，非白名单、非危险的普通命令弹桌面授权窗。
# 开关由 plugin userConfig enable_permission_gate 控制，作为 $1 传入（"true" 开）。
# 危险命令在此避让（交给独立的危险护栏，如个人版 db-guard），不重复弹窗。
# 测试：PGATE_DRYRUN=1。
set -o pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
case "$1" in true|1|on|yes) ;; *) exit 0 ;; esac   # 开关关 → 放行，走正常流程
command -v jq >/dev/null 2>&1 || { echo "permission-gate: 缺少 jq，权限门无法解析命令、无法拦截，请安装 jq" >&2; exit 0; }   # 缺 jq → 告警(不静默吞)

IN=$(cat)   # stdin 只能读一次，先整段读入再多字段解析（permission_mode + command）
# --dangerously-skip-permissions（permission_mode=bypassPermissions）= 用户已全权放行，不再弹权限窗
case "$(printf '%s' "$IN" | jq -r '.permission_mode // empty')" in bypassPermissions) exit 0 ;; esac

c=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty')
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
  echo "$1" | grep -qE '(^|[;&|[:space:]])rm[[:space:]].*(--recursive|--force|--no-preserve-root)' && return 0
  echo "$1" | grep -qE 'git[[:space:]]+push[[:space:]].*(--force|[[:space:]]-f([[:space:]]|$))|git[[:space:]]+reset[[:space:]]+--hard|git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f|git[[:space:]]+branch[[:space:]]+-D' && return 0
  return 1
}

is_dangerous "$c" && exit 0       # 危险命令永远先判 → 避让给危险护栏(防白名单泛化前缀放行危险变体)
in_allowlist "$c" && exit 0       # 白名单 → 放行

if [ -n "$PGATE_DRYRUN" ]; then echo "WOULD-PROMPT-GATE"; exit 0; fi

CMD=$(printf '%s' "$c" | tr -d '"\\`$' | cut -c1-200)
FIRST=$(printf '%s' "$c" | sed -E 's/^[[:space:]]+//' | awk '{print $1}' | tr -d '"\\`$')   # 同 CMD 剔除引号/反斜杠/反引号/$：FIRST 会拼进 allow 的手写 JSON，防破坏
ICON="$(cd "$(dirname "$0")/../assets" 2>/dev/null && pwd)/cc-icon.icns"   # Claude Code logo（自包含于本插件 assets/）
afplay /System/Library/Sounds/Ping.aiff 2>/dev/null &
# display dialog 三按钮(还原)；原生 giving up after 实现超时，gave up 标志区分超时与点按钮：
#   · gave up:true = 超时自动关 → 推手机 + 回终端
#   · 点 拒绝/允许/总是允许 → 对应 deny/allow/白名单（三按钮已占满，无单独「取消」按钮位）
# 命令文本/图标/超时全部经 argv 传入 osascript，绝不插值进脚本源码 → 杜绝 AppleScript 注入(含换行)。
R=$(osascript - "$CMD" "$ICON" "${PGATE_TIMEOUT:-60}" 2>/dev/null <<'APPLESCRIPT'
on run argv
  set cmdText to item 1 of argv
  set iconPath to item 2 of argv
  set giveUp to (item 3 of argv) as integer
  display dialog "Claude 申请执行命令：" & return & return & cmdText buttons {"拒绝", "允许", "总是允许"} default button "允许" with title "权限申请" with icon (POSIX file iconPath) giving up after giveUp
end run
APPLESCRIPT
)
case "$R" in
  *"gave up:true"*)   # 超时自动放弃 → 推手机 + 回终端
    # 通知总开关：hook 拿到的是 CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS（非 MCP 的 NOTIFY_ENABLED），与 notify-done/notify-wait 一致用 fallback 链。
    ENABLED="${NOTIFY_ENABLED:-${CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS:-true}}"
    case "$ENABLED" in false|0|off|no) ;; *) bash "$(cd "$(dirname "$0")" && pwd)/notify-push.sh" "⏳ 权限申请待确认" "$CMD" >/dev/null 2>&1 ;; esac
    exit 0 ;;
  *总是允许*)   # 把命令首词加入 settings 白名单，以后该类命令自动放行
    if [ -n "$FIRST" ]; then
      # 原子写：临时文件与 $S 同目录(同卷 mv 原子) + mkdir 原子锁(macOS 无 flock)防并发覆盖。
      # 拿不到锁/写失败都跳过写白名单，但下面照常 allow 放行，不影响用户。
      DIR=$(dirname "$S"); TMP="$DIR/.pgate.$$"; LOCK="$DIR/.pgate.lock"
      i=0
      while [ "$i" -lt 10 ]; do
        if mkdir "$LOCK" 2>/dev/null; then
          jq --arg p "Bash($FIRST *)" '.permissions.allow += (if (.permissions.allow|index($p)) then [] else [$p] end)' "$S" > "$TMP" 2>/dev/null && jq empty "$TMP" 2>/dev/null && mv "$TMP" "$S"
          rm -f "$TMP" 2>/dev/null
          rmdir "$LOCK" 2>/dev/null
          break
        fi
        # 抢锁失败：临界区只有亚秒级的 jq+mv，锁目录若已 ≥10s 必是进程被杀的崩溃残留 → 强拆，下一轮重抢。
        LMT=$(stat -f %m "$LOCK" 2>/dev/null)
        [ -n "$LMT" ] && [ $(( $(date +%s) - LMT )) -ge 10 ] && rmdir "$LOCK" 2>/dev/null
        i=$((i + 1)); sleep 0.2
      done
    fi
    allow "用户选择总是允许，已加入白名单 Bash($FIRST *)"
    ;;
  *拒绝*) deny "用户在权限弹窗中点击拒绝" ;;
  *允许*) allow "用户在权限弹窗中点击允许" ;;
  *)      exit 0 ;;   # 兜底(未匹配)→ 回终端
esac
exit 0
