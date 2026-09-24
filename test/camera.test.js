import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CameraTools } from '../src/camera.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

function fakeCapture(bytes = JPEG) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => { child.stdout.emit('data', bytes); child.emit('close', 0); });
  return child;
}

test('explicit camera allowlist exposes only selected devices and returns one JPEG image', async () => {
  const invoked = [];
  const camera = new CameraTools({ devices: ['/dev/video0', '/dev/video2'], platform: 'linux',
    stat: async () => ({ isCharacterDevice: () => true }),
    spawn: (bin, args, opts) => { invoked.push({ bin, args, opts }); return fakeCapture(); } });
  assert.equal(camera.listTools().length, 1);
  const result = await camera.callTool('katafit_camera_snapshot', { camera: 'camera_2' });
  assert.deepEqual(result, { content: [{ type: 'image', mimeType: 'image/jpeg', data: JPEG.toString('base64') }] });
  assert.equal(invoked.length, 1);
  assert.ok(invoked[0].args.includes('/dev/video2'));
  assert.ok(!invoked[0].args.includes('/dev/video0'));
  assert.equal(invoked[0].opts.shell, false);
  await assert.rejects(camera.callTool('katafit_camera_snapshot', { camera: '/dev/video1' }), /not enabled/);
});

test('camera disabled by default and invalid device paths fail closed', async () => {
  assert.deepEqual(new CameraTools().listTools(), []);
  assert.throws(() => new CameraTools({ devices: ['file:///tmp/photo.jpg'], platform: 'linux' }), /device/);
  assert.throws(() => new CameraTools({ devices: ['/dev/video0'], platform: 'darwin' }), /Linux/);
});

test('non-character devices are rejected before any capture subprocess starts', async () => {
  let spawned = false;
  const camera = new CameraTools({ devices: ['/dev/video0'], platform: 'linux',
    stat: async () => ({ isCharacterDevice: () => false }), spawn: () => { spawned = true; return fakeCapture(); } });
  await assert.rejects(camera.verifyDevices(), /unavailable/);
  assert.equal(spawned, false);
});

test('oversized and non-JPEG capture fails without image output', async () => {
  for (const bytes of [Buffer.alloc(1_100_000), Buffer.from('not a jpeg')]) {
    const camera = new CameraTools({ devices: ['/dev/video0'], platform: 'linux',
      stat: async () => ({ isCharacterDevice: () => true }), spawn: () => fakeCapture(bytes) });
    await assert.rejects(camera.callTool('katafit_camera_snapshot', { camera: 'camera_1' }), /capture/);
  }
});
