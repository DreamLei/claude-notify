#!/usr/bin/env bash
# UserPromptSubmit：每次用户在终端提交输入就刷新时间戳，供 ask_dialog 延迟推送判定"用户是否已回来在终端答话"。
# 弹窗超时关闭后那 5 分钟里若此时间戳被刷新（晚于弹窗关闭时刻），则免推企业微信。
# 不产出任何内容（不给模型注入额外上下文），排空 stdin 后即退。
date +%s > "$HOME/.claude/.last-user-prompt" 2>/dev/null || true
cat >/dev/null 2>&1 || true
exit 0
