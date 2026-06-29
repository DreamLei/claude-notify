#!/usr/bin/env node
'use strict';
// Codex（或任何本机进程）用来发现活跃轮次 / 提交某一轮答案的小 CLI。
// 用法：
//   node answer-dialog.js list                       列出活跃 dialog（dialog_id + 问题）
//   node answer-dialog.js answer <dialog_id> <文本>   给指定轮次提交答案
//   node answer-dialog.js answer --latest <文本>      给最近打开的轮次提交答案
// 退出码：0 成功 / 2 被拒（not_found / already_answered / empty 等）/ 1 连接失败。
// 可用 ASK_DIALOG_SOCKET 环境变量覆盖 socket 路径。

const { list, answer, DEFAULT_SOCKET_PATH } = require('./dialog-client');

const SOCKET = process.env.ASK_DIALOG_SOCKET || DEFAULT_SOCKET_PATH;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'list') {
    const resp = await list(SOCKET);
    const dialogs = (resp && resp.dialogs) || [];
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
    const resp = await answer(SOCKET, dialogId, text);
    console.log(JSON.stringify(resp));
    return resp && resp.ok ? 0 : 2;
  }

  console.error('用法：list | answer <dialog_id|--latest> <文本>');
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('连接 ask-dialog 失败：' + (e && e.message || e)); process.exit(1); });
