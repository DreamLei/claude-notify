'use strict';
// DialogHub：ask_dialog 的异步核心。
// 把三件事解耦成可测单元：①弹 macOS 原生窗（异步子进程，不再 execFileSync 阻塞事件循环）
// ②本机侧通道（Unix socket）接收 Codex 中转的某一轮答案，并主动关掉对应桌面弹窗
// ③首答获胜裁决：桌面本机作答 / Codex 中转 / 超时 三者谁先到谁赢，后到者被忽略或返回明确冲突状态。
//
// dialog_id 关联轮次；活跃轮次写按 pid 隔离的注册表 ~/.claude/.ask-dialog-registry/<pid>.json 供 Codex 发现
// （socket 同样按 pid 隔离 ~/.claude/.ask-dialog.<pid>.sock，多会话并发互不抢占）；
// 锁文件 ~/.claude/.ask-dialog-active 仍只写纯数字时间戳（notify-wait.sh 的既有契约，全机共享，不能动）。

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SOURCE_LOCAL = '电脑本机';
const SOURCE_CODEX = 'Codex中转';

const FALLBACK = '__FALLBACK__：用户取消 / 超时 / 弹窗不可用。请改用内置 AskUserQuestion 在终端继续提问（终端交互始终保留为后备）。';
const FALLBACK_TERM = '__FALLBACK__：用户当前正看着 Claude 宿主（终端/IDE/桌面 app），直接用内置 AskUserQuestion 提问即可，无需弹桌面窗。';

const PID = process.pid;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
// socket 按 pid 隔离 → 多个并发 Claude 会话各用各的侧通道，互不抢占/覆盖。
const DEFAULT_SOCKET_PATH = path.join(CLAUDE_DIR, '.ask-dialog.' + PID + '.sock');
// 注册表改为目录：每个会话写自己的 <pid>.json，Codex 端枚举该目录即可发现所有活跃会话及其 socket。
const DEFAULT_REGISTRY_DIR = path.join(CLAUDE_DIR, '.ask-dialog-registry');
const DEFAULT_REGISTRY_PATH = path.join(DEFAULT_REGISTRY_DIR, PID + '.json');
// 锁文件仍是全机共享的纯数字时间戳（notify-wait.sh 的既有契约，不能动）。
const DEFAULT_LOCK_PATH = path.join(CLAUDE_DIR, '.ask-dialog-active');
const ICON_PNG = path.join(__dirname, '..', 'assets', 'cc-icon.png');

// —— JXA 弹窗脚本构造（与原实现逐字保持，保证桌面弹窗行为不变）——
const EDIT_MENU_JXA = [
  '(function(){',
  '  var mm = $.NSMenu.alloc.init;',
  '  var ei = $.NSMenuItem.alloc.init;',
  '  mm.addItem(ei);',
  "  var em = $.NSMenu.alloc.initWithTitle('Edit');",
  '  ei.submenu = em;',
  '  function add(t, s, k){ em.addItem($.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(t, $.NSSelectorFromString(s), k)); }',
  "  add('Cut','cut:','x'); add('Copy','copy:','c'); add('Paste','paste:','v'); add('Select All','selectAll:','a');",
  '  $.NSApp.mainMenu = mm;',
  '})();'
].join('\n');

function buildTextJxa(d) {
  return [
    "ObjC.import('Cocoa');",
    'var D = ' + JSON.stringify(d) + ';',
    'var W = 380, FIELDH = 24;',
    'var view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, FIELDH));',
    'var field = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, W, FIELDH));',
    'field.stringValue = D.defaultText;',
    'view.addSubview(field);',
    'var alert = $.NSAlert.alloc.init;',
    'if (D.iconPath) { var _ic = $.NSImage.alloc.initWithContentsOfFile(D.iconPath); if (_ic && !_ic.isNil()) alert.icon = _ic; }',
    'alert.messageText = D.title;',
    'alert.informativeText = D.prompt;',
    "alert.addButtonWithTitle('确定');",
    "alert.addButtonWithTitle('取消');",
    'alert.accessoryView = view;',
    'alert.window.setLevel(3);',
    'alert.window.setInitialFirstResponder(field);',
    '$.NSApp.setActivationPolicy(0);',
    EDIT_MENU_JXA,
    '$.NSApp.activateIgnoringOtherApps(true);',
    'var resp = alert.runModal;',
    'var txt = ObjC.unwrap(field.stringValue);',
    "var out = (resp.toString() === '1000') ? JSON.stringify({ action: 'ok', text: txt }) : JSON.stringify({ action: 'cancel', text: txt });",
    'out;'
  ].join('\n');
}

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
    'if (D.iconPath) { var _ic = $.NSImage.alloc.initWithContentsOfFile(D.iconPath); if (_ic && !_ic.isNil()) alert.icon = _ic; }',
    'alert.messageText = D.title;',
    'alert.informativeText = D.prompt;',
    "alert.addButtonWithTitle('确定');",
    "alert.addButtonWithTitle('取消');",
    'alert.accessoryView = view;',
    'alert.window.setLevel(3);',
    'if (field) alert.window.setInitialFirstResponder(field);',
    '$.NSApp.setActivationPolicy(0);',
    EDIT_MENU_JXA,
    '$.NSApp.activateIgnoringOtherApps(true);',
    'var resp = alert.runModal;',
    "var note = field ? ObjC.unwrap(field.stringValue).trim() : '';",
    'var out;',
    "if (resp.toString() === '1000') {",
    '  var sel = [];',
    '  for (var j = 0; j < boxes.length; j++) { if (Number(boxes[j].state) > 0) sel.push(ObjC.unwrap(boxes[j].title)); }',
    '  var other = otherBtn ? (Number(otherBtn.state) > 0) : false;',
    "  out = JSON.stringify({ action: 'ok', selected: sel, other: other, supplement: note });",
    "} else { out = JSON.stringify({ action: 'cancel', supplement: note }); }",
    'out;'
  ].join('\n');
}

