#!/usr/bin/env node
'use strict';
// 桌面弹窗提问 MCP server（零依赖，stdio + newline-delimited JSON-RPC）。
// 工具 ask_dialog：弹 macOS 原生窗让用户选择/输入。窗口与「本机侧通道」并存：
//   · 桌面弹窗（本机）作答    —— 用户在弹窗里点选/输入
//   · Codex 经 Unix socket 中转某一轮答案 —— 见 answer-dialog.js
// 任一侧首个有效答案立即结算该轮，MCP 主动关闭/失效另一侧；后到答案不覆盖首答，返回 already_answered。
// 弹窗异步 spawn（不再 execFileSync 阻塞事件循环），故 socket 在弹窗等待期间仍能收 Codex 答案。
// 窗口固定存活 2 分钟；到点未处理则关窗 + 返回 __FALLBACK__（模型据此回退到内置终端提问），
// 关闭后再等 5 分钟，期间用户在终端回过话则免推，否则把堆积的多条问题合并成一条推出去。

const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DialogHub, buildChoiceJxa, buildTextJxa } = require('./dialog-hub');

const NOTIFY_SH = path.join(__dirname, '..', 'hooks', 'notify-push.sh');
const ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

// 立即推手机（不阻塞）；通知总开关关闭、或企业微信推送被单独关闭则不推
function pushNow(title, body) {
  if (/^(false|0|off|no)$/i.test(process.env.NOTIFY_ENABLED || '')) return;
  if (/^(false|0|off|no)$/i.test(process.env.WECHAT_PUSH_ENABLED || '')) return;
  try { spawn('bash', [NOTIFY_SH, title, body], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}

// —— 延迟合并推送（与原实现一致）——
const LAST_PROMPT_PATH = path.join(os.homedir(), '.claude', '.last-user-prompt');
const DEFER_MS = Number(process.env.ASK_DIALOG_DEFER_MS)
  || (Number(process.env.ASK_DIALOG_DEFER_MIN) ? Number(process.env.ASK_DIALOG_DEFER_MIN) * 60000 : 0)
  || 5 * 60 * 1000;
let pending = [];
let flushTimer = null;
function nowSec() { return Math.floor(Date.now() / 1000); }
function readLastPromptSec() {
  try { return parseInt(fs.readFileSync(LAST_PROMPT_PATH, 'utf8').trim(), 10) || 0; } catch (e) { return 0; }
}
function scheduleDeferredPush(question) {
  pending.push({ ts: nowSec(), q: question });
  if (!flushTimer) flushTimer = setTimeout(flushPending, DEFER_MS);
}
function flushPending() {
  flushTimer = null;
  const items = pending; pending = [];
  if (!items.length) return;
  const earliest = items.reduce((m, i) => Math.min(m, i.ts), Infinity);
  if (readLastPromptSec() > earliest) return;
  if (items.length === 1) { pushNow('⏳ 有事待确认', items[0].q); return; }
  pushNow(`⏳ ${items.length} 条待确认`, items.map((it, i) => `【${i + 1}】${it.q}`).join('\n\n———\n\n'));
}

// 异步跑一条命令，resolve 其 stdout（出错/超时 → 空串）。不经 shell（无 sh -c），参数数组传入，无注入面。
function runCmd(cmd, cmdArgs, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, cmdArgs, { env: ENV }); } catch (e) { return resolve(''); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(''); }, timeoutMs || 2000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// 当前前台 app 名（lsappinfo，无需辅助功能权限）：先取前台 ASN，再查其显示名。两段异步子进程，不用 sh。
async function frontApp() {
  const asn = (await runCmd('lsappinfo', ['front'])).trim();
  if (!asn) return '';
  const info = await runCmd('lsappinfo', ['info', '-only', 'name', asn]);
  const m = info.match(/"LSDisplayName"="([^"]*)"/);
  return m ? m[1] : '';
}
async function inHostApp() {
  const name = await frontApp();
  return /iterm|terminal|ghostty|wezterm|warp|alacritty|kitty|hyper|tabby|rio|konsole|wave|jetbrains|intellij|pycharm|webstorm|goland|datagrip|rubymine|phpstorm|clion|rider|android studio|fleet|cursor|\bcode\b|claude/i.test(name);
}
async function smartSwitchActive() {
  if (!/^(1|true|on|yes)$/i.test(process.env.SMART_SWITCH || '')) return false;
  return inHostApp();
}

