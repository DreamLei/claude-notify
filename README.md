# claude-notify

让 Claude Code **卡住需要你时一定能通知到**，而且你能就地处理：

- **在终端** → 直接看到提问
- **在电脑、但切到别的窗口** → `ask_dialog` 弹出 macOS 模态窗（浮最上层 + Ping 声），**直接在弹窗里点选/输入，不用切回终端**
- **离开电脑、超过 5 分钟没处理** → @ 你推**企业微信**，消息里写明要确认什么

> 仅 macOS，全部零依赖：弹窗用 osascript、提示音用 afplay、推送用 curl，均系统自带。

---

## 功能

| 能力 | 说明 |
|---|---|
| 桌面弹窗提问（MCP `ask_dialog`）| 选项→按钮/列表、确认→二选一、文本→输入框；结果直接回传，无需回终端 |
| 智能切换 | 你正**看着终端**时不弹窗、直接走终端问答；切到别的 app 才弹桌面窗（`lsappinfo` 检测前台，无需授权）|
| 窗口存活策略 | 默认存活 **1 分钟**；到点时你仍在操作本机则自动**延长到 10 分钟**，否则推手机 |
| AI 推荐项 | 选项标 `recommended` → 自动高亮/预选 + 顶部「💡 AI 推荐」 |
| 「都不对」逃生口 | 每个弹窗自动带「❌ 以上都不对/我要补充」；选中后**直接弹输入框收集补充**，内容回传，免回终端 |
| 全权限弹窗门（`permission-gate`）| 开关 `enable_permission_gate` 开启后，**非白名单、非危险**的普通命令也弹桌面授权窗（允许/拒绝/总是允许），无需回终端；危险命令交由各自危险护栏 |
| 终端后备 | 取消/超时/弹窗不可用 → 返回 `__FALLBACK__`，模型自动回退内置终端提问 |
| 完成/等待提示音 | Stop→完成音(Glass)；Notification→等待音(Ping)。afplay 系统声音，**零依赖**（macOS hook 无 tty/无 app 身份，发不出桌面横幅，故用声音 + 手机推送替代）|
| 手机推送 | 等待超时 → @你推企业微信，**消息含问题+选项+推荐**；**超时才推**（默认 5 分钟）、**冷却去重**（默认 5 分钟内一条）|

---

## 安装（每个团队成员都要做一遍）

### 1. 装 plugin
团队 marketplace 方式（推荐）：
```
/plugin marketplace add git@gitlab.zenlayer.net:dax/claude-notify.git
/plugin install claude-notify@dax-tools
```
本地开发/试用：
```
claude --plugin-dir /path/to/claude-notify
```

### 2. 依赖：无需安装
通知用系统自带 `afplay`、弹窗用 `osascript`、推送用 `curl`、JSON 用 `node`（随 Claude Code 环境，脚本用 `command -v node` 动态查找）。**不再需要 brew 装任何东西。**

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

## 配置

### plugin userConfig（`/plugin configure claude-notify@dax-tools`，或安装时 `--config KEY=VALUE`）
| 配置项 | 默认 | 说明 |
|---|---|---|
| `webhook_url` | 必填（sensitive）| 企业微信群机器人 webhook，存系统钥匙串、不进 git |
| `mention` | `@all` | 通知 @ 对象（`@all` 或手机号）|
| `enable_permission_gate` | `false` | 开启「全权限弹窗门」：非白名单/非危险命令也弹桌面授权 |
| `enable_notifications` | `true` | 通知提醒总开关：关闭后不发「完成/等待」通知与企业微信推送（弹窗提问/授权仍工作）|

### 本地文件 `~/.claude/.notify-webhook`（userConfig 未设时回退）
```
第一行：webhook URL
第二行(可选)：@all  或  手机号(逗号分隔)
```
> webhook 读取优先级：userConfig 环境变量 > 本地文件。

### 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `NOTIFY_COOLDOWN` | 300 | 推送冷却秒数（去重窗口）|
| `NOTIFY_DRYRUN=1` | — | 只打印 payload 不发送（调试）|

`ask_dialog` 参数：`timeout`（初始存活秒数，默认 60）、`timeout_extended`（延长存活，默认 600）、`allow_none`（逃生口，默认开）、选项 `recommended`（标 AI 推荐）等。

---

## 工作机制

**弹窗存活（两段式）**：默认存活 **1 分钟**；到点时检测系统空闲——你仍在操作本机则**延长到 10 分钟**，已离开则推手机 + 返回 `__FALLBACK__`。

**超时才推 + 冷却去重**：只有离开/超时未处理才推企业微信，消息含问题+选项+推荐；`notify-push.sh` 用时间戳做 5 分钟冷却，避免重复轰炸。

**权限门**（`enable_permission_gate` 开）：PreToolUse 拦 Bash——白名单放行、危险命令避让（交危险护栏）、其余弹桌面授权窗（允许/拒绝/总是允许，「总是允许」自动养肥白名单）。

## 安全
- webhook key、手机号只在本地 `~/.claude/.notify-webhook`（权限 600），**不随 plugin/git 分发**（仓库只含 `.example` 模板）
- AppleScript 经 `esc()` 转义、JSON 经 `JSON.stringify`，防注入
