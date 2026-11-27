# Contributing to Hindsight

Hindsight is based on Rewind by abstrakt. Preserve the original copyright and [MIT license](LICENSE.md), and retain third-party notices. A public contribution destination has not yet been confirmed.

## Windows x64 prerequisites

- Node.js **24.14.x**; the verified baseline is **24.14.0**.
- Yarn Classic **1.22.22**.
- .NET SDK **8.0.423**, selected by `global.json`, for the native performance engine.
- CMake **3.31.6-msvc6**, Visual Studio 2022 MSVC **19.44.35222** and Windows SDK **10.0.26100.0** to build the native osu!lazer deletion helper. [Native build instructions](tools/performance/realm-no-conversion/README.md)
- Git LFS only when obtaining optional external integration fixtures.

Use the locked dependencies. `yarn.lock` is authoritative; do not introduce `package-lock.json` or upgrade dependencies as part of an unrelated fix. Packaged users do not need these build tools. Linux and macOS builds remain unvalidated.

## Install, verify and build

The source snapshot omits the skin directories, encoder binaries, prebuilt native runtime and personal replay fixtures. Prepare the native helper, skins and media runtime before building the desktop app. The free Windows preview uses the credited YUGEN skin. Its MSYS2 encoder has four matching source downloads and three notice archives, including the LLVM compiler runtime license and credits. [Desktop development instructions](apps/desktop/DEVELOPMENT.md) · [Media distribution materials](resources/clip-media/README.md)

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

## Tests included in this source snapshot

The public snapshot includes tests with upstream provenance and checks that generate their own inputs. Development replay fixtures, derived examples and tests that require those inputs are withheld. The native test entry point runs the generated decoder regression. The full development acceptance suite is maintained separately. A build of this snapshot on a clean Windows machine remains unverified.
