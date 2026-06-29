'use strict';
// DialogHub 行为测试：本机作答 / Codex 中转 / 竞态首答获胜+冲突 / 超时清理 / smart_switch。
// 用可注入的假弹窗启动器（不真正 spawn osascript，CI/无头可跑）+ 临时 Unix socket 走真实侧通道。
// 运行：node --test mcp/test/dialog-hub.test.js
//
// 注意：ask() 把 smartSwitch 判定改为 await 后，轮次注册落在一个 microtask 里 → 测试在 ask() 后
// 不能同步读 list()/resolve，必须先 waitLaunched() 等 _launch 真正执行；否则失败路径会遗留 timer。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DialogHub, SOURCE_LOCAL, SOURCE_CODEX, FALLBACK, FALLBACK_TERM } = require('../dialog-hub');
const client = require('../dialog-client');

const tick = () => new Promise((r) => setImmediate(r));
// 等到 _launch 真正跑完（假启动器把 launched 置 1，轮次也已注册进 _active）。
async function waitLaunched(s) { for (let i = 0; i < 50 && s.launched === 0; i++) await tick(); }

let seq = 0;
// 造一套隔离的临时路径 + 假弹窗启动器；启动器可被外部 resolve（模拟本机作答）并记录 kill 次数（验证关窗）。
// overrides 可注入 smartSwitch 等，验证不弹窗回退路径。
function harness(overrides) {
  seq += 1;
  const base = path.join(os.tmpdir(), `adh-${process.pid}-${seq}`);
  const launchState = { killed: 0, resolve: null, launched: 0 };
  const pushes = [];
  const hub = new DialogHub(Object.assign({
    socketPath: base + '.sock',
    registryPath: base + '.registry.json',
    lockPath: base + '.lock',
    chime: () => {},
    pushDeferred: (body) => pushes.push(body),
    launchDialog: () => {
      launchState.launched += 1;
      let resolveFn;
      const promise = new Promise((r) => { resolveFn = r; });
      launchState.resolve = resolveFn;          // 测试侧调用即模拟桌面弹窗返回
      return { promise, kill: () => { launchState.killed += 1; } };
    }
  }, overrides || {}));
  return { hub, launchState, pushes, base };
}

const choiceArgs = { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] };

test('本机作答：桌面弹窗返回，结算并标注来源=电脑本机', async () => {
  const { hub, launchState } = harness();
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    launchState.resolve({ code: 0, stdout: JSON.stringify({ action: 'ok', selected: ['B'], other: false, supplement: '' }) });
    const res = await p;
    assert.strictEqual(res, '用户选择：B（来源：' + SOURCE_LOCAL + '）');
    assert.deepStrictEqual(hub.list(), []);                 // 结算后注册表清空
  } finally { hub.stop(); }
});

test('Codex 中转：经 socket 提交答案 → 关窗 + 结算，来源=Codex中转', async () => {
  const { hub, launchState } = harness();
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    const active = hub.list();
    assert.strictEqual(active.length, 1);
    const id = active[0].dialog_id;
    assert.strictEqual(active[0].question, '选哪个？');

    const resp = await client.answer(hub.socketPath, id, 'B');
    assert.deepStrictEqual(resp, { ok: true, status: 'accepted', dialog_id: id });

    const res = await p;
    assert.strictEqual(res, '用户回答：B（来源：' + SOURCE_CODEX + '）');
    assert.strictEqual(launchState.killed, 1);              // 主动关掉了桌面弹窗
    assert.deepStrictEqual(hub.list(), []);
  } finally { hub.stop(); }
});

test('Codex --latest：不带 dialog_id 也能给最近一轮作答', async () => {
  const { hub, launchState } = harness();
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    const resp = await client.answer(hub.socketPath, null, '就选 A');
    assert.strictEqual(resp.ok, true);
    const res = await p;
    assert.strictEqual(res, '用户回答：就选 A（来源：' + SOURCE_CODEX + '）');
    assert.strictEqual(launchState.killed, 1);
  } finally { hub.stop(); }
});

test('竞态首答获胜：Codex 先到 → 本机后到被忽略，重复提交返回 already_answered', async () => {
  const { hub, launchState } = harness();
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    const id = hub.list()[0].dialog_id;

    // Codex 先赢
    const first = await client.answer(hub.socketPath, id, 'B');
    assert.strictEqual(first.status, 'accepted');

    // 桌面弹窗随后才返回（被 kill 后 osascript 退出）→ 必须被忽略，不得覆盖首答
    launchState.resolve({ code: 0, stdout: JSON.stringify({ action: 'ok', selected: ['A'], other: false, supplement: '' }) });

    const res = await p;
    assert.strictEqual(res, '用户回答：B（来源：' + SOURCE_CODEX + '）');   // 仍是首答

    // 后到的重复 Codex 提交：明确冲突
    const dup = await client.answer(hub.socketPath, id, 'C');
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.status, 'already_answered');
    assert.strictEqual(dup.winner, SOURCE_CODEX);
  } finally { hub.stop(); }
});

