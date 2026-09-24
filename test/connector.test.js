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
  const localId = JSON.parse(child.stdin.writes[0].split('\r\n\r\n')[1]).id;
  assert.ok(localId);

  child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id: localId, result: { tools: [] } })));
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

test('camera-only registration serves MCP discovery and one snapshot without a local child', async () => {
  const socket = new FakeSocket();
  const camera = { listTools: () => [{ name: 'katafit_camera_snapshot', inputSchema: { type: 'object' } }],
    callTool: async () => ({ content: [{ type: 'image', mimeType: 'image/jpeg', data: 'jpeg-base64' }] }) };
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'camera-registration', enrollmentToken: 'secret',
    camera, WebSocket: class { constructor() { return socket; } },
    spawn: () => { throw new Error('unexpected local MCP child'); } });
  await connector.start(); socket.emit('open');
  socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'x' }));
  socket.emit('message', JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }));
  assert.deepEqual(socket.sent.at(-1).payload.result.tools.map(tool => tool.name), ['katafit_camera_snapshot']);
  socket.emit('message', JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'katafit_camera_snapshot', arguments: { camera_id: 'camera_1' } } } }));
  await tick();
  assert.equal(socket.sent.at(-1).payload.result.content[0].type, 'image');
  await connector.stop();
});

test('embedded camera is discoverable alongside a local MCP child without intercepting other tools', async () => {
  const socket = new FakeSocket(); const child = new FakeChild();
  const camera = { listTools: () => [{ name: 'katafit_camera_snapshot', inputSchema: { type: 'object' } }], callTool: async () => ({ content: [] }) };
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'both', enrollmentToken: 'secret', camera,
    WebSocket: class { constructor() { return socket; } }, child });
  await connector.start(); socket.emit('open'); socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'x' }));
  socket.emit('message', JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' } }));
  const listedId = JSON.parse(child.stdin.writes.at(-1).split('\r\n\r\n')[1]).id;
  child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id: listedId, result: { tools: [{ name: 'other_tool' }] } })));
  assert.deepEqual(socket.sent.at(-1).payload.result.tools.map(tool => tool.name), ['other_tool', 'katafit_camera_snapshot']);
  socket.emit('message', JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'other_tool' } } }));
  assert.equal(JSON.parse(child.stdin.writes.at(-1).split('\r\n\r\n')[1]).params.name, 'other_tool');
  await connector.stop();
});

test('camera remains discoverable when the optional local MCP child rejects tools/list', async () => {
  const socket = new FakeSocket(); const child = new FakeChild();
  const camera = { listTools: () => [{ name: 'katafit_camera_snapshot', inputSchema: { type: 'object' } }], callTool: async () => ({ content: [] }) };
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'both', enrollmentToken: 'secret', camera,
    WebSocket: class { constructor() { return socket; } }, child });
  try {
    await connector.start(); socket.emit('open'); socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'x' }));
    socket.emit('message', JSON.stringify({ type: 'mcp', request_id: 'list', payload: { method: 'tools/list' } }));
    const id = JSON.parse(child.stdin.writes.at(-1).split('\r\n\r\n')[1]).id;
    child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Child unavailable' } })));
    assert.deepEqual(socket.sent.at(-1).payload.result.tools.map(tool => tool.name), ['katafit_camera_snapshot']);
  } finally { await connector.stop(); }
});

test('camera-only relay request_id is returned on image response', async () => {
  const socket = new FakeSocket();
  const camera = { listTools: () => [{ name: 'katafit_camera_snapshot' }],
    callTool: async () => ({ content: [{ type: 'image', mimeType: 'image/jpeg', data: 'synthetic-jpeg' }] }) };
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'srv', enrollmentToken: 'secret', camera,
    WebSocket: class { constructor() { return socket; } } });
  try {
    await connector.start(); socket.emit('open'); socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'x' }));
    socket.emit('message', JSON.stringify({ type: 'mcp', request_id: 'discover-1', payload: { method: 'tools/list' } }));
    assert.equal(socket.sent.at(-1).request_id, 'discover-1');
    socket.emit('message', JSON.stringify({ type: 'mcp', request_id: 'capture-1', payload: { method: 'tools/call', params: { name: 'katafit_camera_snapshot', arguments: { camera_id: 'camera_1' } } } }));
    await tick();
    assert.equal(socket.sent.at(-1).request_id, 'capture-1');
    assert.equal(socket.sent.at(-1).payload.result.content[0].type, 'image');
  } finally { await connector.stop(); }
});

test('legacy and relay-correlated calls cannot collide or misattribute responses', async () => {
  const socket = new FakeSocket(); const child = new FakeChild();
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'srv', enrollmentToken: 'secret',
    WebSocket: class { constructor() { return socket; } }, child });
  try {
    await connector.start(); socket.emit('open'); socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'x' }));
    socket.emit('message', JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
    socket.emit('message', JSON.stringify({ type: 'mcp', request_id: 'new', payload: { method: 'ping' } }));
    const ids = child.stdin.writes.map(value => JSON.parse(value.split('\r\n\r\n')[1]).id);
    assert.notEqual(ids[0], ids[1]);
    child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id: ids[0], result: { source: 'legacy' } })));
    assert.equal(socket.sent.at(-1).request_id, undefined);
    assert.equal(socket.sent.at(-1).payload.result.source, 'legacy');
    child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id: ids[1], result: { source: 'relay' } })));
    assert.equal(socket.sent.at(-1).request_id, 'new');
  } finally { await connector.stop(); }
});

