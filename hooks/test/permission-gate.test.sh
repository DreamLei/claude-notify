#!/usr/bin/env bash
# permission-gate.sh 集成测试（macOS）。运行：bash hooks/test/permission-gate.test.sh
# 沙箱化：临时 HOME 作 settings.json 落点 + PATH 优先放 mock osascript（按 MOCK_BTN 模拟用户点的按钮），
# 不弹真窗即可覆盖「总是允许」写白名单分支。重点验证两处加固：
#   ① $FIRST 经 tr 净化 → 拼进 allow 手写 JSON 不被破坏（首词含引号也产出合法 JSON）
#   ② mkdir 锁：崩溃残留的陈旧锁(≥10s)被强拆恢复，而他进程刚持有的新鲜锁不被误拆
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
GATE="$REPO/hooks/permission-gate.sh"
PASS=0; FAIL=0
ok(){ echo "  ✔ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "跳过：缺少 jq"; exit 0; }

SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/home/.claude" "$SBX/bin"
S="$SBX/home/.claude/settings.json"
LOCK="$SBX/home/.claude/.pgate.lock"

# mock osascript：吞掉 stdin 脚本，按 MOCK_BTN 模拟点击结果
cat > "$SBX/bin/osascript" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null 2>&1
echo "button returned:${MOCK_BTN:-允许}, gave up:false"
EOF
chmod +x "$SBX/bin/osascript"
export PATH="$SBX/bin:$PATH"

reset_settings(){ echo '{"permissions":{"allow":[]}}' > "$S"; }
run_gate(){ # $1=命令字符串 $2=模拟按钮 → stdout=hook 输出
  printf '%s' "{\"tool_input\":{\"command\":$(jq -Rn --arg c "$1" '$c')}}" \
    | MOCK_BTN="$2" HOME="$SBX/home" bash "$GATE" true 2>/dev/null
}

echo "[1] 首词含引号：allow JSON 合法 + 白名单/settings 不被写坏"
reset_settings
OUT=$(run_gate '"weird cmd" arg' 总是允许)
printf '%s' "$OUT" | jq empty 2>/dev/null && ok "allow 输出是合法 JSON" || no "allow JSON 被破坏：$OUT"
printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision=="allow"' >/dev/null 2>&1 && ok "decision=allow" || no "decision 不对"
jq empty "$S" 2>/dev/null && ok "settings.json 仍合法" || no "settings.json 被写坏"

echo "[2] 陈旧锁(20s)被强拆恢复 → 白名单写入 + 锁释放"
reset_settings; mkdir "$LOCK"
touch -t "$(date -r $(( $(date +%s) - 20 )) +%Y%m%d%H%M.%S)" "$LOCK"
run_gate 'mytool foo' 总是允许 >/dev/null
jq -e '.permissions.allow | index("Bash(mytool *)")' "$S" >/dev/null 2>&1 && ok "强拆陈旧锁后写入白名单" || no "陈旧锁未恢复"
[ ! -d "$LOCK" ] && ok "结束后锁目录已释放" || { no "锁目录残留"; rmdir "$LOCK" 2>/dev/null; }

echo "[3] 新鲜锁不被误拆 → 不写白名单但仍 allow 放行"
reset_settings; mkdir "$LOCK"
OUT=$(run_gate 'othertool bar' 总是允许)
jq -e '.permissions.allow | index("Bash(othertool *)")' "$S" >/dev/null 2>&1 && no "误拆了新鲜锁" || ok "新鲜锁未被误拆"
printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision=="allow"' >/dev/null 2>&1 && ok "抢不到锁仍照常 allow" || no "抢不到锁未放行"
rmdir "$LOCK" 2>/dev/null

echo "[4] 普通「允许」分支不写白名单"
reset_settings
run_gate 'plaincmd zzz' 允许 >/dev/null
[ "$(jq -c '.permissions.allow' "$S")" = "[]" ] && ok "允许分支未动白名单" || no "允许分支误写白名单"

echo "---- PASS=$PASS FAIL=$FAIL ----"
[ "$FAIL" -eq 0 ]
