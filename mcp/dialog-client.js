'use strict';
// 本机侧通道客户端：连 DialogHub 的 Unix socket，发一条 {cmd,...} JSON，读回一行 JSON 响应即断开。
// 供 answer-dialog.js CLI 与测试复用，零依赖。

const net = require('net');
const path = require('path');
const os = require('os');

const DEFAULT_SOCKET_PATH = path.join(os.homedir(), '.claude', '.ask-dialog.sock');

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

module.exports = { sendCommand, list, answer, DEFAULT_SOCKET_PATH };