test('correlates real relay request_id with a local MCP response lacking an incoming JSON-RPC id', async () => {
  const socket = new FakeSocket(); const child = new FakeChild();
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'srv', enrollmentToken: 'secret',
    WebSocket: class { constructor() { return socket; } }, child });
  try {
    await connector.start(); socket.emit('open'); socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'x' }));
    socket.emit('message', JSON.stringify({ type: 'mcp', request_id: 'relay-123', payload: { method: 'tools/list' } }));
    const sent = child.stdin.writes.at(-1);
    assert.ok(sent);
    const id = JSON.parse(sent.split('\r\n\r\n')[1]).id;
    assert.ok(id !== undefined);
    child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id, result: { tools: [] } })));
    assert.deepEqual(socket.sent.at(-1), { type: 'mcp', request_id: 'relay-123', payload: { jsonrpc: '2.0', id, result: { tools: [] } } });
  } finally { await connector.stop(); }
});

test('late child response for previous relay socket is discarded after reconnect', async () => {
  const sockets = []; const child = new FakeChild();
  class Socket extends FakeSocket { constructor() { super(); sockets.push(this); } }
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'srv', enrollmentToken: 'secret', child,
    WebSocket: Socket, reconnect: { minMs: 1, maxMs: 2 } });
  try {
    await connector.start(); sockets[0].emit('open');
    sockets[0].emit('message', JSON.stringify({ type: 'registered', connection_id: 'old', session_token: 'one' }));
    sockets[0].emit('message', JSON.stringify({ type: 'mcp', request_id: 'old', payload: { method: 'tools/list' } }));
    const oldId = JSON.parse(child.stdin.writes.at(-1).split('\r\n\r\n')[1]).id;
    sockets[0].emit('close');
    await new Promise(resolve => setTimeout(resolve, 10));
    sockets[1].emit('open');
    sockets[1].emit('message', JSON.stringify({ type: 'registered', connection_id: 'new', session_token: 'two' }));
    child.stdout.emit('data', Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id: oldId, result: { private: 'old-photo' } })));
    assert.equal(sockets[1].sent.some(frame => JSON.stringify(frame).includes('old-photo')), false);
  } finally { await connector.stop(); }
});

test('late frames from a replaced relay socket cannot request a new camera capture', async () => {
  const sockets = []; let calls = 0;
  class Socket extends FakeSocket { constructor() { super(); sockets.push(this); } }
  const camera = { listTools: () => [{ name: 'katafit_camera_snapshot' }],
    callTool: async () => { calls++; return { content: [] }; } };
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'srv', enrollmentToken: 'secret', camera,
    WebSocket: Socket, reconnect: { minMs: 1, maxMs: 2 } });
  try {
    await connector.start(); sockets[0].emit('open');
    sockets[0].emit('message', JSON.stringify({ type: 'registered', connection_id: 'old', session_token: 'one' }));
    sockets[0].emit('close');
    await new Promise(resolve => setTimeout(resolve, 10));
    sockets[1].emit('open');
    sockets[1].emit('message', JSON.stringify({ type: 'registered', connection_id: 'new', session_token: 'two' }));
    sockets[0].emit('message', JSON.stringify({ type: 'mcp', request_id: 'stale', payload: { method: 'tools/call', params: { name: 'katafit_camera_snapshot', arguments: { camera_id: 'camera_1' } } } }));
    await tick();
    assert.equal(calls, 0);
  } finally { await connector.stop(); }
});

test('snapshot captured before relay disconnect is not released on a new socket', async () => {
  const sockets = []; let release;
  class Socket extends FakeSocket { constructor() { super(); sockets.push(this); } }
  const camera = { listTools: () => [{ name: 'katafit_camera_snapshot' }],
    callTool: () => new Promise(resolve => { release = resolve; }) };
  const connector = new Connector({ relayUrl: 'ws://relay', serverId: 'srv', enrollmentToken: 'secret', camera,
    WebSocket: Socket, reconnect: { minMs: 1, maxMs: 2 } });
  try {
    await connector.start(); sockets[0].emit('open');
    sockets[0].emit('message', JSON.stringify({ type: 'registered', connection_id: 'old', session_token: 'one' }));
    sockets[0].emit('message', JSON.stringify({ type: 'mcp', request_id: 'old-capture', payload: { method: 'tools/call', params: { name: 'katafit_camera_snapshot', arguments: { camera_id: 'camera_1' } } } }));
    sockets[0].emit('close');
    await new Promise(resolve => setTimeout(resolve, 10));
    sockets[1].emit('open');
    sockets[1].emit('message', JSON.stringify({ type: 'registered', connection_id: 'new', session_token: 'two' }));
    release({ content: [{ type: 'image', data: 'private-photo' }] });
    await tick();
    assert.equal(sockets[1].sent.some(frame => JSON.stringify(frame).includes('private-photo')), false);
  } finally { await connector.stop(); }
});

test('does not expose enrollment token in logs', async () => {
  const socket = new FakeSocket(); const child = new FakeChild(); const logs = [];
  const connector = new Connector({ relayUrl: 'ws://relay', enrollmentToken: 'never-log-this', WebSocket: class { constructor() { return socket; } }, spawn: () => child, child, logger: { info: value => logs.push(String(value)), warn: value => logs.push(String(value)), error: value => logs.push(String(value)) } });
  await connector.start(); socket.emit('open'); socket.emit('message', JSON.stringify({ type: 'registered', connection_id: 'id' })); await connector.stop();
  assert.equal(logs.some(value => value.includes('never-log-this')), false);
});
