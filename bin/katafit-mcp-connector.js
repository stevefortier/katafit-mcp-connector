#!/usr/bin/env node
import { Connector } from '../src/connector.js';
import { CameraTools } from '../src/camera.js';

function usage() {
  process.stderr.write('Usage: katafit-mcp-connector [--camera-device /dev/videoN] --relay-url URL --server-id ID --enrollment-token TOKEN [-- command [args...]]\n');
}

function parseArgs(argv) {
  const options = { cameraDevices: [] };
  let i = 0;
  while (i < argv.length && argv[i] !== '--') {
    const arg = argv[i++];
    if (arg === '--relay-url') options.relayUrl = argv[i++];
    else if (arg === '--server-id') options.serverId = argv[i++];
    else if (arg === '--enrollment-token') options.enrollmentToken = argv[i++];
    else if (arg === '--camera-device') options.cameraDevices.push(argv[i++]);
    else if (arg === '--client-name') options.clientName = argv[i++];
    else if (arg === '--heartbeat-ms') options.heartbeatMs = Number(argv[i++]);
    else { usage(); throw new Error(`Unknown option: ${arg}`); }
  }
  if (argv[i] === '--') i += 1;
  return { options, command: argv[i], args: argv.slice(i + 1) };
}

const { options, command, args } = parseArgs(process.argv.slice(2));
options.relayUrl ||= process.env.KATAFIT_RELAY_URL;
options.serverId ||= process.env.KATAFIT_SERVER_ID;
options.enrollmentToken ||= process.env.KATAFIT_ENROLLMENT_TOKEN;
options.clientName ||= process.env.KATAFIT_CLIENT_NAME;
if (!options.relayUrl || !options.serverId || !options.enrollmentToken || (!command && !options.cameraDevices.length)) { usage(); process.exitCode = 2; }
else {
  try {
    options.camera = new CameraTools({ devices: options.cameraDevices });
  } catch {
    process.stderr.write('Invalid camera device selection (Linux /dev/videoN, up to four distinct devices).\n');
    process.exit(2);
  }
  delete options.cameraDevices;
  if (options.camera.listTools().length) process.stderr.write('Webcam snapshots enabled for the selected devices; connected Coaches may request still images. Stop this process to disable access.\n');
  const connector = new Connector({ ...options, command, args });
  connector.on('error', () => process.stderr.write('katafit connector: connection error; retrying\n'));
  options.camera.verifyDevices().then(() => connector.start()).catch(() => { process.stderr.write('katafit connector: camera unavailable or failed to start\n'); process.exitCode = 1; });
  const shutdown = () => connector.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
