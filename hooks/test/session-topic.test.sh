#!/usr/bin/env bash
# session-topic.sh 单测：从 transcript 取 ai-title 主题。运行：bash hooks/test/session-topic.test.sh
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
TOPIC="$REPO/hooks/session-topic.sh"
PASS=0; FAIL=0
ok(){ echo "  ✔ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1（实得：「$2」）"; FAIL=$((FAIL+1)); }
command -v jq >/dev/null 2>&1 || { echo "跳过：缺少 jq"; exit 0; }

SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT

echo "[1] 有 ai-title：取到主题；多条取最后一条"
TR="$SBX/a.jsonl"
printf '%s\n' \
  '{"type":"user","message":{"role":"user","content":"hi"}}' \
  '{"type":"ai-title","aiTitle":"旧主题","sessionId":"s"}' \
  '{"type":"assistant","message":{"role":"assistant"}}' \
  '{"type":"ai-title","aiTitle":"检查项目中的缺陷","sessionId":"s"}' > "$TR"
R=$(bash "$TOPIC" "$TR")
[ "$R" = "检查项目中的缺陷" ] && ok "取到最后一条主题" || no "应取末条主题" "$R"

echo "[2] 无 ai-title 记录 → 空串"
TR2="$SBX/b.jsonl"
printf '%s\n' '{"type":"user","message":{"role":"user"}}' '{"type":"assistant"}' > "$TR2"
R=$(bash "$TOPIC" "$TR2")
[ -z "$R" ] && ok "无该记录返回空" || no "应为空" "$R"

echo "[3] 文件不存在 → 空串、不报错"
R=$(bash "$TOPIC" "$SBX/nope.jsonl"); rc=$?
{ [ -z "$R" ] && [ "$rc" = "0" ]; } && ok "缺文件安全返回空" || no "缺文件应空且退出0" "$R rc=$rc"

echo "[4] 无入参 → 空串、不报错"
R=$(bash "$TOPIC"); rc=$?
{ [ -z "$R" ] && [ "$rc" = "0" ]; } && ok "无入参安全返回空" || no "无入参应空且退出0" "$R rc=$rc"

echo "[5] aiTitle 含特殊字符（引号/换行经 jq 还原，作单行输出）"
TR5="$SBX/c.jsonl"
printf '%s\n' '{"type":"ai-title","aiTitle":"修\"权限\"门 bug","sessionId":"s"}' > "$TR5"
R=$(bash "$TOPIC" "$TR5")
[ "$R" = '修"权限"门 bug' ] && ok "特殊字符正确还原" || no "特殊字符还原失败" "$R"

echo "---- PASS=$PASS FAIL=$FAIL ----"
[ "$FAIL" -eq 0 ]
