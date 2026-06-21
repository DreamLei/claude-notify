# claude-notify

让 Claude Code **卡住需要你时一定能通知到**，而且你能就地处理：

- **在终端** → 直接看到提问
- **在电脑、但切到别的窗口** → `ask_dialog` 弹出 macOS 模态窗（浮最上层 + Ping 声），**直接在弹窗里点选/输入，不用切回终端**
- **离开电脑、超过 5 分钟没处理** → @ 你推**企业微信**，消息里写明要确认什么

> 仅 macOS（弹窗依赖 osascript / terminal-notifier）。

---

## 功能

| 能力 | 说明 |
|---|---|
| 桌面弹窗提问（MCP 工具 `ask_dialog`）| 选项→按钮/列表、确认→二选一、文本→输入框，结果直接回传，无需回终端 |
| AI 推荐项 | 选项标 `recommended` → 自动高亮/预选 + 顶部「💡 AI 推荐」 |
| 「都不对」逃生口 | 每个弹窗自动带「❌ 以上都不对/我要补充」，选中即回退终端追问 |
| 终端后备 | 取消/超时/弹窗不可用 → 返回 `__FALLBACK__`，模型自动回退内置终端提问 |
| 完成/等待通知 | Stop→「✅ 完成」；Notification→「⏳ 等待你」（terminal-notifier 横幅）|
| 手机推送 | 等待超时 → @你推企业微信；**超时才推**（默认 5 分钟），**冷却去重**（默认 5 分钟内只推一条）|

---

## 安装（每个团队成员都要做一遍）

### 1. 装 plugin
团队 marketplace 方式（推荐）：
```
/plugin marketplace add <你们组织/claude-notify 仓库>
/plugin install claude-notify@<marketplace 名>
```
本地开发/试用：
```
claude --plugin-dir /path/to/claude-notify
```

### 2. 装依赖（一次）
```
brew install terminal-notifier
```
（node 一般随 Claude Code 环境已具备；脚本用 `command -v node` 动态查找。）

### 3. 建你自己的企业微信群机器人 ⭐
**每人配自己的群，`@all` 就只 @ 到自己、互不打扰：**
1. 企业微信里建一个群（只有你自己也行）
2. 群设置 → 群机器人 → 添加 → 复制 **Webhook 地址**

### 4. 填配置（三选一，密钥都不进 git）
- **方式 A（推荐）**：启用 plugin 时 Claude Code 会**弹框提示你填 webhook**（标了 `sensitive`，存进系统钥匙串，不进任何文件/仓库）。
- **方式 B**：会话里运行 **`/notify-setup`**，我引导你填 + 自动发一条自测推送。
- **方式 C（手动）**：
  ```
  cp .notify-webhook.example ~/.claude/.notify-webhook
  chmod 600 ~/.claude/.notify-webhook
  # 编辑：第一行 webhook URL，第二行 @all
  ```

> 读取优先级：userConfig 环境变量（方式 A）> 本地文件（方式 B/C）。

### 5. 重启会话验证
- `ask_dialog` 工具在新会话才加载；`claude mcp list` 应显示 `ask-dialog ✔ Connected`
- 测推送：`bash ~/.claude/.../hooks/notify-push.sh "测试" "通路确认"`（企业微信应 @你收到）

---

## 配置 `~/.claude/.notify-webhook`
```
第一行：webhook URL
第二行(可选)：@all  或  手机号(逗号分隔)
```

## 可调环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `NOTIFY_COOLDOWN` | 300 | 推送冷却秒数（去重窗口）|
| `NOTIFY_DRYRUN=1` | — | 只打印 payload 不发送（调试）|

`ask_dialog` 参数：`push_after`（超时推送秒数，默认 300）、`timeout`（弹窗存活，默认 600）、`allow_none`（逃生口，默认开）等。

---

## 工作机制（超时才推 + 冷却去重）
1. `ask_dialog` 弹窗的同时，后台起一个 `sleep push_after` 的子进程
2. 你在该时间内处理了（点选/取消/输入）→ 立即 kill 子进程，**手机不响**
3. 超时仍没动 → 才推企业微信；`notify-push.sh` 再用时间戳做 5 分钟冷却，**避免重复轰炸**

## 安全
- webhook key、手机号只在本地 `~/.claude/.notify-webhook`（权限 600），**不随 plugin/git 分发**（仓库只含 `.example` 模板）
- AppleScript 经 `esc()` 转义、JSON 经 `JSON.stringify`，防注入
