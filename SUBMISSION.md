### Repository URL

https://github.com/kattsushi/omarchy-gentle-dot

### Category

AI

### Tags

ai, chat, gentle-dot, quickshell, voice

### Suggest a missing tag

_No response_

### Maintainer notes

A client for [Gentle Dot](https://github.com/Gentleman-Programming/gentle-dot): it requires a running Gentle Dot daemon, on this machine (`ws://127.0.0.1:4317/ws`) or on another one reachable over the network (for example `wss://` through `tailscale serve`). Without one the panel stays offline. Requires Node.js 22 or newer on `PATH` to run the bundled WebSocket bridge; chat and code highlighting need no `pnpm install` (highlight.js is bundled). Voice dictation is optional: `pnpm install --prod --config.node-linker=hoisted` in the plugin folder installs `sherpa-onnx-node`, and PipeWire's `pw-record` records the microphone.

Network: the plugin only connects to the daemon URL the user configures (WebSocket, attachment upload and download). The Parakeet speech model (487 MB, from the sherpa-onnx GitHub releases) is downloaded only when the user presses Download in Settings → Voice; audio is transcribed on the machine and never sent anywhere. The daemon token is read from a file on every connect and never stored in `shell.json`. The plugin does not change system configuration.

### Submission checklist

- [x] The repository is public and contains installation and removal instructions.
- [x] I have documented the plugin license and any external dependencies.
- [x] I confirm that I own or have permission to submit this plugin and its preview assets.
- [x] The plugin does not overwrite user configuration without explicit consent.
- [x] I understand that approval is for listing and is not a security review.
