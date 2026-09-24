import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('../bin/katafit-mcp-connector.js', import.meta.url).pathname;

test('camera is opt-in and invalid device path fails before connection', () => {
  const env = { ...process.env, KATAFIT_RELAY_URL: 'ws://127.0.0.1:1', KATAFIT_SERVER_ID: 'server', KATAFIT_ENROLLMENT_TOKEN: 'synthetic-secret' };
  const absent = spawnSync(process.execPath, [cli], { env, encoding: 'utf8', timeout: 2000 });
  assert.equal(absent.status, 2);
  const invalid = spawnSync(process.execPath, [cli, '--camera-device', '/tmp/other-file'], { env, encoding: 'utf8', timeout: 2000 });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /camera device/i);
  assert.doesNotMatch(invalid.stderr, /synthetic-secret/);
});