const hub = new DialogHub({
  pushDeferred: scheduleDeferredPush,
  smartSwitch: smartSwitchActive,
  env: ENV,
  socketPath: process.env.ASK_DIALOG_SOCKET || undefined,   // 可选覆盖（隔离测试 / 多实例）；默认按 pid 隔离 ~/.claude/.ask-dialog.<pid>.sock
  registryPath: process.env.ASK_DIALOG_REGISTRY_DIR ? path.join(process.env.ASK_DIALOG_REGISTRY_DIR, process.pid + '.json') : undefined,
  defaultTimeoutSec: Number(process.env.ASK_DIALOG_TIMEOUT_SEC) || 120
});

const TOOL = {
  name: 'ask_dialog',
  description: '弹 macOS 桌面弹窗向用户选择/确认/输入，结果直接返回，使用户无需切回终端。桌面弹窗与终端/Codex 侧通道并存：任一侧首个有效答案立即结算该轮，另一侧自动失效。用于方案选择、确认、自由文本回答。窗口固定存活 2 分钟，到点未处理则关窗回退终端（关闭后再等 5 分钟，期间用户在终端回过话则免推，否则合并推手机）。返回文本以 __FALLBACK__ 开头时表示用户取消/超时/弹窗不可用，应改用内置终端提问；成功返回带「（来源：电脑本机|Codex中转）」标注。',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题' },
      options: { type: 'array', description: '可选项；每项 {label, description?, recommended?}。recommended:true 标记 AI 推荐项（自动设为默认高亮/预选并在弹窗顶部显示推荐及理由）。省略 options 则弹文本输入框', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string', description: '该选项说明；推荐项的 description 会作为推荐理由显示' }, recommended: { type: 'boolean', description: '是否为 AI 推荐项' } }, required: ['label'] } },
      multiple: { type: 'boolean', description: '是否允许多选。true=复选框可勾多项；false/省略=radio 单选框（自动互斥）。两种形态都会在末尾附「其他：」选项+输入框' },
      allow_text: { type: 'boolean', description: '要不要自由文本输入。无 options 时=弹纯文本输入框；有 options 时=在选项末尾强制附输入框（实现「选一个 或 自填」，即便 allow_none:false 也保留输入框）。不影响纯选项形态' },
      default_text: { type: 'string', description: '文本输入框默认值' },
      default_label: { type: 'string', description: '默认选中/默认按钮的 label' },
      allow_none: { type: 'boolean', description: '默认 true：在选项末尾附「其他：」选项+输入框（与预设同组互斥），用户可就地输入自定义内容并直接回传（不回终端）；false=不显示该项' },
      title: { type: 'string', description: '弹窗标题' },
      timeout: { type: 'number', description: '本次弹窗存活秒数（不传则用插件配置的默认值，默认120=2分钟）；到点仍未处理则关窗回退终端 + 延迟推手机' }
    },
    required: ['question']
  }
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  const { id, method } = req;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ask-dialog', version: '2.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  } else if (method === 'tools/call') {
    const p = req.params || {};
    if (p.name === 'ask_dialog') {
      // 异步：弹窗与 socket 侧通道并行竞速，谁先给出有效答案谁赢；期间事件循环不被阻塞。
      hub.ask(p.arguments || {})
        .then((text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }))
        .catch((e) => send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'ask_dialog failed: ' + (e && e.message || e) } }));
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + p.name } });
    }
  } else if (method && method.indexOf('notifications/') === 0) {
    // notification：不回应
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});

// 启动本机侧通道 socket（失败不致命：退化为仅桌面弹窗，行为同旧版）。
hub.start().catch((e) => { try { process.stderr.write('ask-dialog socket 启动失败：' + (e && e.message || e) + '\n'); } catch (_) {} });

// 进程退出时收尾：关窗 + 清 socket/注册表/锁。
function cleanup() { try { hub.stop(); } catch (e) {} }
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

// 供测试 require（被 node 直接当 MCP server 跑时无副作用）
module.exports = { hub, buildChoiceJxa, buildTextJxa, askDialog: (args) => hub.ask(args) };
