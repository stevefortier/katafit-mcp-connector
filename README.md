# Kata.fit MCP Connector

Standalone CLI that keeps a local MCP server private while making it available to a Kata.fit relay over an outbound WebSocket connection.

## Install

On the computer running your MCP server, install Node.js 22+ and Git, then clone this public repository (no GitHub account required):

```sh
git clone https://github.com/stevefortier/katafit-mcp-connector.git
cd katafit-mcp-connector
npm ci
```

The connector is not published to npm. Only download it from this repository; do not install a similarly named third-party package.

## Run

In Kata.fit profile settings → Personal MCP servers, name the server and register it. The token is displayed only in that browser session. From the connector directory, in Bash:

```sh
export KATAFIT_RELAY_URL='wss://<the relay URL displayed in settings>'
export KATAFIT_SERVER_ID='<the server ID displayed in settings>'
read -r -s -p 'Paste the one-time token: ' KATAFIT_ENROLLMENT_TOKEN; printf '\n'
export KATAFIT_ENROLLMENT_TOKEN
node bin/katafit-mcp-connector.js -- npx -y @modelcontextprotocol/server-filesystem /private/path
```

Replace the example MCP command with the local server you actually intend to expose, and be deliberate about its read/write scope. The token is requested without placing it in shell history or a command-line argument; the connector strips its relay credential variables from the spawned MCP server's environment. Do not put it in a file, chat message, or screenshot. In-memory session credentials permit reconnection after a network interruption **while this connector process is running**. Once it exits, the original enrollment token is spent; remove the registration in Kata.fit and create a new token to start a new process. `Connected` proves only the relay transport, not a successful Coach tool call. No public inbound port is needed.

The same values can be supplied with `--relay-url`, `--server-id`, and `--enrollment-token` (avoid passing secrets as CLI arguments), or with the corresponding `KATAFIT_RELAY_URL`, `KATAFIT_SERVER_ID`, and `KATAFIT_ENROLLMENT_TOKEN` environment variables.

## Optional embedded webcam snapshots (Linux)

**Off by default.** On Linux, install `ffmpeg` and identify your video capture device(s) (for example `v4l2-ctl --list-devices` from `v4l-utils`, then check which `/dev/videoN` captures an image). Give the connector explicit access to only the devices you choose:

```sh
# After setting KATAFIT_RELAY_URL, KATAFIT_SERVER_ID and KATAFIT_ENROLLMENT_TOKEN as above:
node bin/katafit-mcp-connector.js --camera-device /dev/video0
# Optional: also expose a second selected camera, alongside your existing MCP server:
node bin/katafit-mcp-connector.js --camera-device /dev/video0 --camera-device /dev/video2 -- <your-mcp-command> [arguments]
```

Use **one** of those launch commands, not both. Register a new personal server in Kata.fit for the camera-only process, or run the combined command under an existing *new* registration. The example token is still entered privately as described above. A connector process uses one registration; it does not register local servers automatically. Never pass your enrollment token on the command line.

The `katafit_camera_snapshot` tool exposes only the selected cameras as `camera_1` through `camera_4`. Each call captures a **single**, low-resolution JPEG (not a live stream), in memory, and sends it across the outbound relay to Kata.fit; no snapshot is saved to disk by the connector. The call is bounded by a short timeout and the relay size limit. A camera light may turn on while capturing. The connector makes the tool callable without per-snapshot confirmation after you enable it: **your personal Coach and your current Dojo Coach may request images that include people or your surroundings**. Do not enable a camera where bystanders may be filmed without their consent. To revoke future capture, stop the connector and remove its server registration in Kata.fit. The device OS may also require video-device permissions. This release supports Linux V4L2 `/dev/videoN` devices only; macOS, Windows, mobile, browser permission dialogs and streaming video are not supported. A `Connected` transport badge is not proof that the Coach can see the image: the app's image-result consumption must be verified separately.

## Relay protocol

1. Connector opens the configured WebSocket.
2. On the first `open`, it sends a registration frame:

   ```json
   {"type":"register","server_id":"...","enrollment_token":"...","client_name":"...","protocol_version":"1"}
   ```

3. Relay confirms registration with a connection ID and an in-memory session token. On network reconnect the connector sends `resume` with its server ID and session token instead of spending the enrollment token again.
4. After registration, MCP JSON-RPC objects flow in an explicit envelope. A relay request supplies `request_id` (its authoritative correlation key) and may omit a JSON-RPC `id`. The connector assigns a local request ID for the MCP server and returns the matching `request_id` on its response:
   - relay → connector: `{"type":"mcp","request_id":"...","payload":{"method":"tools/list"}}`
   - connector → relay: `{"type":"mcp","request_id":"...","payload":{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}}`
5. The connector sends `{"type":"heartbeat"}` at the application heartbeat
   interval (30 seconds by default; use `--heartbeat-ms` to override).

Local MCP stdio uses the MCP `Content-Length` framing. Relay disconnects are
retried with exponential backoff from 1 second through 30 seconds. The local
server process remains running while the relay reconnects.

## Development

```sh
npm test
```

Tests use an in-memory fake relay socket and fake child process, and cover
registration, bidirectional framing, registration-gated heartbeats, reconnect
backoff, and token non-disclosure.
