#!/usr/bin/env node
'use strict';
// 桌面弹窗提问 MCP server（零依赖，stdio + newline-delimited JSON-RPC）。
// 工具 ask_dialog：弹 macOS 原生窗让用户选择/输入，结果直接回传给模型，无需切回终端。
// 窗口固定存活 2 分钟；到点未处理则关窗 + 返回 __FALLBACK__（模型据此回退到内置终端提问）。
// 关闭后不立刻推手机：再等 5 分钟，期间用户若在终端回过话则免推，否则把堆积的多条问题合并成一条推出去。

const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const NOTIFY_SH = path.join(__dirname, '..', 'hooks', 'notify-push.sh'); // 同包脚本，免硬编码
// 弹窗活跃锁：提问框存活期间写本文件，notify-wait.sh 检测到即跳过「⏳ 等待你」横幅，避免双弹。
const LOCK_PATH = path.join(os.homedir(), '.claude', '.ask-dialog-active');
function writeLock() { try { fs.writeFileSync(LOCK_PATH, String(Math.floor(Date.now() / 1000))); } catch (e) {} }
function clearLock() { try { fs.unlinkSync(LOCK_PATH); } catch (e) {} }

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
// 跑 osascript，最多等 sec 秒（到点 kill 进程关窗）。正常返回 stdout；超时或用户取消则抛错。
// lang='js' 走 JavaScript for Automation（JXA），否则默认 AppleScript。
function runOsaTimed(script, sec, lang) {
  const cliArgs = lang === 'js' ? ['-l', 'JavaScript', '-e', script] : ['-e', script];
  return execFileSync('osascript', cliArgs, { encoding: 'utf8', env: ENV, timeout: sec * 1000 });
}

