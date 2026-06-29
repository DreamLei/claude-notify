'use strict';
// 本机侧通道客户端：连 DialogHub 的 Unix socket，发一条 {cmd,...} JSON，读回一行 JSON 响应即断开。
// 供 answer-dialog.js CLI 与测试复用，零依赖。

const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

// socket 已按 pid 隔离，无单一固定路径；此常量仅作 ASK_DIALOG_SOCKET 未设时的兜底（一般走注册表发现）。
const DEFAULT_SOCKET_PATH = path.join(os.homedir(), '.claude', '.ask-dialog.sock');
const DEFAULT_REGISTRY_DIR = path.join(os.homedir(), '.claude', '.ask-dialog-registry');

// 发送单条命令，resolve 解析后的响应对象；连接失败 / 超时 reject。
function sendCommand(socketPath, obj, timeoutMs) {
  socketPath = socketPath || DEFAULT_SOCKET_PATH;
  timeoutMs = timeoutMs || 3000;
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buf = '';
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; try { conn.destroy(); } catch (e) {} err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('socket timeout')), timeoutMs);
    conn.on('connect', () => { conn.write(JSON.stringify(obj) + '\n'); });
    conn.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        clearTimeout(timer);
        let resp;
        try { resp = JSON.parse(buf.slice(0, idx)); } catch (e) { return finish(e); }
        finish(null, resp);
      }
    });
    conn.on('error', (e) => { clearTimeout(timer); finish(e); });
  });
}

const list = (socketPath) => sendCommand(socketPath, { cmd: 'list' });
// dialogId 传 null/undefined → 走 latest（最近打开的活跃轮次）
const answer = (socketPath, dialogId, text) =>
  sendCommand(socketPath, dialogId ? { cmd: 'answer', dialog_id: dialogId, text } : { cmd: 'answer', latest: true, text });

// 枚举注册表目录里所有会话项（每个 <pid>.json = {pid, socket, dialogs}）；坏文件静默跳过。
function listSessions(registryDir) {
  registryDir = registryDir || DEFAULT_REGISTRY_DIR;
  let files;
  try { files = fs.readdirSync(registryDir); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    if (f.slice(-5) !== '.json') continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf8'));
      if (rec && rec.socket) out.push(rec);
    } catch (e) {}
  }
  return out;
}

// 逐个连接给定 socket 取活跃弹窗，聚合成 [{socket, dialog_id, question, started}]；连不上的（死会话）自动跳过。
async function collectDialogs(sockets) {
  const out = [];
  for (const sock of sockets) {
    let resp;
    try { resp = await sendCommand(sock, { cmd: 'list' }); } catch (e) { continue; }
    for (const d of (resp && resp.dialogs) || []) out.push(Object.assign({ socket: sock }, d));
  }
  return out;
}

module.exports = { sendCommand, list, answer, listSessions, collectDialogs, DEFAULT_SOCKET_PATH, DEFAULT_REGISTRY_DIR };
