import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Connector, encodeMcpMessage } from '../src/connector.js';

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  constructor() { super(); this.readyState = FakeSocket.OPEN; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = { writes: [], write: value => { this.stdin.writes.push(value); } };
    this.stdout = new EventEmitter();
    this.kill = () => {};
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('registers with the relay and proxies MCP messages in both directions', async () => {
  const socket = new FakeSocket();
  const child = new FakeChild();
  const connector = new Connector({
    relayUrl: 'wss://relay.test/connect', serverId: 'server-1', enrollmentToken: 'one-time-secret', clientName: 'local',
    WebSocket: class { constructor() { return socket; } },
    spawn: () => child,
    child,
    heartbeatMs: 60_000,
  });

  await connector.start();
  assert.deepEqual(socket.sent, []);
  socket.emit('open');
  assert.deepEqual(socket.sent[0], { type: 'register', server_id: 'server-1', enrollment_token: 'one-time-secret', client_name: 'local', protocol_version: '1' });

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'registered', connection_id: 'conn-1', session_token: 'session-1' })));
  socket.emit('message', JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
  assert.equal(child.stdin.writes.length, 1);
  assert.equal(child.stdin.writes[0], encodeMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

  child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id: 1, result: { tools: [] } })));
  assert.deepEqual(socket.sent.at(-1), { type: 'mcp', payload: { jsonrpc: '2.0', id: 1, result: { tools: [] } } });
  await connector.stop();
});

test('sends application heartbeats only after registration', async () => {
  const socket = new FakeSocket();
  const child = new FakeChild();
  const connector = new Connector({ relayUrl: 'ws://relay', enrollmentToken: 'secret', WebSocket: class { constructor() { return socket; } }, spawn: () => child, child, heartbeatMs: 5 });
  await connector.start(); socket.emit('open');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(socket.sent.filter(m => m.type === 'heartbeat').length, 0);
  socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'x' }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(socket.sent.some(m => m.type === 'heartbeat'));
  await connector.stop();
});

test('reconnects after relay close with bounded backoff', async () => {
  const sockets = [];
  class Socket extends FakeSocket { constructor() { super(); sockets.push(this); } }
  const child = new FakeChild();
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'server-1', enrollmentToken: 'secret', WebSocket: Socket, spawn: () => child, child, reconnect: { minMs: 1, maxMs: 2 }, heartbeatMs: 60_000 });
  await connector.start();
  sockets[0].emit('open');
  sockets[0].emit('close');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  await connector.stop();
});

test('resumes with the issued session token after reconnect', async () => {
  const sockets = [];
  class Socket extends FakeSocket { constructor() { super(); sockets.push(this); } }
  const child = new FakeChild();
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'server-1', enrollmentToken: 'one-time', WebSocket: Socket, spawn: () => child, child, reconnect: { minMs: 1, maxMs: 2 }, heartbeatMs: 60_000 });
  await connector.start();
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify({ type: 'registered', connection_id: 'conn-1', session_token: 'issued-session' }));
  sockets[0].emit('close');
  await new Promise(resolve => setTimeout(resolve, 10));
  sockets[1].emit('open');
  assert.deepEqual(sockets[1].sent[0], { type: 'resume', server_id: 'server-1', session_token: 'issued-session', client_name: 'katafit-mcp-connector', protocol_version: '1' });
  await connector.stop();
});

test('does not pass connector credentials to the local MCP child process', async () => {
  const socket = new FakeSocket();
  const child = new FakeChild();
  let childOptions;
  const previous = process.env.KATAFIT_ENROLLMENT_TOKEN;
  const previousSession = process.env.KATAFIT_SESSION_TOKEN;
  try {
    process.env.KATAFIT_ENROLLMENT_TOKEN = 'one-time-secret';
    process.env.KATAFIT_SESSION_TOKEN = 'relay-session';
    const connector = new Connector({
      relayUrl: 'wss://relay.test/mcp/relay', serverId: 'server-1', enrollmentToken: 'one-time-secret',
      WebSocket: class { constructor() { return socket; } },
      spawn: (command, args, options) => { childOptions = options; return child; },
      command: 'local-mcp', args: []
    });
    await connector.start();
    assert.ok(childOptions?.env);
    assert.equal(childOptions.env.KATAFIT_ENROLLMENT_TOKEN, undefined);
    assert.equal(childOptions.env.KATAFIT_SESSION_TOKEN, undefined);
    assert.equal(childOptions.env.PATH, process.env.PATH);
    assert.equal(process.env.KATAFIT_ENROLLMENT_TOKEN, 'one-time-secret');
    await connector.stop();
  } finally {
    if (previous === undefined) delete process.env.KATAFIT_ENROLLMENT_TOKEN; else process.env.KATAFIT_ENROLLMENT_TOKEN = previous;
    if (previousSession === undefined) delete process.env.KATAFIT_SESSION_TOKEN; else process.env.KATAFIT_SESSION_TOKEN = previousSession;
  }
});

test('does not expose enrollment token in logs', async () => {
  const socket = new FakeSocket(); const child = new FakeChild(); const logs = [];
  const connector = new Connector({ relayUrl: 'ws://relay', enrollmentToken: 'never-log-this', WebSocket: class { constructor() { return socket; } }, spawn: () => child, child, logger: { info: value => logs.push(String(value)), warn: value => logs.push(String(value)), error: value => logs.push(String(value)) } });
  await connector.start(); socket.emit('open'); socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'id' })); await connector.stop();
  assert.equal(logs.some(value => value.includes('never-log-this')), false);
});