test('本机先到→Codex 后到 already_answered（winner=电脑本机）', async () => {
  const { hub, launchState } = harness();
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    const id = hub.list()[0].dialog_id;
    launchState.resolve({ code: 0, stdout: JSON.stringify({ action: 'ok', selected: ['A'], other: false, supplement: '' }) });
    const res = await p;
    assert.strictEqual(res, '用户选择：A（来源：' + SOURCE_LOCAL + '）');

    const late = await client.answer(hub.socketPath, id, '迟到答案');
    assert.strictEqual(late.ok, false);
    assert.strictEqual(late.status, 'already_answered');
    assert.strictEqual(late.winner, SOURCE_LOCAL);
  } finally { hub.stop(); }
});

test('超时清理：到点关窗 + 回退 FALLBACK + 延迟推送一次 + 注册表/锁清理', async () => {
  const { hub, launchState, pushes, base } = harness();
  await hub.start();
  try {
    const p = hub.ask({ ...choiceArgs, timeout: 0.05 });    // 50ms 超时；弹窗永不返回
    await waitLaunched(launchState);
    assert.strictEqual(hub.list().length, 1);
    assert.ok(fs.existsSync(base + '.lock'));                // 活跃期间锁存在（纯数字时间戳）
    const lockTs = fs.readFileSync(base + '.lock', 'utf8').trim();
    assert.match(lockTs, /^\d+$/);

    const res = await p;
    assert.strictEqual(res, FALLBACK);
    assert.strictEqual(launchState.killed, 1);              // 超时关窗
    assert.strictEqual(pushes.length, 1);                   // 触发一次延迟推送（人不在）
    assert.deepStrictEqual(hub.list(), []);
    assert.strictEqual(fs.existsSync(base + '.lock'), false); // 锁已清
  } finally { hub.stop(); }
});

test('socket 命令：不存在的 dialog_id 返回 not_found；list 反映活跃轮次', async () => {
  const { hub, launchState } = harness();
  await hub.start();
  try {
    const nf = await client.answer(hub.socketPath, 'nope-123', 'x');
    assert.strictEqual(nf.status, 'not_found');

    const empty = await client.list(hub.socketPath);
    assert.deepStrictEqual(empty.dialogs, []);

    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    const listed = await client.list(hub.socketPath);
    assert.strictEqual(listed.dialogs.length, 1);

    // 收尾：给它作答以结算，避免悬挂
    await client.answer(hub.socketPath, listed.dialogs[0].dialog_id, 'A');
    await p;
  } finally { hub.stop(); }
});

test('smart_switch（异步返回 true）：直接回退终端，不弹窗', async () => {
  const { hub, launchState } = harness({ smartSwitch: async () => true });
  await hub.start();
  try {
    const res = await hub.ask(choiceArgs);
    assert.strictEqual(res, FALLBACK_TERM);
    assert.strictEqual(launchState.launched, 0);            // 根本没弹窗
    assert.deepStrictEqual(hub.list(), []);                 // 无遗留轮次/timer
  } finally { hub.stop(); }
});

test('smart_switch（异步返回 false）：正常弹窗并可本机作答', async () => {
  const { hub, launchState } = harness({ smartSwitch: async () => false });
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    assert.strictEqual(launchState.launched, 1);            // 异步判定后照常弹窗
    launchState.resolve({ code: 0, stdout: JSON.stringify({ action: 'ok', selected: ['A'], other: false, supplement: '' }) });
    assert.strictEqual(await p, '用户选择：A（来源：' + SOURCE_LOCAL + '）');
  } finally { hub.stop(); }
});

