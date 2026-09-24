#!/usr/bin/env node
import { Connector } from '../src/connector.js';

function usage() {
  process.stderr.write('Usage: katafit-mcp-connector --relay-url URL --server-id ID --enrollment-token TOKEN -- command [args...]\n');
}

function parseArgs(argv) {
  const options = {};
  let i = 0;
  while (i < argv.length && argv[i] !== '--') {
    const arg = argv[i++];
    if (arg === '--relay-url') options.relayUrl = argv[i++];
    else if (arg === '--server-id') options.serverId = argv[i++];
    else if (arg === '--enrollment-token') options.enrollmentToken = argv[i++];
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
if (!options.relayUrl || !options.serverId || !options.enrollmentToken || !command) { usage(); process.exitCode = 2; }
else {
  const connector = new Connector({ ...options, command, args });
  connector.on('error', () => process.stderr.write('katafit connector: connection error; retrying\n'));
  connector.start().catch(() => { process.stderr.write('katafit connector: failed to start\n'); process.exitCode = 1; });
  const shutdown = () => connector.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
