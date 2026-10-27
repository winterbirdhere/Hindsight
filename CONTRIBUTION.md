# Contributing to Hindsight

Hindsight is based on Rewind by abstrakt. Preserve the original copyright and [MIT license](LICENSE.md), and retain third-party notices. A public contribution destination has not yet been confirmed.

## Windows x64 prerequisites

- Node.js **24.14.x**; the verified baseline is **24.14.0**.
- Yarn Classic **1.22.22**.
- .NET SDK **8.0.423**, selected by `global.json`, for the native performance engine.
- Git LFS only when obtaining optional external integration fixtures.

Use the locked dependencies. `yarn.lock` is authoritative; do not introduce `package-lock.json` or upgrade dependencies as part of an unrelated fix. Packaged users do not need these build tools. Linux and macOS builds remain unvalidated.

## Install, verify and build

The sanitized source snapshot omits held skin payloads and the FFmpeg executable, and does not include a prebuilt native runtime or personal/external fixture data. Installing JavaScript dependencies alone does not make it ready to run or package. Before building, prepare the required resources through the reviewed processes in [desktop development instructions](apps/desktop/DEVELOPMENT.md); the FFmpeg and YUGEN publication holds still apply.

From the source root, after preparing those prerequisites:

```powershell
yarn install --frozen-lockfile --non-interactive
node tools/maintenance/verify-workspace.cjs all --list
npm run verify
npm run build
```

The list command previews checks without executing them. `npm run verify` runs typechecks, lint and the supported desktop/shared Jest suites. Individual commands are `npm run typecheck`, `npm run lint` and `npm test`.

`npm run desktop:compile` builds the native engine and desktop outputs. `npm run build` also packages with publication disabled. Build outputs are generated files, not evidence that the packaged application works. Validate the actual package from a separate location with a fresh profile, including export and restart persistence.

Keep private dotenv/configuration files and credentials out of build inputs. Nx 14 can load dotenv files, so a release build must use reviewed sanitized inputs and environment rather than assuming that an output-directory override isolates it.

## Development

Start the frontend, then Electron in a second terminal:

```powershell
yarn desktop-frontend:dev
yarn desktop-main:dev
```

Restart the main process after main-process changes. The codebase uses Nx: `apps` contains applications, `libs` shared modules, and `engine` the native helper. Keep unit tests beside the code as `*.spec.ts` or `*.spec.tsx`. Tests requiring external reference data live under `tests`.

The supported default checks do not require opening the application. `npm run test:legacy` selects separate archived/reference-data suites. The `abstrakt8/osu-testdata` entry in `.gitmodules` is a development fixture dependency, not a Hindsight support or download destination. Fixture tests require their recorded revision, Git LFS objects and generated reference data; report missing inputs instead of weakening expectations. See [integration-test instructions](tests/game-simulation/README.md).

`npm run build-storybook` creates component-story output. Interactive Storybook remains unsupported with the current React/Storybook combination; a successful static build is not an interactive UI pass.

## Review and preview preparation

Include a concise description of the problem, resulting behavior, checks run and remaining limits. Preserve replay order, scoring/ruleset handling, persisted keys and profile separation. Back up data before tests that change a profile; use synthetic or explicitly permitted fixtures in reports.

Local builds do not authorize a release. Preview CI must remain manual and non-publishing. Do not rely on a version tag to publish. Publication requires owner review of the source allowlist, binary manifest, license materials, candidate QA, checksums and destination. See [known limitations](KNOWN-LIMITATIONS.md) for the current publication holds.

## Reproducing this independent preview

The product version is 0.1.0-preview.1 in package.json. Changing it requires fresh packaged application metadata and Windows executable version resources; renaming an existing package is insufficient. The native helper retains its independent assembly identity. Preserve dev.hindsight.app, profile locations and schema/protocol/cache versions.

Use independent node_modules and caches for a release workspace. Set task-local YARN_CACHE_FOLDER, ELECTRON_CACHE, ELECTRON_BUILDER_CACHE, NUGET_PACKAGES, DOTNET_CLI_HOME, NX_CACHE_DIRECTORY, TEMP and TMP before restoration/builds; disable the Nx daemon and do not point at another workspace's writable caches. Run the pinned Yarn Classic executable rather than installing or upgrading a system tool. Preserve yarn.lock and native packages.lock.json; restores must use locked versions.

The manual workflow uses contents:read and --publish never. It cannot complete packaging from this sanitized source alone until the omitted held inputs are supplied with appropriate rights. Ordinary package configuration includes third-party supplements, and public binary delivery still requires the FFmpeg/YUGEN decisions in ASSET-LICENSING.md. Local release reports, handoff manifests, profiles and compiled output are not public source. SOURCE-MANIFEST.json is an immutable inherited R11 inventory, not a manifest of later edits; derived artifacts receive separately generated inventories.

The inherited .gitattributes policy still uses Git LFS for images. Source publication revision 2 removes two inherited pointer-only files after reference review: apps/desktop/frontend/src/assets/mod_hidden.png (unused copied asset) and tools/electron-builder/build-resources/icon.png (unused by the supported Windows icon path; dormant fallback for unvalidated platforms). Their actual objects were not recovered or substituted. See PREVIEW-NOTES.md for the exact change record.

All remaining published image payloads must have real local bytes and pass normal Git LFS object/pointer checks; keep the normal pre-push hook and upload validation. A source archive carries the actual remaining image bytes. Git checkout requires Git LFS to hydrate those tracked images. These checks do not establish an independently buildable snapshot: held skins, FFmpeg.exe, generated native output and optional external fixtures remain absent.
