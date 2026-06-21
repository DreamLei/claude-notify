#!/usr/bin/env node
'use strict';
// 桌面弹窗提问 MCP server（零依赖，stdio + newline-delimited JSON-RPC）。
// 工具 ask_dialog：弹 macOS 原生窗让用户选择/输入，结果直接回传给模型，无需切回终端。
// 窗口默认存活 1 分钟；到点时若用户仍在操作本机（系统未空闲）则延长到 10 分钟，
// 否则推手机 + 返回 __FALLBACK__（模型据此回退到内置终端提问）。

const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const NOTIFY_SH = path.join(__dirname, '..', 'hooks', 'notify-push.sh'); // 同包脚本，免硬编码

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
// 系统空闲秒数（HID 键鼠空闲）；查不到当作 0 = 用户在操作（保守倾向延长，不轻易放弃）
function userIdleSec() {
  try {
    const out = execFileSync('sh', ['-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/{print int($NF/1000000000); exit}'"], { encoding: 'utf8', timeout: 3000 });
    return parseInt(out.trim(), 10) || 0;
  } catch (e) { return 0; }
}
// 跑 osascript，最多等 sec 秒（到点 kill 进程关窗）。正常返回 stdout；超时或用户取消则抛错。
function runOsaTimed(script, sec) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', env: ENV, timeout: sec * 1000 });
}
// 立即推手机（不阻塞）
function pushNow(title, body) {
  try { spawn('bash', [NOTIFY_SH, title, body], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}

const FALLBACK = '__FALLBACK__：用户取消 / 超时 / 弹窗不可用。请改用内置 AskUserQuestion 在终端继续提问（终端交互始终保留为后备）。';
const FALLBACK_NONE = '__FALLBACK__：用户选择了「以上都不对 / 我要补充」。给出的选项均不符合用户意图，请改用内置 AskUserQuestion 在终端继续追问、澄清真实需求（不要重复同一批选项）。';

function askDialog(args) {
  const question = args.question || '请选择';
  const options = Array.isArray(args.options) ? args.options : [];
  const multiple = !!args.multiple;
  const allowText = !!args.allow_text || options.length === 0;
  const SHORT = Number(args.timeout) || 60;            // 初始存活：默认 1 分钟
  const LONG = Number(args.timeout_extended) || 600;   // 用户仍在操作则延长到：默认 10 分钟
  const title = args.title || 'Claude 需要你决定';
  const rec = options.find(o => o && o.recommended);
  const def = args.default_label || (rec ? rec.label : '');
  const NONE = '❌ 以上都不对 / 我要补充（转终端）';
  const allowNone = args.allow_none !== false;

  // 手机推送内容：问题 + 选项 + 推荐
  let pushBody = question;
  if (options.length) pushBody += '\n\n选项：' + options.map((o, i) => `\n${i + 1}. ${o.label}${o.recommended ? '（AI推荐）' : ''}${o.description ? ' — ' + o.description : ''}`).join('');
  else if (allowText) pushBody += '\n\n（需要你输入文本回答）';

  const descLines = options.filter(o => o && o.description).map(o => `• ${o.label}${o.recommended ? '（AI 推荐）' : ''}：${o.description}`);
  let promptFull = descLines.length ? `${question}\n\n${descLines.join('\n')}` : question;
  if (rec) promptFull = `💡 AI 推荐：${rec.label}${rec.description ? '（' + rec.description + '）' : ''}\n\n${promptFull}`;

  // 按形态构造脚本 + 结果解析
  let makeScript, parse;
  if (allowText) {
    makeScript = () => `display dialog "${esc(promptFull)}" default answer "${esc(args.default_text || '')}" with title "${esc(title)}" buttons {"取消","确定"} default button "确定" cancel button "取消" with icon note`;
    parse = (out) => '用户输入：' + field(out, 'text returned');
  } else {
    const effOpts = allowNone ? options.concat([{ label: NONE }]) : options.slice();
    if (effOpts.length <= 3 && !multiple) {
      const labels = effOpts.map(o => `"${esc(o.label)}"`).join(',');
      const defBtn = def || (options.length ? options[options.length - 1].label : NONE);
      makeScript = () => `display dialog "${esc(promptFull)}" with title "${esc(title)}" buttons {${labels}} default button "${esc(defBtn)}" with icon note`;
      parse = (out) => { const p = field(out, 'button returned'); return p === NONE ? FALLBACK_NONE : '用户选择：' + p; };
    } else {
      const labels = effOpts.map(o => `"${esc(o.label)}"`).join(',');
      const multiClause = multiple ? ' with multiple selections allowed' : '';
      const defClause = def ? ` default items {"${esc(def)}"}` : '';
      makeScript = () => `choose from list {${labels}} with title "${esc(title)}" with prompt "${esc(promptFull)}"${multiClause}${defClause}`;
      parse = (out) => { out = out.trim(); if (out === 'false' || out === '') return FALLBACK; if (out.split(', ').indexOf(NONE) !== -1) return FALLBACK_NONE; return '用户选择：' + out; };
    }
  }

  chime();
  let result;
  try {
    result = parse(runOsaTimed(makeScript(), SHORT));      // 第一段：存活 SHORT 秒
  } catch (e) {
    if (e && e.status === 1) return FALLBACK;               // display dialog 用户点了取消
    if (userIdleSec() < SHORT) {                            // 用户仍在操作 → 延长
      chime();
      try {
        result = parse(runOsaTimed(makeScript(), LONG));    // 第二段：延长存活
      } catch (e2) {
        if (e2 && e2.status === 1) return FALLBACK;
        pushNow('⏳ 有事待确认', pushBody);
        return FALLBACK;
      }
    } else {
      pushNow('⏳ 有事待确认', pushBody);                    // 用户离开 → 推手机
      return FALLBACK;
    }
  }
  // 选了「以上都不对 / 我要补充」→ 直接弹输入框收集补充，把内容回传，免回终端再问一轮
  if (result === FALLBACK_NONE) {
    try {
      const out = runOsaTimed(`display dialog "请补充说明你的真实需求（直接输入；点取消则回终端继续聊）" default answer "" with title "${esc(title)}" buttons {"取消","提交"} default button "提交" cancel button "取消" with icon note`, LONG);
      const txt = field(out, 'text returned').trim();
      return txt ? '用户补充：' + txt : FALLBACK_NONE;       // 有内容→回传；空→回终端
    } catch (e) { return FALLBACK_NONE; }                    // 取消/超时 → 回终端
  }
  return result;
}

const TOOL = {
  name: 'ask_dialog',
  description: '弹 macOS 桌面弹窗向用户选择/确认/输入，结果直接返回，使用户无需切回终端。用于方案选择、确认、自由文本回答。窗口默认存活 1 分钟，到点时若用户仍在操作本机则延长到 10 分钟。返回文本以 __FALLBACK__ 开头时表示用户取消/超时/弹窗不可用，应改用内置终端提问。',
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
      timeout: { type: 'number', description: '弹窗初始存活秒数，默认60（1分钟）' },
      timeout_extended: { type: 'number', description: '到点时若用户仍在操作本机则延长到的存活秒数，默认600（10分钟）；延长后仍未处理才推手机' }
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
