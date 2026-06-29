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

# mock osascript：吞掉 stdin 脚本，按 MOCK_BTN 模拟点击结果（__GIVEUP__ 模拟超时自动放弃）
cat > "$SBX/bin/osascript" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null 2>&1
[ "$MOCK_BTN" = "__GIVEUP__" ] && { echo "gave up:true"; exit 0; }
echo "button returned:${MOCK_BTN:-允许}, gave up:false"
EOF
chmod +x "$SBX/bin/osascript"
# mock curl：记录每次「真实推送」到 curl.log，供断言推送是否发生
cat > "$SBX/bin/curl" <<EOF
#!/usr/bin/env bash
echo CALLED >> "$SBX/curl.log"
EOF
chmod +x "$SBX/bin/curl"
export PATH="$SBX/bin:$PATH"
# 提供本地 webhook 文件，让 hook 路径的 notify-push 能拿到 URL（hook 无 MCP 注入的 WEBHOOK_URL）
printf 'https://example.invalid/hook\n@all\n' > "$SBX/home/.claude/.notify-webhook"

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

echo "[5] 超时(gave up)推送受「通知总开关」控制（A：用 CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS）"
reset_settings
rm -f "$SBX/curl.log"
run_gate 'cmdEnabled aaa' __GIVEUP__ >/dev/null            # 总开关默认开 → 应推
[ -f "$SBX/curl.log" ] && ok "开关开/缺省时超时推送发生" || no "缺省应推却没推"
rm -f "$SBX/curl.log"
export CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS=false      # export 才能被 run_gate 内层 bash 继承
run_gate 'cmdDisabled bbb' __GIVEUP__ >/dev/null            # 关 → 不推
unset CLAUDE_PLUGIN_OPTION_ENABLE_NOTIFICATIONS
[ ! -f "$SBX/curl.log" ] && ok "关掉通知总开关后超时不推（A 修复生效）" || no "关掉后仍推（A 未生效）"

echo "[6] 白名单前缀须锚定词边界：Bash(git *) 放行「git …」但不放行 gitfoo（#1 修复）"
# 白名单命中→直接 exit 0 空输出放行；未命中→走弹窗产出 JSON。据「输出是否为空」区分两者。
echo '{"permissions":{"allow":["Bash(git *)"]}}' > "$S"
OUT=$(run_gate 'git status' 允许)
[ -z "$OUT" ] && ok "git status 命中白名单、免弹窗放行" || no "git status 未命中（输出：$OUT）"
OUT=$(run_gate 'gitfoo --x' 允许)
[ -n "$OUT" ] && ok "gitfoo 未被 Bash(git *) 越界放行（仍走弹窗）" || no "gitfoo 被越界放行（#1 未生效）"

echo "[7] 项目级 settings.local.json 白名单也被识别（#2 修复）"
echo '{"permissions":{"allow":[]}}' > "$S"             # 全局空
PROJ="$SBX/proj"; mkdir -p "$PROJ/.claude"
echo '{"permissions":{"allow":["Bash(deploy *)"]}}' > "$PROJ/.claude/settings.local.json"
OUT=$(printf '%s' "{\"tool_input\":{\"command\":$(jq -Rn --arg c 'deploy now' '$c')}}" \
  | MOCK_BTN=允许 HOME="$SBX/home" CLAUDE_PROJECT_DIR="$PROJ" bash "$GATE" true 2>/dev/null)
[ -z "$OUT" ] && ok "项目级白名单命中、免弹窗放行" || no "项目级白名单未被识别（输出：$OUT）"

echo "---- PASS=$PASS FAIL=$FAIL ----"
[ "$FAIL" -eq 0 ]