// 真实弹窗启动器：异步 spawn osascript，绝不阻塞事件循环。
// 返回 { promise, kill }：promise 在进程退出时 resolve {code, stdout} 或 {error}；kill() 关掉窗口。
function realLaunchDialog({ script, lang, env }) {
  const cliArgs = lang === 'js' ? ['-l', 'JavaScript', '-e', script] : ['-e', script];
  let child = null;
  const promise = new Promise((resolve) => {
    try {
      // stdin/stderr 丢弃、只收 stdout：osascript -e 不读 stdin，stderr 不消费则 >64KB 会回压阻塞子进程。
      child = spawn('osascript', cliArgs, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      resolve({ error: e });
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ error: e }));
    child.on('close', (code, signal) => resolve({ code, signal, stdout: out }));
  });
  return { promise, kill: () => { try { if (child) child.kill('SIGTERM'); } catch (e) {} } };
}

function defaultChime() {
  try { spawn('afplay', ['/System/Library/Sounds/Ping.aiff'], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
}

class DialogHub {
  constructor(opts) {
    opts = opts || {};
    this.launchDialog = opts.launchDialog || realLaunchDialog;
    this.pushDeferred = opts.pushDeferred || (() => {});           // (pushBody) => void，超时/弹窗不可用时调用
    this.chime = opts.chime || defaultChime;
    this.now = opts.now || (() => Date.now());
    this.socketPath = opts.socketPath || DEFAULT_SOCKET_PATH;
    this.registryPath = opts.registryPath || DEFAULT_REGISTRY_PATH;
    this.lockPath = opts.lockPath || DEFAULT_LOCK_PATH;
    this.iconPath = opts.iconPath || ICON_PNG;
    this.env = opts.env || { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
    this.smartSwitch = opts.smartSwitch || (() => false);          // () => bool，true=前台是 Claude 宿主，回退终端
    this.defaultTimeoutSec = opts.defaultTimeoutSec || 120;

    this._seq = 0;
    this._active = new Map();   // dialog_id -> dialog record（在飞轮次）
    this._recent = new Map();   // dialog_id -> winner（已结算轮次的简短记忆，给后到答案返回 already_answered）
    this._recentCap = opts.recentCap || 256;
    this._server = null;
  }

  // —— 本机侧通道：Unix socket 常驻监听，Codex 经 dialog-client 发来 {cmd,...} 单行 JSON ——
  start() {
    if (this._server) return Promise.resolve();
    try { fs.unlinkSync(this.socketPath); } catch (e) {}     // 清理上次异常退出残留的 socket 文件
    return new Promise((resolve, reject) => {
      const server = net.createServer((conn) => this._onConn(conn));
      server.on('error', (e) => { if (!this._server) reject(e); });
      server.listen(this.socketPath, () => { this._server = server; resolve(); });
    });
  }

  stop() {
    // 关闭 socket + 关掉所有在飞弹窗 + 清理注册表/锁，用于进程退出或测试收尾。
    for (const id of [...this._active.keys()]) {
      const rec = this._active.get(id);
      if (rec) { try { rec.kill(); } catch (e) {} this._settle(id, FALLBACK, null, false); }
    }
    if (this._server) { try { this._server.close(); } catch (e) {} this._server = null; }
    try { fs.unlinkSync(this.socketPath); } catch (e) {}
    try { fs.unlinkSync(this.registryPath); } catch (e) {}   // 移除本会话注册项，避免遗留死 socket 指针
  }

  _onConn(conn) {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { this._reply(conn, { ok: false, status: 'bad_json' }); continue; }
        this._reply(conn, this._handleCommand(msg));
      }
    });
    conn.on('error', () => {});
  }

  _reply(conn, obj) { try { conn.write(JSON.stringify(obj) + '\n'); } catch (e) {} }

  _handleCommand(msg) {
    const cmd = msg && msg.cmd;
    if (cmd === 'list') return { ok: true, dialogs: this.list() };
    if (cmd === 'answer') {
      const text = typeof msg.text === 'string' ? msg.text : '';
      let id = msg.dialog_id;
      if (msg.latest || !id) {                                  // --latest：挑最近打开的活跃轮次
        const ids = [...this._active.values()].sort((a, b) => b.started - a.started);
        if (!ids.length) return { ok: false, status: 'no_active' };
        id = ids[0].id;
      }
      return this.submitAnswer(id, text, SOURCE_CODEX);
    }
    return { ok: false, status: 'unknown_cmd' };
  }

  // Codex 中转某一轮答案：首答获胜则采纳并关窗；该轮不存在 / 已被先到答案锁定 → 明确冲突状态。
  submitAnswer(dialogId, text, source) {
    const rec = this._active.get(dialogId);
    if (!rec) {
      // 已结算（首答已被另一侧拿下 / 超时关闭）→ 明确冲突；从未见过的 id → not_found。
      if (this._recent.has(dialogId)) return { ok: false, status: 'already_answered', dialog_id: dialogId, winner: this._recent.get(dialogId) };
      return { ok: false, status: 'not_found', dialog_id: dialogId };
    }
    if (rec.settled) return { ok: false, status: 'already_answered', dialog_id: dialogId, winner: rec.winner };
    const clean = (text || '').trim();
    if (!clean) return { ok: false, status: 'empty', dialog_id: dialogId };
    const result = '用户回答：' + clean + '（来源：' + source + '）';
    rec.kill();                                                  // 主动关掉对应桌面弹窗
    this._settle(dialogId, result, source, false);
    return { ok: true, status: 'accepted', dialog_id: dialogId };
  }

  list() {
    return [...this._active.values()].map((r) => ({ dialog_id: r.id, question: r.question, started: r.started }));
  }

  // 结算某一轮（首答获胜）：clear 定时器、出注册表、必要时回退 push、resolve 原 ask() promise。
  _settle(dialogId, resultText, winnerSource, deferPush) {
    const rec = this._active.get(dialogId);
    if (!rec || rec.settled) return false;
    rec.settled = true;
    rec.winner = winnerSource;
    if (rec.timer) clearTimeout(rec.timer);
    this._active.delete(dialogId);
    this._recent.set(dialogId, winnerSource || '已关闭');     // 记忆首答归属，后到重复答案据此返回 already_answered
    if (this._recent.size > this._recentCap) this._recent.delete(this._recent.keys().next().value);
    this._writeRegistry();
    this._refreshLock();
    if (deferPush) this.pushDeferred(rec.pushBody);
    rec.resolve(resultText);
    return true;
  }

  _writeRegistry() {
    try {
      fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
      fs.writeFileSync(this.registryPath, JSON.stringify({ pid: PID, socket: this.socketPath, dialogs: this.list() }));
    } catch (e) {}
  }

  // 锁文件只写纯数字时间戳（notify-wait.sh 契约）：有活跃轮次→写 now 秒；全部结束→删。
  _refreshLock() {
    try {
      if (this._active.size > 0) fs.writeFileSync(this.lockPath, String(Math.floor(this.now() / 1000)));
      else fs.unlinkSync(this.lockPath);
    } catch (e) {}
  }

  // 入口：构造弹窗脚本 → 注册轮次 → 异步弹窗，与 socket/超时竞速，首答获胜。返回 Promise<string>。
  // smartSwitch 可同步或异步（前台 app 判定走异步子进程）→ 统一 await。
  ask(args) {
    args = args || {};
    return Promise.resolve(this.smartSwitch()).then((skip) => skip ? FALLBACK_TERM : this._launch(args || {}));
  }

  _launch(args) {
    const built = this._buildScript(args);
    const timeoutSec = Number(args.timeout) || this.defaultTimeoutSec;
    const dialogId = 'd' + process.pid + '-' + (++this._seq);
    const { promise, kill } = this.launchDialog({ script: built.script, lang: built.lang, env: this.env });

    return new Promise((resolve) => {
      const rec = {
        id: dialogId,
        question: built.question,
        pushBody: built.pushBody,
        started: this.now(),
        settled: false,
        winner: null,
        kill,
        resolve,
        timer: null
      };
      this._active.set(dialogId, rec);
      this._writeRegistry();
      this._refreshLock();

      // 超时：到点关窗，回退终端 + 延迟合并推送（人不在）。
      rec.timer = setTimeout(() => {
        if (rec.settled) return;
        kill();
        this._settle(dialogId, FALLBACK, null, true);
      }, timeoutSec * 1000);

      this.chime();

      // 桌面本机作答（osascript 退出）：与 socket、超时竞速；已被先到答案结算则忽略。
      promise.then((res) => {
        if (rec.settled) return;
        if (res && res.error) { this._settle(dialogId, FALLBACK, null, true); return; }   // 弹窗不可用 → 回退 + push
        const out = (res && res.stdout || '').trim();
        const parsed = built.parse(out);
        // parsed 已是回退串（取消/空）则不 push（用户在场或仅是空提交）；否则附本机来源。
        if (parsed.indexOf('__FALLBACK__') === 0) this._settle(dialogId, parsed, null, false);
        else this._settle(dialogId, parsed + '（来源：' + SOURCE_LOCAL + '）', SOURCE_LOCAL, false);
      });
    });
  }

  // 构造脚本 + 解析器 + 推送正文（从原 askDialog 同步部分原样搬来）。
  _buildScript(args) {
    const question = args.question || '请选择';
    const options = Array.isArray(args.options) ? args.options : [];
    const multiple = !!args.multiple;
    const pureTextBox = options.length === 0;
    const wantInput = !!args.allow_text;
    const title = args.title || 'Claude 需要你决定';
    const rec = options.find((o) => o && o.recommended);
    const def = args.default_label || (rec ? rec.label : '');
    const allowNone = args.allow_none !== false;

    let pushBody = question;
    if (options.length) pushBody += '\n\n选项：' + options.map((o, i) => `\n${i + 1}. ${o.label}${o.recommended ? '（AI推荐）' : ''}${o.description ? ' — ' + o.description : ''}`).join('');
    else pushBody += '\n\n（需要你输入文本回答）';

    const descLines = options.filter((o) => o && o.description).map((o) => `• ${o.label}${o.recommended ? '（AI 推荐）' : ''}：${o.description}`);
    let promptFull = descLines.length ? `${question}\n\n${descLines.join('\n')}` : question;
    if (rec) promptFull = `💡 AI 推荐：${rec.label}${rec.description ? '（' + rec.description + '）' : ''}\n\n${promptFull}`;

    let script, parse, lang;
    if (pureTextBox) {
      lang = 'js';
      const data = { title, prompt: promptFull, defaultText: args.default_text || '', iconPath: this.iconPath };
      script = buildTextJxa(data);
      parse = (out) => {
        out = (out || '').trim();
        if (out === '') return FALLBACK;
        let o;
        try { o = JSON.parse(out); } catch (e) { return FALLBACK; }
        if (o.action === 'cancel') {
          const note = (o.text || '').trim();
          return note
            ? '__FALLBACK__：用户取消弹窗、要求转回当前会话处理，附说明：「' + note + '」。请在终端据此继续，不要重复弹窗。'
            : FALLBACK;
        }
        return '用户输入：' + (o.text || '');
      };
    } else {
      lang = 'js';
      const data = {
        title,
        prompt: promptFull,
        items: options.map((o) => o.label),
        multiple,
        defaults: def ? [def] : [],
        allowSupp: allowNone || wantInput,
        otherLabel: '其他：',
        suppPlaceholder: '输入自定义内容；点「取消」则作为转回会话的说明…',
        iconPath: this.iconPath
      };
      script = buildChoiceJxa(data);
      parse = (out) => {
        out = (out || '').trim();
        if (out === '') return FALLBACK;
        let o;
        try { o = JSON.parse(out); } catch (e) { return FALLBACK; }
        if (o.action === 'cancel') {
          const note = (o.supplement || '').trim();
          return note
            ? '__FALLBACK__：用户取消弹窗、要求转回当前会话处理，附说明：「' + note + '」。请在终端据此继续，不要重复弹窗。'
            : FALLBACK;
        }
        const sel = Array.isArray(o.selected) ? o.selected : [];
        const supp = o.supplement || '';
        if (multiple) {
          const parts = [];
          if (sel.length) parts.push('用户选择：' + sel.join(', '));
          if (supp) parts.push('用户补充：' + supp);
          return parts.length ? parts.join('；') : FALLBACK;
        }
        if (o.other) return supp ? '用户补充：' + supp : FALLBACK;
        if (sel.length) return '用户选择：' + sel[0];
        if (supp) return '用户补充：' + supp;
        return FALLBACK;
      };
    }
    return { script, lang, parse, question, pushBody };
  }
}

module.exports = {
  DialogHub,
  buildChoiceJxa,
  buildTextJxa,
  realLaunchDialog,
  FALLBACK,
  FALLBACK_TERM,
  SOURCE_LOCAL,
  SOURCE_CODEX,
  DEFAULT_SOCKET_PATH,
  DEFAULT_REGISTRY_DIR,
  DEFAULT_REGISTRY_PATH,
  DEFAULT_LOCK_PATH
};
