# Obsidian Whisper Local

Obsidian plugin for local, private live dictation via [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

![whisperlocal](https://github.com/user-attachments/assets/ed9632a0-2c6e-4eec-8e22-686122f23d5c)

## Prerequisites

- macOS
- Node.js 18+ and npm
- A local whisper runtime. This repo now delegates runtime setup to the shared sibling repo `~/repos/personal/whisper-local-runtime` by default.

## Quick start (unpublished plugin)

1. Clone and build this plugin:

```bash
git clone <repo-url>
cd obsidian-whisper-local
npm install
npm run build
```

2. Clone or create the shared runtime repo alongside it:

```bash
cd ~/repos/personal
git clone <runtime-repo-url> whisper-local-runtime
cd whisper-local-runtime
npm run whisper:setup
npm run whisper:start
```

Default runtime URL:

```text
http://127.0.0.1:8080
```

3. Install the plugin into your vault:

```bash
mkdir -p "/path/to/YourVault/.obsidian/plugins"
ln -s "$(pwd)" "/path/to/YourVault/.obsidian/plugins/obsidian-whisper-local"
```

4. In Obsidian, open **Settings -> Community plugins**:
- Disable restricted mode if needed.
- Enable `Whisper Local`.

5. Plugin settings are usable out of the box:
- Base URL: `http://127.0.0.1:8080`
- Language: `en`

Only change these in **Settings -> Community plugins -> Whisper Local** if your setup differs.

6. Use commands:
- `Whisper Local: Start live dictation`
- `Whisper Local: Stop live dictation`

## Shared runtime commands

This repo still exposes the same npm commands, but they delegate to the shared runtime repo:

```bash
npm run whisper:setup
npm run whisper:start
npm run whisper:stop
npm run whisper:status
npm run whisper:logs
npm run whisper:install-service
npm run whisper:uninstall
```

By default they look for `../whisper-local-runtime`. Override with `WHISPER_RUNTIME_REPO=/custom/path/to/whisper-local-runtime` if needed.

## Architecture

### Folder map

- `src/main.ts`
  - Plugin entrypoint and composition root.
  - Registers commands and settings UI.
- `src/settings.ts`
  - Settings model, defaults, and normalization.
- `src/whispercpp-dictation.ts`
  - Client-side microphone capture, VAD segmentation, and live transcription orchestration.
- `src/whispercpp-http.ts`
  - whisper.cpp HTTP endpoint helpers and multipart WAV transcription request builder.
- `src/transcript-normalization.ts`
  - Transcript cleanup and stabilization helpers.
- `src/mutable-tail-widget.ts`
  - CodeMirror extension for rendering provisional transcript tail text.
- `src/whispercpp-diagnostics.ts`
  - Connectivity and compatibility checks for whisper.cpp endpoints and browser capabilities.
- `whisper/`
  - Thin delegation scripts that forward runtime commands to the shared whisper runtime repo.
- `tests/`
  - Node test runner suites for unit/integration tests.
