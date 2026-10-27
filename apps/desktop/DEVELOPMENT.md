# Run Hindsight from source

The desktop application uses Electron for local replay access and native helpers. Opening the frontend development server in a regular browser does not run the full application. Windows x64 is the supported development target; see [CONTRIBUTION.md](../../CONTRIBUTION.md) for pinned prerequisites and checks.

## Prepare the inputs

From the source root, install the locked dependencies with `yarn install --frozen-lockfile --non-interactive`. Use Node.js 24.14.x, Yarn Classic 1.22.22 and .NET SDK 8.0.423. Keep private environment files and credentials out of release-build inputs.

A sanitized source snapshot does not necessarily include runtime binaries, skin payloads, personal replays or external integration fixtures. Dependency installation alone does not supply all application resources:

- Build the native helper with `npm run performance:build`; it produces `resources/performance-engine` using the declared native dependencies and SDK.
- Development reads skin resources from `resources/Skins`. Check that the required assets are present and properly licensed; do not assume a source-only snapshot includes them or treat Git LFS pointer text as image/audio data.
- Clip export requires the pinned Windows x64 media runtime under `resources/clip-media`. Its metadata and preparation script describe the expected version and hashes. A source-only snapshot may omit the executable. Obtain it only through the reviewed preparation process and preserve its applicable notices; public redistribution still requires the corresponding-source/build arrangement described in [known limitations](../../KNOWN-LIMITATIONS.md).
- Supply your own accessible replay and matching beatmap/media. Legacy fixture suites have additional inputs described in CONTRIBUTION.md.

Do not substitute arbitrary helper or FFmpeg versions to hide missing inputs. Build/setup failures should identify the missing resource; they are not evidence that a source snapshot contains a complete runtime package.

## Start the desktop application

Close Hindsight normally before starting another instance. In PowerShell, with the source root as the working directory, run:

```powershell
npm run desktop-frontend:dev
```

Keep that terminal open. When the frontend has compiled, open a second terminal at the same source root and run:

```powershell
npm run desktop-main:dev
```

The second command compiles the main process, prepares Hindsight's application metadata in the output directory and launches that directory through the installed Electron runtime. Use this directory launch so Electron receives the application metadata. The desktop window uses the development server on port 4200.

First setup requires the osu!stable installation folder containing `osu!.db`, `scores.db` and `Skins`, with accessible beatmaps. Replays is optional. Use **Setup help** for custom locations. Lazer library sources are configured separately in the library. Open a replay through **F2** or drop it onto Hindsight.

Frontend changes reload through the development server; use Ctrl+R in Hindsight when a full refresh is needed. After main-process changes, close Hindsight and rerun `npm run desktop-main:dev`. Stop the frontend with Ctrl+C when finished.

## Data and verification

Ordinary source development retains `%APPDATA%\rewind`; the packaged application defaults to `%APPDATA%\Hindsight`. Explicit custom profile and session-data paths remain authoritative. These stores are separate and are not automatically merged. Back up the full application-data directory and any separate session-data directory with Hindsight closed; see [data and backup guidance](../../DATA-AND-BACKUP.md).

Run `npm run verify` for the supported headless checks. `npm run desktop:compile` compiles the native and desktop outputs; `npm run build` also packages with publication disabled. Neither a development launch nor successful compilation replaces testing the actual self-contained packaged candidate from a separate location. See [known limitations](../../KNOWN-LIMITATIONS.md) for outstanding candidate, performance and distribution gates.
