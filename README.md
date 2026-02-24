# Obsidian Whisper Local

Obsidian Community Plugin scaffold for local, private live dictation via [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

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

The repository includes helper scripts in `whisper/` for local server setup:

```bash
npm run whisper:setup
npm run whisper:start
npm run whisper:logs
npm run whisper:stop
```

- `whisper:setup` copies `whisper/.env` from `whisper/.env.example`, clones/builds whisper.cpp natively, and downloads the configured model.
- `whisper:start` launches the local `whisper-server` binary using settings from `whisper/.env`.
- `whisper:logs` tails the detached server log file.
- `whisper:stop` stops the detached server using the pid file.
- Detached mode is enabled by default (`WHISPER_DETACH=1`). Set `WHISPER_DETACH=0` to run in the foreground.

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

## Next milestone

- Add integration tests that mock transcription responses against editor insertion behavior.
- Add status bar state for active dictation and queued utterances.
