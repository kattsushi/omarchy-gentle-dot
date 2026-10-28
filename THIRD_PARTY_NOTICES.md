# Third-party notices

Gentle Dot for Omarchy is released under the MIT License (see [LICENSE](LICENSE)). It bundles,
optionally installs, or downloads on demand the following third-party work, each under its own
license.

## Bundled in this repository

### highlight.js 11.12.0

- Where: `third_party/highlight.js/` (the core and 29 language definitions; see its
  [README](third_party/highlight.js/README.md) for the exact files and the one change made).
- Upstream: https://github.com/highlightjs/highlight.js
- License: BSD-3-Clause. Copyright (c) 2006, Ivan Sagalaev. Full text in
  [third_party/highlight.js/LICENSE](third_party/highlight.js/LICENSE).

## Optional dependency (not bundled)

### sherpa-onnx-node 2.0.1

- Used for: on-device voice transcription. Installed only when you run `pnpm install` in the
  plugin folder; chat works without it.
- Upstream: https://github.com/k2-fsa/sherpa-onnx (npm `sherpa-onnx-node` and its per-platform
  package, such as `sherpa-onnx-linux-x64`).
- License: Apache-2.0. Its platform packages ship native libraries (including ONNX Runtime) under
  their own licenses, included in those packages.

## Downloaded on demand (not bundled)

### NVIDIA Parakeet TDT 0.6B v3 (int8, sherpa-onnx export)

- Used for: the speech model behind voice dictation. Downloaded only when you press
  **Settings → Voice → Download**, from
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
  into `~/.local/share/omarchy-gentle-dot/models/`.
- Original model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- License: CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/), per NVIDIA's model card.

## Original artwork

### Rose icon

- Where: `assets/rose-dualtone-136.png`.
- The author's own artwork, from the Gentleman theme for Omarchy. Covered by this repository's
  MIT License.

## Other assets

- `assets/sounds/wake-silence.oga`: 1.5 s of silence made for this plugin (MIT, like the rest).
- Notification sounds are played from the system's freedesktop sound theme and are not part of
  this repository.
