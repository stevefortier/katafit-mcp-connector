import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import Ws, { WebSocketServer } from 'ws';
import { Connector } from '../src/connector.js';
import { CameraTools } from '../src/camera.js';

function nextMessage(socket, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error('WebSocket response timed out')); }, timeout);
    function onMessage(raw) { clearTimeout(timer); resolve(JSON.parse(raw.toString())); }
    socket.once('message', onMessage);
  });
}

test('real loopback WebSocket transports a bounded synthetic ffmpeg camera JPEG with matching relay request_id', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 256 * 1024 });
  await new Promise(resolve => server.once('listening', resolve));
  const camera = new CameraTools({ devices: ['/dev/video0'], platform: 'linux',
    stat: async () => ({ isCharacterDevice: () => true }),
    spawn: (_bin, _args, options) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', '-q:v', '8', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], options) });
  const connector = new Connector({ relayUrl: `ws://127.0.0.1:${server.address().port}`, serverId: 'synthetic-server', enrollmentToken: 'synthetic-token', camera });
  try {
    const connected = new Promise(resolve => server.once('connection', resolve));
    await connector.start();
    const socket = await connected;
    assert.equal((await nextMessage(socket)).type, 'register');
    socket.send(JSON.stringify({ type: 'registered', connection_id: 'synthetic-connection', session_token: 'synthetic-session' }));
    socket.send(JSON.stringify({ type: 'mcp', request_id: 'discover', payload: { method: 'tools/list' } }));
    const discovered = await nextMessage(socket);
    assert.equal(discovered.request_id, 'discover');
    assert.equal(discovered.payload.result.tools[0].name, 'katafit_camera_snapshot');
    socket.send(JSON.stringify({ type: 'mcp', request_id: 'snapshot', payload: { method: 'tools/call', params: { name: 'katafit_camera_snapshot', arguments: { camera: 'camera_1' } } } }));
    const response = await nextMessage(socket);
    assert.equal(response.request_id, 'snapshot');
    const image = response.payload.result.content[0];
    assert.equal(image.mimeType, 'image/jpeg');
    const decoded = Buffer.from(image.data, 'base64');
    assert.equal(decoded.subarray(0, 2).toString('hex'), 'ffd8');
    assert.ok(decoded.length < 120_000);
  } finally {
    await connector.stop();
    await new Promise(resolve => server.close(resolve));
  }
});
