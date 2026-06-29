#!/usr/bin/env bash
# 从 transcript(.jsonl)里取本轮会话主题——Claude Code 自动维护的 ai-title 记录，形如
#   {"type":"ai-title","aiTitle":"检查项目中的缺陷","sessionId":"..."}
# 取最后一条(主题会随会话更新)。用法：session-topic.sh <transcript_path> → 单行主题；
# 无入参 / 文件不存在 / 无 jq / 无 ai-title 记录 → 输出空串(调用方据此回退固定文案，绝不让通知失效)。
TR="$1"
[ -n "$TR" ] && [ -f "$TR" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
# 先 grep 粗筛该类型行(快)，再交给 jq 精确取字段；多条取末条。整行经 jq 解析，无注入面。
grep '"type":"ai-title"' "$TR" 2>/dev/null | tail -1 | jq -r '.aiTitle // empty' 2>/dev/null
exit 0
