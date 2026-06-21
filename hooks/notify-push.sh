#!/usr/bin/env bash
# 推送到企业微信/钉钉群机器人，带冷却去重 + @指定人。
# 配置 ~/.claude/.notify-webhook（每人本地填自己的，不随 plugin/git 分发）：
#   第一行：webhook URL
#   第二行(可选)：要 @ 的手机号，逗号分隔；或填 @all（在你自己的群里即 @你本人）
# 用法：notify-push.sh "标题" "内容"
# 冷却：默认 300s(5分钟) 内只推一条，避免重复轰炸（NOTIFY_COOLDOWN 覆盖）。
# 测试：NOTIFY_DRYRUN=1 只打印 payload、不发送、不计冷却。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
NODE=$(command -v node 2>/dev/null || echo node)   # 动态定位 node，免硬编码（兼容 Intel/Apple Silicon）
# 优先用 plugin userConfig 注入的环境变量（WEBHOOK_URL/MENTION）；否则回退本地文件
URL="$WEBHOOK_URL"
MOBILES="$MENTION"
if [ -z "$URL" ]; then
  CONF="$HOME/.claude/.notify-webhook"
  [ -f "$CONF" ] || exit 0
  URL=$(grep -m1 '^http' "$CONF" 2>/dev/null)
  MOBILES=$(grep -v '^http' "$CONF" 2>/dev/null | grep -m1 -E '@all|[0-9]{6,}')
fi
[ -z "$URL" ] && exit 0

TITLE="${1:-提醒}"
BODY="${2:-}"
# 开头带「Claude Code」可同时充当钉钉自定义机器人的关键词
TEXT="【Claude Code】${TITLE}
${BODY}"
CONTENT=$("$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$TEXT" 2>/dev/null)
[ -z "$CONTENT" ] && exit 0

MENTION=""
[ -n "$MOBILES" ] && MENTION=$("$NODE" -e 'const a=process.argv[1].split(",").map(s=>s.trim()).filter(Boolean); process.stdout.write(JSON.stringify(a))' "$MOBILES" 2>/dev/null)
if [ -n "$MENTION" ] && [ "$MENTION" != "[]" ]; then
  PAYLOAD="{\"msgtype\":\"text\",\"text\":{\"content\":$CONTENT,\"mentioned_mobile_list\":$MENTION}}"
else
  PAYLOAD="{\"msgtype\":\"text\",\"text\":{\"content\":$CONTENT}}"
fi

if [ -n "$NOTIFY_DRYRUN" ]; then echo "WOULD-PUSH payload=$PAYLOAD"; exit 0; fi

# 冷却去重：默认 300s 内只推一条，后续重复的直接跳过
COOLDOWN=${NOTIFY_COOLDOWN:-300}
STAMP="$HOME/.claude/.notify-last"
now=$(date +%s)
if [ -f "$STAMP" ]; then
  last=$(cat "$STAMP" 2>/dev/null)
  case "$last" in *[!0-9]*|'') last=0 ;; esac
  [ $((now - last)) -lt "$COOLDOWN" ] && exit 0
fi
echo "$now" > "$STAMP"

curl -s -m 8 -H 'Content-Type: application/json' -d "$PAYLOAD" "$URL" >/dev/null 2>&1 || true
exit 0
