import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import Ws from 'ws';

const PROTOCOL_VERSION = '1';

export function encodeMcpMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

export class StdioMessageParser extends EventEmitter {
  constructor() { super(); this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString('utf8');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*$/i);
      if (!match) { this.emit('error', new Error('Invalid MCP stdio header')); return; }
      const length = Number(match[1]);
      const start = separator + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      try { this.emit('message', JSON.parse(body)); }
      catch { this.emit('error', new Error('Invalid JSON from MCP server')); }
    }
  }
}

export class Connector extends EventEmitter {
  constructor(options) {
    super();
    if (!options?.relayUrl || !options.enrollmentToken) throw new Error('relayUrl and enrollmentToken are required');
    this.relayUrl = options.relayUrl;
    this.serverId = options.serverId;
    this.enrollmentToken = options.enrollmentToken;
    this.sessionToken = null;
    this.clientName = options.clientName || 'katafit-mcp-connector';
    this.protocolVersion = options.protocolVersion || PROTOCOL_VERSION;
    this.WebSocket = options.WebSocket || Ws;
    this.spawn = options.spawn || nodeSpawn;
    this.command = options.command;
    this.args = options.args || [];
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.backoff = { minMs: 1_000, maxMs: 30_000, ...(options.reconnect || {}) };
    this.logger = options.logger || console;
    this.child = options.child || null;
    this.socket = null;
    this.registered = false;
    this.stopped = true;
    this.retryMs = this.backoff.minMs;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.parser = new StdioMessageParser();
    this.parser.on('message', message => this.#sendMcp(message));
    this.parser.on('error', error => this.emit('error', error));
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.child) {
      if (!this.command) throw new Error('command is required');
      // The local MCP is untrusted relative to connector enrollment credentials.
      // Keep its normal environment, but never hand it relay authentication secrets.
      const childEnv = { ...process.env };
      delete childEnv.KATAFIT_ENROLLMENT_TOKEN;
      delete childEnv.KATAFIT_SESSION_TOKEN;
      this.child = this.spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'inherit'], env: childEnv });
    }
    this.child.stdout.on('data', chunk => this.parser.push(chunk));
    this.child.on?.('exit', () => { if (!this.stopped) this.#scheduleReconnect(); });
    this.#connect();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = this.heartbeatTimer = null;
    if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
    if (this.child?.kill) this.child.kill();
  }

  #connect() {
    if (this.stopped) return;
    const socket = new this.WebSocket(this.relayUrl);
    this.socket = socket;
    socket.on('open', () => {
      if (socket !== this.socket || this.stopped) return;
      this.registered = false;
      const message = this.sessionToken && this.serverId
        ? { type: 'resume', server_id: this.serverId, session_token: this.sessionToken, client_name: this.clientName, protocol_version: this.protocolVersion }
        : { type: 'register', ...(this.serverId ? { server_id: this.serverId } : {}), enrollment_token: this.enrollmentToken, client_name: this.clientName, protocol_version: this.protocolVersion };
      socket.send(JSON.stringify(message));
    });
    socket.on('message', raw => this.#receive(raw));
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.registered = false;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.#scheduleReconnect();
    });
    socket.on('error', error => this.emit('error', error));
  }

  #receive(raw) {
    let message;
    try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.data?.toString?.() || String(raw)); }
    catch { this.emit('error', new Error('Invalid JSON from relay')); return; }
    if (message.type === 'registered' && typeof message.connection_id === 'string') {
      if (typeof message.session_token === 'string' && message.session_token) this.sessionToken = message.session_token;
      this.registered = true;
      this.retryMs = this.backoff.minMs;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.#send({ type: 'heartbeat' }), this.heartbeatMs);
      this.emit('registered', message.connection_id);
    } else if (message.type === 'mcp' && message.payload && this.registered) {
      this.child.stdin.write(encodeMcpMessage(message.payload));
    }
  }

  #sendMcp(payload) { if (this.registered) this.#send({ type: 'mcp', payload }); }
  #send(message) { if (this.socket?.readyState === this.WebSocket.OPEN || this.socket?.readyState === 1) this.socket.send(JSON.stringify(message)); }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
      this.retryMs = Math.min(this.backoff.maxMs, Math.max(this.backoff.minMs, this.retryMs * 2));
    }, this.retryMs);
  }
}
