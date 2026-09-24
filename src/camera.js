import { spawn as nodeSpawn } from 'node:child_process';
import { lstat as nodeLstat } from 'node:fs/promises';

export const CAMERA_TOOL_NAME = 'katafit_camera_snapshot';
const MAX_JPEG_BYTES = 120_000; // Base64 plus JSON envelope stays below Kata.fit's 256 KiB relay cap.
const CAPTURE_TIMEOUT_MS = 5_000;

export class CameraTools {
  constructor({ devices = [], platform = process.platform, spawn = nodeSpawn, stat = nodeLstat } = {}) {
    if (!Array.isArray(devices) || devices.length > 4 || new Set(devices).size !== devices.length) throw new Error('Invalid camera device list');
    if (devices.length && platform !== 'linux') throw new Error('Webcam capture currently supports Linux only');
    if (devices.some(device => typeof device !== 'string' || !/^\/dev\/video(?:0|[1-9]\d*)$/.test(device))) throw new Error('Invalid camera device path');
    this.devices = [...devices];
    this.spawn = spawn;
    this.stat = stat;
    this.busy = false;
    this.captureGeneration = 0;
    this.abortCurrent = null;
  }

  cancelCurrent() {
    this.captureGeneration += 1;
    this.abortCurrent?.();
  }

  async verifyDevices(devices = this.devices) {
    for (const device of devices) {
      let info;
      try { info = await this.stat(device); } catch { throw new Error('Camera device unavailable'); }
      if (!info.isCharacterDevice()) throw new Error('Camera device unavailable');
    }
  }

  listTools() {
    if (!this.devices.length) return [];
    return [{
      name: CAMERA_TOOL_NAME,
      description: 'Capture one current still JPEG from a webcam explicitly enabled by the device owner. The image may contain people and private surroundings; use only when needed for the user request.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { camera_id: { type: 'string', enum: this.devices.map((_, index) => `camera_${index + 1}`), description: 'The enabled camera to capture.' } },
        required: ['camera_id'],
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    }];
  }

  async callTool(name, args) {
    if (name !== CAMERA_TOOL_NAME || !this.devices.length) throw new Error('Camera tool not enabled');
    const match = /^camera_([1-4])$/.exec(args?.camera_id || '');
    const device = match && this.devices[Number(match[1]) - 1];
    if (!device || Object.keys(args).some(key => key !== 'camera_id')) throw new Error('Camera not enabled');
    if (this.busy) throw new Error('Camera capture already in progress');
    this.busy = true;
    const generation = this.captureGeneration;
    try {
      await this.verifyDevices([device]);
      if (generation !== this.captureGeneration) throw new Error('Camera capture cancelled');
      const bytes = await this.#capture(device);
      return { content: [{ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }] };
    } finally {
      this.busy = false;
    }
  }

  #capture(device) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'video4linux2', '-video_size', '320x240', '-i', device, '-frames:v', '1', '-q:v', '8', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
          { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      } catch { reject(new Error('Camera capture failed')); return; }
      let settled = false;
      const chunks = [];
      let total = 0;
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Camera capture timed out')); }, CAPTURE_TIMEOUT_MS);
      const finish = (error, bytes) => {
        if (settled) return;
        settled = true;
        this.abortCurrent = null;
        clearTimeout(timer);
        if (error) reject(error); else resolve(bytes);
      };
      this.abortCurrent = () => {
        finish(new Error('Camera capture cancelled'));
        try { child.kill('SIGKILL'); } catch {}
      };
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_JPEG_BYTES) { child.kill('SIGKILL'); finish(new Error('Camera capture too large')); return; }
        chunks.push(chunk);
      });
      child.on('error', () => finish(new Error('Camera capture failed')));
      child.on('close', code => {
        const bytes = Buffer.concat(chunks);
        if (code !== 0 || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
          finish(new Error('Camera capture failed')); return;
        }
        finish(null, bytes);
      });
    });
  }
}
