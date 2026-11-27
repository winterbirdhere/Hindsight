# Protected Realm native wrapper

This maintained local fork is only for the dedicated library deletion helper. It keeps the original Realm 20.1.0 `realm-wrappers.dll` unchanged and stages a distinct `hindsight-realm-wrappers.dll`. The helper must validate/install policy v1 with guarantees 3 before its first Realm read, then bind Realm.dll to that same loaded module. The runtime contract is `hindsight-realm-policy.json`; build provenance is `hindsight-realm-build.json`.

The compiler/configuration source closure was promoted byte for byte from the already acquired and independently reviewed fork. `SOURCE-PINS.json` records every maintained vendor file, original archive hashes, exact upstream commits and the unchanged original DLL identity. `before/shared_realm_cs.cpp` and `PATCH.diff` retain the before image and reviewed change. The added policy header retains the Hindsight host's MIT license. Upstream Apache/public-domain/third-party notices are preserved in source and `engine/RewindPerformance/licenses/realm-no-conversion/`.

Only the wrapper, Core native source/configuration, generated parser sources, local SHA-2 source and required CMake metadata are present. A self-contained `bindgen/src/spec/relaxed-model.ts` is required by upstream CMake project generation; the bindgen executable and SDK managed sources are excluded. Fixtures, upstream test databases, acquired archives and binary caches remain outside the maintained tree. Optional Core bindgen is outside the admitted eight-project target closure; it is never executed.

Build using installed CMake 3.31.6-msvc6, VS2022 MSVC 19.44.35222 and Windows SDK 10.0.26100.0:

```powershell
node tools/performance/realm-no-conversion/build.cjs --output <fresh-workspace-directory> --stage <fresh-publish-directory>
```

The stage must already contain the unmodified original DLL from the locked NuGet publish. Output must be fresh and ordinary, with no reparse traversal. Source pins are checked before and after build. OpenSSL/download flags remain disabled, no dependency acquisition/bootstrap is invoked, selected custom commands and project closure are checked before compilation, projects are bounded to two, compiler fanout is one, and MSBuild node reuse is disabled. A failure preserves its fresh output/logs for diagnosis. There is no implicit fetch or fallback artifact.

`build-engine.ps1` stages the fork after self-contained publish, then generates notices and verifies the native package. That script replaces generic engine output; use an authorized isolated release pipeline when preserving an active task build. `write-notices.mjs` inventories the modified binary separately from its unchanged Realm NuGet dependency. The desktop packaging route already copies the entire engine directory.

Focused checks accept explicit read-only DLL inputs and a fresh disposable fixture directory:

```powershell
node tools/performance/realm-no-conversion/verify.test.cjs <original-realm-dll> <built-fork-dll> <fresh-fixture-directory>
node tools/performance/realm-no-conversion/package.cjs source
node tools/performance/realm-no-conversion/package.cjs package <publish-directory>
```

These checks cover source/hash/manifest/export identity, preservation, overwrite refusal and missing notices. They do not replace the helper's actual same-module binding, protocol, source-locking, conservation, recovery or application acceptance checks.