// 构造 JXA 选择弹窗脚本：真原生勾选框（multiple→复选框 / 否则→radio 自动互斥）。
// allowSupp 时追加一项「其他：」选项 + 紧邻输入框，与预设选项同组互斥——补充本身即一个选项，
// 用户选「其他」并填框即可就地回传自定义内容（不回终端）。零外部依赖，仅用 macOS 自带 Cocoa 桥。
// 入参经 JSON.stringify 注入天然安全转义；回传 JSON {selected:[],other:bool,supplement:""} 或 "__CANCEL__"。
function buildChoiceJxa(d) {
  return [
    "ObjC.import('Cocoa');",
    'var D = ' + JSON.stringify(d) + ';',
    'var W = 460, ROW = 26, PAD = 8, FIELDH = 24, OW = 70;',
    'var n = D.items.length;',
    'var rows = n + (D.allowSupp ? 1 : 0);',
    'var H = ROW * rows + PAD * 2;',
    'var view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));',
    'var boxes = [];',
    'for (var i = 0; i < n; i++) {',
    '  var lab = D.items[i];',
    '  var y = H - PAD - ROW * (i + 1);',
    '  var btn = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, y, W, ROW));',
    '  btn.setButtonType(D.multiple ? 3 : 4);',
    "  if (!D.multiple) btn.setAction($.NSSelectorFromString('radioHit:'));",
    '  btn.title = lab;',
    '  if (D.defaults.indexOf(lab) !== -1) btn.state = 1;',
    '  view.addSubview(btn);',
    '  boxes.push(btn);',
    '}',
    'var otherBtn = null, field = null;',
    'if (D.allowSupp) {',
    '  otherBtn = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, PAD, OW, ROW));',
    '  otherBtn.setButtonType(D.multiple ? 3 : 4);',
    "  if (!D.multiple) otherBtn.setAction($.NSSelectorFromString('radioHit:'));",
    '  otherBtn.title = D.otherLabel;',
    '  view.addSubview(otherBtn);',
    '  field = $.NSTextField.alloc.initWithFrame($.NSMakeRect(OW + 4, PAD + 1, W - OW - 4, FIELDH));',
    '  field.setPlaceholderString(D.suppPlaceholder);',
    '  view.addSubview(field);',
    '}',
    'var alert = $.NSAlert.alloc.init;',
    'alert.messageText = D.title;',
    'alert.informativeText = D.prompt;',
    "alert.addButtonWithTitle('确定');",
    "alert.addButtonWithTitle('取消');",
    'alert.accessoryView = view;',
    'alert.window.setLevel(3);',
    'if (field) alert.window.setInitialFirstResponder(field);', // 文本框初始获得键盘焦点
    '$.NSApp.setActivationPolicy(0);',                           // Regular app → 才能接收键盘输入
    '$.NSApp.activateIgnoringOtherApps(true);',
    'var resp = alert.runModal;',
    "var note = field ? ObjC.unwrap(field.stringValue).trim() : '';", // 框内容（确定/取消都读取）
    'var out;',
    "if (resp.toString() === '1000') {",
    '  var sel = [];',
    '  for (var j = 0; j < boxes.length; j++) { if (Number(boxes[j].state) > 0) sel.push(ObjC.unwrap(boxes[j].title)); }',
    '  var other = otherBtn ? (Number(otherBtn.state) > 0) : false;',
    "  out = JSON.stringify({ action: 'ok', selected: sel, other: other, supplement: note });",
    "} else { out = JSON.stringify({ action: 'cancel', supplement: note }); }", // 取消也带回框里的说明
    'out;'
  ].join('\n');
}
// 立即推手机（不阻塞）；通知总开关关闭、或企业微信推送被单独关闭则不推
function pushNow(title, body) {
  if (/^(false|0|off|no)$/i.test(process.env.NOTIFY_ENABLED || '')) return;
  if (/^(false|0|off|no)$/i.test(process.env.WECHAT_PUSH_ENABLED || '')) return;
  try { spawn('bash', [NOTIFY_SH, title, body], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}

// —— 延迟合并推送 ——
// 弹窗超时自动关闭后不立刻推：攒进队列，自首条起 +5 分钟统一判定。
// 这 5 分钟里用户若在终端提交过输入（UserPromptSubmit hook 刷新 LAST_PROMPT_PATH）= 已回来答话 → 全部免推；
// 否则把窗口内堆积的多条问题合并成一条企业微信推出去（进程常驻，直接用 in-process 定时器）。
const LAST_PROMPT_PATH = path.join(os.homedir(), '.claude', '.last-user-prompt');
// 关闭后延迟时长：优先 ASK_DIALOG_DEFER_MS（毫秒，便于测试细调）→ 其次 ASK_DIALOG_DEFER_MIN（分钟，插件配置注入）→ 默认 5 分钟
const DEFER_MS = Number(process.env.ASK_DIALOG_DEFER_MS)
  || (Number(process.env.ASK_DIALOG_DEFER_MIN) ? Number(process.env.ASK_DIALOG_DEFER_MIN) * 60000 : 0)
  || 5 * 60 * 1000;
let pending = [];                    // [{ ts(秒), q }]
let flushTimer = null;
function nowSec() { return Math.floor(Date.now() / 1000); }
function readLastPromptSec() {
  try { return parseInt(fs.readFileSync(LAST_PROMPT_PATH, 'utf8').trim(), 10) || 0; } catch (e) { return 0; }
}
function scheduleDeferredPush(question) {
  pending.push({ ts: nowSec(), q: question });
  if (!flushTimer) flushTimer = setTimeout(flushPending, DEFER_MS);   // 锚定窗口内第一条，5 分钟后统一 flush
}
function flushPending() {
  flushTimer = null;
  const items = pending; pending = [];
  if (!items.length) return;
  const earliest = items.reduce((m, i) => Math.min(m, i.ts), Infinity);
  if (readLastPromptSec() > earliest) return;                          // 用户已回来在终端答话 → 整窗免推
  if (items.length === 1) { pushNow('⏳ 有事待确认', items[0].q); return; }
  pushNow(`⏳ ${items.length} 条待确认`, items.map((it, i) => `【${i + 1}】${it.q}`).join('\n\n———\n\n'));
}
// 当前前台 app 名（lsappinfo，无需辅助功能权限）；用于判断用户是否正看终端
function frontApp() {
  try {
    const out = execFileSync('sh', ['-c', 'lsappinfo info -only name "$(lsappinfo front)"'], { encoding: 'utf8', timeout: 2000 });
    const m = out.match(/"LSDisplayName"="([^"]*)"/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
// 前台是否为 Claude Code 的宿主（各种终端 / IDE / 桌面 app）——是则用户正看着 Claude，不弹桌面窗
function inHostApp() {
  return /iterm|terminal|ghostty|wezterm|warp|alacritty|kitty|hyper|tabby|rio|konsole|wave|jetbrains|intellij|pycharm|webstorm|goland|datagrip|rubymine|phpstorm|clion|rider|android studio|fleet|cursor|\bcode\b|claude/i.test(frontApp());
}

const FALLBACK = '__FALLBACK__：用户取消 / 超时 / 弹窗不可用。请改用内置 AskUserQuestion 在终端继续提问（终端交互始终保留为后备）。';
const FALLBACK_TERM = '__FALLBACK__：用户当前正看着 Claude 宿主（终端/IDE/桌面 app），直接用内置 AskUserQuestion 提问即可，无需弹桌面窗。';

function askDialog(args) {
  // 智能切换（smart_switch，默认关=始终弹浮顶窗最稳妥）：开启且前台是 Claude 宿主时才不弹、回退终端
  if (/^(1|true|on|yes)$/i.test(process.env.SMART_SWITCH || '') && inHostApp()) return FALLBACK_TERM;
  const question = args.question || '请选择';
  const options = Array.isArray(args.options) ? args.options : [];
  const multiple = !!args.multiple;
  const allowText = !!args.allow_text || options.length === 0;
  const TIMEOUT = Number(args.timeout) || Number(process.env.ASK_DIALOG_TIMEOUT_SEC) || 120;  // 固定存活秒数：本次入参 > 插件配置 > 默认 2 分钟
  const title = args.title || 'Claude 需要你决定';
  const rec = options.find(o => o && o.recommended);
  const def = args.default_label || (rec ? rec.label : '');
  const allowNone = args.allow_none !== false;

  // 手机推送内容：问题 + 选项 + 推荐
  let pushBody = question;
  if (options.length) pushBody += '\n\n选项：' + options.map((o, i) => `\n${i + 1}. ${o.label}${o.recommended ? '（AI推荐）' : ''}${o.description ? ' — ' + o.description : ''}`).join('');
  else if (allowText) pushBody += '\n\n（需要你输入文本回答）';

  const descLines = options.filter(o => o && o.description).map(o => `• ${o.label}${o.recommended ? '（AI 推荐）' : ''}：${o.description}`);
  let promptFull = descLines.length ? `${question}\n\n${descLines.join('\n')}` : question;
  if (rec) promptFull = `💡 AI 推荐：${rec.label}${rec.description ? '（' + rec.description + '）' : ''}\n\n${promptFull}`;

  // 按形态构造脚本 + 结果解析
  let makeScript, parse, lang = 'as';
  if (allowText) {
    makeScript = () => `display dialog "${esc(promptFull)}" default answer "${esc(args.default_text || '')}" with title "${esc(title)}" buttons {"取消","确定"} default button "确定" cancel button "取消" with icon note`;
    parse = (out) => '用户输入：' + field(out, 'text returned');
  } else {
    // 选择题统一走 JXA 原生勾选框：multiple→复选框，否则→radio 单选（自动互斥）。
    // allow_none（默认 true）追加「其他：」选项 + 输入框，与预设同组互斥 → 补充本身即一个选项，就地回传不回终端。
    lang = 'js';
    const data = {
      title,
      prompt: promptFull,
      items: options.map(o => o.label),
      multiple,
      defaults: def ? [def] : [],
      allowSupp: allowNone,
      otherLabel: '其他：',
      suppPlaceholder: '输入自定义内容；点「取消」则作为转回会话的说明…'
    };
    makeScript = () => buildChoiceJxa(data);
    parse = (out) => {
      out = (out || '').trim();
      if (out === '') return FALLBACK;
      let o;
      try { o = JSON.parse(out); } catch (e) { return FALLBACK; }
      if (o.action === 'cancel') {
        const note = (o.supplement || '').trim();
        // 取消 = 转回当前会话；框里写了说明就一并带回（仍是 __FALLBACK__，模型据此回终端处理）
        return note
          ? '__FALLBACK__：用户取消弹窗、要求转回当前会话处理，附说明：「' + note + '」。请在终端据此继续，不要重复弹窗。'
          : FALLBACK;
      }
      const sel = Array.isArray(o.selected) ? o.selected : [];
      const supp = o.supplement || '';
      if (multiple) {
        const parts = [];
        if (sel.length) parts.push('用户选择：' + sel.join(', '));
        if (supp) parts.push('用户补充：' + supp);          // 勾了「其他」或填了框 → 采纳补充
        return parts.length ? parts.join('；') : FALLBACK;
      }
      // 单选：选「其他」用补充；否则用选中的预设项；都没选但填了框也用补充
      if (o.other) return supp ? '用户补充：' + supp : FALLBACK;
      if (sel.length) return '用户选择：' + sel[0];
      if (supp) return '用户补充：' + supp;
      return FALLBACK;
    };
  }

  chime();
  let result;
  try {
    result = parse(runOsaTimed(makeScript(), TIMEOUT, lang)); // 单窗固定存活 TIMEOUT 秒（默认 2 分钟），到点 osascript 被 kill 抛错
  } catch (e) {
    if (e && e.status === 1) return FALLBACK;                // 用户点了取消（人在）→ 不推
    scheduleDeferredPush(pushBody);                          // 自动关闭（人不在）→ 回退终端 + 关后 5 分钟仍没回话才合并推
    return FALLBACK;
  }
  return result;
}

const TOOL = {
  name: 'ask_dialog',
  description: '弹 macOS 桌面弹窗向用户选择/确认/输入，结果直接返回，使用户无需切回终端。用于方案选择、确认、自由文本回答。窗口固定存活 2 分钟，到点未处理则关窗回退终端（关闭后再等 5 分钟，期间用户在终端回过话则免推，否则合并推手机）。返回文本以 __FALLBACK__ 开头时表示用户取消/超时/弹窗不可用，应改用内置终端提问。',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题' },
      options: { type: 'array', description: '可选项；每项 {label, description?, recommended?}。recommended:true 标记 AI 推荐项（自动设为默认高亮/预选并在弹窗顶部显示推荐及理由）。省略 options 则弹文本输入框', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string', description: '该选项说明；推荐项的 description 会作为推荐理由显示' }, recommended: { type: 'boolean', description: '是否为 AI 推荐项' } }, required: ['label'] } },
      multiple: { type: 'boolean', description: '是否允许多选。true=复选框可勾多项；false/省略=radio 单选框（自动互斥）。两种形态都会在末尾附「其他：」选项+输入框' },
      allow_text: { type: 'boolean', description: '是否弹自由文本输入框' },
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
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ask-dialog', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  } else if (method === 'tools/call') {
    const p = req.params || {};
    if (p.name === 'ask_dialog') {
      writeLock();                                          // 标记弹窗活跃 → notify-wait.sh 据此跳过「⏳ 等待你」横幅，避免双弹
      let text;
      try { text = askDialog(p.arguments || {}); } finally { clearLock(); } // 成功/失败/异常都清锁
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + p.name } });
    }
  } else if (method && method.indexOf('notifications/') === 0) {
    // notification：不回应
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});

// 供测试 require（被 node 直接当 MCP server 跑时无副作用）
module.exports = { askDialog, buildChoiceJxa };
