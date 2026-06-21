#!/usr/bin/env node
'use strict';
// 桌面弹窗提问 MCP server（零依赖，stdio + newline-delimited JSON-RPC）。
// 工具 ask_dialog：弹 macOS 原生窗让用户选择/输入，结果直接回传给模型，无需切回终端。
// 取消/超时/弹窗不可用 → 返回以 __FALLBACK__ 开头的文本，模型据此回退到内置终端提问。

const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const NOTIFY_SH = path.join(__dirname, '..', 'hooks', 'notify-push.sh'); // plugin 内脚本，免硬编码

const ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }; // 强制 UTF-8 防中文乱码

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// 从 osascript 输出里取某字段值，如 "button returned:确定, text returned:hi"
function field(text, prop) {
  const m = text.match(new RegExp(prop + ':([\\s\\S]*?)(?:, [a-z ]+returned:|, gave up:|$)'));
  return m ? m[1].replace(/\s+$/, '') : '';
}

function chime() {
  try { spawn('afplay', ['/System/Library/Sounds/Ping.aiff'], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}
function runOsa(script) { return execFileSync('osascript', ['-e', script], { encoding: 'utf8', env: ENV }); }

// 延时手机推送：弹窗后起一个 sleep N 的子进程，超时未处理才发；用户一处理就 cancelPush() 杀掉它
let pushProc = null;
function schedulePush(afterSec, title, body) {
  try {
    pushProc = spawn('bash', ['-c', 'sleep "$1"; exec bash "$2" "$3" "$4"', 'sh', String(afterSec), NOTIFY_SH, title, body], { detached: true, stdio: 'ignore' });
    pushProc.unref();
  } catch (e) { pushProc = null; }
}
function cancelPush() {
  if (!pushProc) return;
  try { process.kill(-pushProc.pid); } catch (e) {} // 杀整个进程组（含 sleep）
  try { pushProc.kill(); } catch (e) {}
  pushProc = null;
}

const FALLBACK = '__FALLBACK__：用户取消 / 超时 / 弹窗不可用。请改用内置 AskUserQuestion 在终端继续提问（终端交互始终保留为后备）。';
const FALLBACK_NONE = '__FALLBACK__：用户选择了「以上都不对 / 我要补充」。给出的选项均不符合用户意图，请改用内置 AskUserQuestion 在终端继续追问、澄清真实需求（不要重复同一批选项）。';

function askDialog(args) {
  const question = args.question || '请选择';
  const options = Array.isArray(args.options) ? args.options : [];
  const multiple = !!args.multiple;
  const allowText = !!args.allow_text || options.length === 0;
  const timeout = Number(args.timeout) || 600;
  const title = args.title || 'Claude 需要你决定';
  const rec = options.find(o => o && o.recommended);          // AI 推荐项
  const def = args.default_label || (rec ? rec.label : '');   // 推荐项默认高亮/预选
  const NONE = '❌ 以上都不对 / 我要补充（转终端）';
  const allowNone = args.allow_none !== false;                // 默认附加「都不对」逃生口

  chime();
  const pushAfter = (() => { const p = Number(args.push_after) || 300; return p >= timeout ? Math.max(5, Math.floor(timeout * 0.6)) : p; })();
  let pushBody = question; // 手机推送带上完整待确认内容（问题 + 选项 + 推荐）
  if (options.length) pushBody += '\n\n选项：' + options.map((o, i) => `\n${i + 1}. ${o.label}${o.recommended ? '（AI推荐）' : ''}${o.description ? ' — ' + o.description : ''}`).join('');
  else if (allowText) pushBody += '\n\n（需要你输入文本回答）';
  schedulePush(pushAfter, '⏳ 有事待确认', pushBody); // 超过 pushAfter 秒仍未处理才推手机
  const descLines = options.filter(o => o && o.description).map(o => `• ${o.label}${o.recommended ? '（AI 推荐）' : ''}：${o.description}`);
  let promptFull = descLines.length ? `${question}\n\n${descLines.join('\n')}` : question;
  if (rec) promptFull = `💡 AI 推荐：${rec.label}${rec.description ? '（' + rec.description + '）' : ''}\n\n${promptFull}`;

  try {
    if (allowText) {
      const script = `display dialog "${esc(promptFull)}" default answer "${esc(args.default_text || '')}" with title "${esc(title)}" buttons {"取消","确定"} default button "确定" cancel button "取消" with icon note giving up after ${timeout}`;
      const out = runOsa(script);
      if (/gave up:true/.test(out)) return FALLBACK;
      return '用户输入：' + field(out, 'text returned');
    }
    const effOpts = allowNone ? options.concat([{ label: NONE }]) : options.slice();
    if (effOpts.length <= 3 && !multiple) {
      const labels = effOpts.map(o => `"${esc(o.label)}"`).join(',');
      const defBtn = def || (options.length ? options[options.length - 1].label : NONE);
      const script = `display dialog "${esc(promptFull)}" with title "${esc(title)}" buttons {${labels}} default button "${esc(defBtn)}" with icon note giving up after ${timeout}`;
      const out = runOsa(script);
      if (/gave up:true/.test(out)) return FALLBACK;
      const picked = field(out, 'button returned');
      if (picked === NONE) return FALLBACK_NONE;
      return '用户选择：' + picked;
    }
    const labels = effOpts.map(o => `"${esc(o.label)}"`).join(',');
    const multiClause = multiple ? ' with multiple selections allowed' : '';
    const defClause = def ? ` default items {"${esc(def)}"}` : '';
    const script = `choose from list {${labels}} with title "${esc(title)}" with prompt "${esc(promptFull)}"${multiClause}${defClause}`;
    const out = runOsa(script).trim();
    if (out === 'false' || out === '') return FALLBACK; // 用户点了取消
    if (out.split(', ').indexOf(NONE) !== -1) return FALLBACK_NONE; // 选了「都不对」（含多选）
    return '用户选择：' + out;
  } catch (e) {
    return FALLBACK; // osascript 失败 / cancel button 抛错 / 无 GUI
  } finally {
    cancelPush(); // 用户已处理（点了 / 取消 / 超时返回）→ 取消待发的手机推送
  }
}

const TOOL = {
  name: 'ask_dialog',
  description: '弹 macOS 桌面弹窗向用户选择/确认/输入，结果直接返回，使用户无需切回终端。用于方案选择、确认、自由文本回答。返回文本以 __FALLBACK__ 开头时表示用户取消/超时/弹窗不可用，应改用内置终端提问。',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题' },
      options: { type: 'array', description: '可选项；每项 {label, description?, recommended?}。recommended:true 标记 AI 推荐项（自动设为默认高亮/预选并在弹窗顶部显示推荐及理由）。省略 options 则弹文本输入框', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string', description: '该选项说明；推荐项的 description 会作为推荐理由显示' }, recommended: { type: 'boolean', description: '是否为 AI 推荐项' } }, required: ['label'] } },
      multiple: { type: 'boolean', description: '是否允许多选（choose from list）' },
      allow_text: { type: 'boolean', description: '是否弹自由文本输入框' },
      default_text: { type: 'string', description: '文本输入框默认值' },
      default_label: { type: 'string', description: '默认选中/默认按钮的 label' },
      allow_none: { type: 'boolean', description: '是否附加「以上都不对/我要补充」逃生口，默认 true；选中即返回 __FALLBACK__ 回退终端追问' },
      title: { type: 'string', description: '弹窗标题' },
      timeout: { type: 'number', description: '弹窗存活秒数，默认600（10分钟，留足时间让用户回来点）' },
      push_after: { type: 'number', description: '超过该秒数仍未处理才推手机，默认300（5分钟）；用户一处理即取消推送' }
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
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ask-dialog', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  } else if (method === 'tools/call') {
    const p = req.params || {};
    if (p.name === 'ask_dialog') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: askDialog(p.arguments || {}) }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + p.name } });
    }
  } else if (method && method.indexOf('notifications/') === 0) {
    // notification：不回应
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