test('多实例隔离：两个会话各写 <pid>.json，跨会话发现 + 聚合 + --latest 取全局最新', async () => {
  const dir = path.join(os.tmpdir(), `adh-reg-${process.pid}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  // 造两个独立会话，注册表写进同一目录、socket 各异、now 注入以确定 started 大小关系。
  const mk = (tag, nowVal) => {
    const base = path.join(os.tmpdir(), `adh-multi-${process.pid}-${seq}-${tag}`);
    const ls = { killed: 0, resolve: null, launched: 0 };
    const hub = new DialogHub({
      socketPath: base + '.sock',
      registryPath: path.join(dir, tag + '.json'),
      lockPath: base + '.lock',
      chime: () => {},
      now: () => nowVal,
      launchDialog: () => {
        ls.launched += 1;
        let r; const promise = new Promise((res) => { r = res; }); ls.resolve = r;
        return { promise, kill: () => { ls.killed += 1; } };
      }
    });
    return { hub, ls };
  };
  const A = mk('1001', 1000);   // 先开
  const B = mk('1002', 2000);   // 后开（started 更大）
  await A.hub.start(); await B.hub.start();
  try {
    const pa = A.hub.ask({ question: 'A 问', options: [{ label: 'x' }] });
    await waitLaunched(A.ls);
    const pb = B.hub.ask({ question: 'B 问', options: [{ label: 'y' }] });
    await waitLaunched(B.ls);

    const sessions = client.listSessions(dir);
    assert.strictEqual(sessions.length, 2);                 // 两个会话各自一份注册项，互不覆盖
    assert.notStrictEqual(sessions[0].socket, sessions[1].socket);

    const dialogs = await client.collectDialogs(sessions.map((s) => s.socket));
    assert.strictEqual(dialogs.length, 2);                  // 跨会话聚合到两轮

    const latest = dialogs.reduce((m, d) => (!m || d.started > m.started ? d : m), null);
    assert.strictEqual(latest.question, 'B 问');            // --latest 跨会话取全局最新（B）

    // 把答案精确投给 B 持有的 socket → 只结算 B，A 不受影响
    const resp = await client.answer(latest.socket, latest.dialog_id, '选 y');
    assert.strictEqual(resp.status, 'accepted');
    assert.strictEqual(await pb, '用户回答：选 y（来源：' + SOURCE_CODEX + '）');
    assert.strictEqual(A.hub.list().length, 1);             // A 仍活跃，未被串台

    A.ls.resolve({ code: 0, stdout: JSON.stringify({ action: 'ok', selected: ['x'], other: false, supplement: '' }) });
    await pa;
  } finally { A.hub.stop(); B.hub.stop(); }
});

test('多实例隔离：stop() 删除本会话注册项', async () => {
  const dir = path.join(os.tmpdir(), `adh-reg2-${process.pid}-${++seq}`);
  const reg = path.join(dir, '1.json');
  const { hub, launchState } = harness({ registryPath: reg });
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    assert.ok(fs.existsSync(reg));                          // 活跃期间注册项存在
    hub.stop();                                             // stop 会 _settle 在飞轮次 → p resolve(FALLBACK)
    assert.strictEqual(fs.existsSync(reg), false);          // stop 后注册项被清
    await p;
  } finally { hub.stop(); }
});

test('启动清扫：死 pid 的注册项与 socket 残留被清，活/无权进程的项保留', async () => {
  const dir = path.join(os.tmpdir(), `adh-sweep-${process.pid}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const deadJson = path.join(dir, '99999.json');
  const deadSock = path.join(dir, 'dead.sock');
  fs.writeFileSync(deadSock, 'x');                                  // 占位 socket 文件
  fs.writeFileSync(deadJson, JSON.stringify({ pid: 99999, socket: deadSock, dialogs: [{ dialog_id: 'd', question: 'q', started: 1 }] }));
  const aliveJson = path.join(dir, 'alive.json');
  fs.writeFileSync(aliveJson, JSON.stringify({ pid: process.pid, socket: 'whatever', dialogs: [] }));   // 活进程(本测试自身)→ 保留

  const base = path.join(os.tmpdir(), `adh-sweep-self-${process.pid}-${seq}`);
  const hub = new DialogHub({
    socketPath: base + '.sock', registryPath: path.join(dir, 'self.json'), lockPath: base + '.lock',
    chime: () => {}, launchDialog: () => ({ promise: new Promise(() => {}), kill: () => {} })
  });
  await hub.start();
  try {
    assert.strictEqual(fs.existsSync(deadJson), false, '死 pid 注册项应被清');
    assert.strictEqual(fs.existsSync(deadSock), false, '死 pid 的 socket 文件应被清');
    assert.strictEqual(fs.existsSync(aliveJson), true, '活进程的注册项必须保留');
  } finally { hub.stop(); }
});

test('空答案被拒：Codex 提交空串返回 empty，不结算', async () => {
  const { hub, launchState } = harness();
  await hub.start();
  try {
    const p = hub.ask(choiceArgs);
    await waitLaunched(launchState);
    const id = hub.list()[0].dialog_id;
    const r = await client.answer(hub.socketPath, id, '   ');
    assert.strictEqual(r.status, 'empty');
    assert.strictEqual(hub.list().length, 1);               // 仍活跃
    assert.strictEqual(launchState.killed, 0);              // 未关窗

    launchState.resolve({ code: 0, stdout: JSON.stringify({ action: 'ok', selected: ['A'], other: false, supplement: '' }) });
    await p;                                                 // 本机收尾
  } finally { hub.stop(); }
});
