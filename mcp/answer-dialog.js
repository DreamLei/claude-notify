#!/usr/bin/env node
'use strict';
// Codex（或任何本机进程）用来发现活跃轮次 / 提交某一轮答案的小 CLI。
// 用法：
//   node answer-dialog.js list                       列出活跃 dialog（dialog_id + 问题）
//   node answer-dialog.js answer <dialog_id> <文本>   给指定轮次提交答案
//   node answer-dialog.js answer --latest <文本>      给最近打开的轮次提交答案
// 退出码：0 成功 / 2 被拒（not_found / already_answered / empty / no_active 等）/ 1 连接失败。
// 默认枚举注册表目录发现所有并发会话；可用 ASK_DIALOG_SOCKET 环境变量锁定单个会话 socket。

const { answer, listSessions, collectDialogs } = require('./dialog-client');

// 目标 socket 列表：ASK_DIALOG_SOCKET 指定则只用它（单会话覆盖）；否则枚举注册表发现所有活跃会话。
function targetSockets() {
  if (process.env.ASK_DIALOG_SOCKET) return [process.env.ASK_DIALOG_SOCKET];
  return listSessions(process.env.ASK_DIALOG_REGISTRY_DIR).map((s) => s.socket);   // 未设时 listSessions 回退默认目录
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const sockets = targetSockets();

  if (cmd === 'list') {
    const dialogs = await collectDialogs(sockets);
    if (!dialogs.length) { console.log('（无活跃弹窗）'); return 0; }
    for (const d of dialogs) console.log(`${d.dialog_id}\t${(d.question || '').replace(/\n/g, ' ')}`);
    return 0;
  }

  if (cmd === 'answer') {
    let dialogId = argv[1];
    let textParts;
    if (dialogId === '--latest') { dialogId = null; textParts = argv.slice(2); }
    else textParts = argv.slice(2);
    const text = textParts.join(' ');
    if (!text) { console.error('用法：answer <dialog_id|--latest> <答案文本>'); return 2; }

    // 跨所有会话定位目标轮次：--latest 取全局 started 最大者；指定 id 则按 id 精确匹配。
    const dialogs = await collectDialogs(sockets);
    const target = dialogId
      ? dialogs.find((d) => d.dialog_id === dialogId) || null
      : dialogs.reduce((best, d) => (!best || d.started > best.started ? d : best), null);
    if (!target) {
      const resp = { ok: false, status: dialogId ? 'not_found' : 'no_active' };
      if (dialogId) resp.dialog_id = dialogId;
      console.log(JSON.stringify(resp));
      return 2;
    }
    const resp = await answer(target.socket, target.dialog_id, text);
    console.log(JSON.stringify(resp));
    return resp && resp.ok ? 0 : 2;
  }

  console.error('用法：list | answer <dialog_id|--latest> <文本>');
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('连接 ask-dialog 失败：' + (e && e.message || e)); process.exit(1); });
