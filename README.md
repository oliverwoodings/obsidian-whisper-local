# Obsidian Whisper Local

Obsidian plugin for local, private live dictation via [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

## Prerequisites

- macOS (whisper service management in this repo uses `launchd`)
- Node.js 18+ and npm
- CMake
- Git
- curl

## Quick start (unpublished plugin)

This plugin is not published in Obsidian Community Plugins yet, so install it manually.

1. Clone this repository and build the plugin:

```bash
git clone <repo-url>
cd obsidian-whisper-local
npm install
npm run build
```

2. Install into your vault's plugins folder (use your vault path):

```bash
mkdir -p "/path/to/YourVault/.obsidian/plugins"
ln -s "$(pwd)" "/path/to/YourVault/.obsidian/plugins/obsidian-whisper-local"
```

3. In Obsidian, open **Settings -> Community plugins**:
- Disable restricted mode if needed.
- Enable `Whisper Local`.

4. Set up and start local whisper.cpp (macOS):

```bash
npm run whisper:setup
npm run whisper:start
```

5. Plugin settings are usable out of the box (defaults):
- Base URL: `http://127.0.0.1:8080`
- Language: `en`

Only change these in **Settings -> Community plugins -> Whisper Local** if your setup differs (for example, different port or language).

6. Use commands:
- `Whisper Local: Start live dictation`
- `Whisper Local: Stop live dictation`

Or use the ribbon button to toggle live dictation on/off.

Optional: bind these commands to hotkeys in **Settings -> Hotkeys** for faster start/stop control.

## Development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Local whisper.cpp setup

The repository includes helper scripts in `whisper/` for local server setup on macOS:

```bash
npm run whisper:setup
npm run whisper:start
npm run whisper:stop
npm run whisper:status
npm run whisper:logs
npm run whisper:install-service
npm run whisper:uninstall
```

- `whisper:setup` copies `whisper/.env` from `whisper/.env.example`, clones/builds whisper.cpp natively, downloads the configured model, and installs a macOS `launchd` service.
- `whisper:start` starts the `launchd` service.
- `whisper:stop` stops the `launchd` service.
- `whisper:status` prints `launchd` service status.
- `whisper:logs` tails service stdout/stderr logs configured in `whisper/.env`.
- `whisper:install-service` rewrites/reinstalls the `launchd` plist from current `.env` values.
- `whisper:uninstall` unloads and removes the `launchd` service plist.
- Service defaults are generic and user-portable (`$HOME/Library/LaunchAgents/...`), and can be changed via `whisper/.env`.

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
- `src/whispercpp-diagnostics.ts`
  - Connectivity and compatibility checks for whisper.cpp endpoints and local runtime prerequisites.
- `whisper/`
  - Local whisper.cpp server helper scripts and environment-based configuration (`.env`).
- `tests/`
  - Node test runner suites for unit/integration tests.

### Dependency direction

- `src/main.ts` may import from `src/settings.ts`.
- `src/main.ts` may import from `src/whispercpp-dictation.ts`.
- `src/main.ts` may import from `src/whispercpp-diagnostics.ts`.
- `src/whispercpp-dictation.ts` may import from `src/whispercpp-http.ts`.
- `src/whispercpp-diagnostics.ts` may import from `src/whispercpp-http.ts`.
- `src/settings.ts` should stay framework-light and focus on data normalization.

### Runtime flow

1. Obsidian loads the plugin entrypoint (`src/main.ts`).
2. Settings are loaded and normalized.
3. Commands and settings tab are registered.
4. Starting live dictation captures microphone audio in-browser.
5. The dictation session applies lightweight VAD to segment utterances.
6. Segments are sent to `whisper.cpp` `/inference` as WAV multipart requests.
7. Completed transcript chunks are inserted at the current cursor location in the active note editor.
8. Diagnostics can be run from settings or command palette to validate endpoint health, inference readiness, and browser capabilities.
