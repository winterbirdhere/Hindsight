# Rewind desktop

The Electron main process starts in `main/src/index.ts`. It creates the application window and handles operating-system integration and the native performance worker.

The React/Pixi renderer starts in `frontend/src/main.tsx`. It loads replays and renders playback, timing analysis and comparison controls. Shared logic lives under `libs/`; the separately runnable web backend is not part of desktop startup.

Run `npm run desktop:compile` from the repository root to build the native engine and both desktop projects. `npm run build` also packages the current Windows x64 application into `dist/electron`. See [CONTRIBUTION.md](../../CONTRIBUTION.md) for pinned prerequisites and verification commands.
