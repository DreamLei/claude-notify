#!/usr/bin/env bash
# notify-push.sh / notify-wait.sh 集成测试（macOS）。运行：bash hooks/test/notify.test.sh
# 沙箱：临时 HOME + PATH 优先放 mock curl/afplay/terminal-notifier，按「标记文件是否出现」断言是否真的推送/提醒。
# 覆盖：
#   B 企业微信开关对所有调用方生效（hook 名 CLAUDE_PLUGIN_OPTION_ENABLE_WECHAT_PUSH 也认）
#   C notify-wait 跨会话判活跃（单锁被别会话误删时，仍能据 registry 目录抑制重复横幅）
#   D notify-push 冷却按内容分桶（不同告警不互相挤掉）
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PUSH="$REPO/hooks/notify-push.sh"
WAIT="$REPO/hooks/notify-wait.sh"
PASS=0; FAIL=0
ok(){ echo "  ✔ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
command -v node >/dev/null 2>&1 || { echo "跳过：缺少 node"; exit 0; }

SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/home/.claude" "$SBX/bin"
printf 'https://example.invalid/hook\n@all\n' > "$SBX/home/.claude/.notify-webhook"

# mock：curl 记一行到 push.log；afplay / terminal-notifier 记一行到 notify.log
cat > "$SBX/bin/curl" <<EOF
#!/usr/bin/env bash
echo CALLED >> "$SBX/push.log"
EOF
cat > "$SBX/bin/afplay" <<EOF
#!/usr/bin/env bash
echo PLAYED >> "$SBX/notify.log"
EOF
cat > "$SBX/bin/terminal-notifier" <<EOF
#!/usr/bin/env bash
echo BANNER >> "$SBX/notify.log"
EOF
chmod +x "$SBX/bin/"*
export PATH="$SBX/bin:$PATH"

push(){ HOME="$SBX/home" bash "$PUSH" "$@" >/dev/null 2>&1; }
do_wait(){ printf '{"message":"x"}' | HOME="$SBX/home" bash "$WAIT" >/dev/null 2>&1; }

echo "[B] 企业微信开关：hook 名(CLAUDE_PLUGIN_OPTION_ENABLE_WECHAT_PUSH) 也能关停"
rm -f "$SBX/push.log"
( export CLAUDE_PLUGIN_OPTION_ENABLE_WECHAT_PUSH=false; push "标题1" "正文1" )
[ ! -f "$SBX/push.log" ] && ok "hook 名=false 时不推（B 修复生效）" || no "hook 名=false 仍推"
rm -f "$SBX/push.log"
push "标题2" "正文2"            # 两个开关都没设 → 默认 true → 推
[ -f "$SBX/push.log" ] && ok "缺省时正常推" || no "缺省却没推"
rm -f "$SBX/push.log"
( export WECHAT_PUSH_ENABLED=off; push "标题3" "正文3" )   # MCP 名仍认
[ ! -f "$SBX/push.log" ] && ok "MCP 名=off 时不推（旧行为保留）" || no "MCP 名=off 仍推"

echo "[D] 冷却按内容分桶：同内容压制、异内容放行"
rm -f "$SBX/push.log" "$SBX"/home/.claude/.notify-last.*
export NOTIFY_COOLDOWN=300
push "同标题" "同正文"; push "同标题" "同正文"   # 第二条同内容应被冷却
n=$( [ -f "$SBX/push.log" ] && wc -l < "$SBX/push.log" | tr -d ' ' || echo 0 )
[ "$n" = "1" ] && ok "同内容 300s 内只推一次（去重）" || no "同内容去重失效（推了 $n 次）"
push "另一告警" "另一正文"                       # 不同内容不应被上一条挤掉
n=$( wc -l < "$SBX/push.log" | tr -d ' ' )
[ "$n" = "2" ] && ok "不同告警不被挤掉（D 修复生效）" || no "不同告警被冷却挤掉（共推 $n 次）"
unset NOTIFY_COOLDOWN

echo "[C] notify-wait 跨会话判活跃：单锁缺失但 registry 有活跃弹窗 → 抑制横幅"
REG="$SBX/home/.claude/.ask-dialog-registry"; mkdir -p "$REG"
rm -f "$SBX/home/.claude/.ask-dialog-active"   # 模拟锁被别的会话关窗时误删
# C1：registry 有非空 dialogs → 应抑制（无 notify 标记）
printf '{"pid":1,"socket":"x","dialogs":[{"dialog_id":"d1","question":"q","started":1}]}' > "$REG/1.json"
rm -f "$SBX/notify.log"; do_wait
[ ! -f "$SBX/notify.log" ] && ok "registry 有活跃弹窗 → 抑制重复横幅（C 修复生效）" || no "未抑制，重复弹了横幅"
# C2：registry dialogs 为空 → 不算活跃 → 应正常提醒
printf '{"pid":1,"socket":"x","dialogs":[]}' > "$REG/1.json"
rm -f "$SBX/notify.log"; do_wait
[ -f "$SBX/notify.log" ] && ok "registry 无活跃弹窗 → 正常提醒" || no "空 registry 误判为活跃、漏提醒"

echo "---- PASS=$PASS FAIL=$FAIL ----"
[ "$FAIL" -eq 0 ]
