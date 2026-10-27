# Known limitations

## Platform and setup

The preview target is Windows x64 and it is unsigned. Clean-machine verification is pending; Linux and macOS packages are unvalidated. Initial setup requires an osu!stable installation. Native lazer library sources use separate source controls. Only osu!standard is supported. Missing or inaccessible replay, beatmap or media resources can prevent a play from opening fully.

The public-source candidate omits prebuilt native output, FFmpeg.exe and skin payloads, and optional external/personal replay fixtures. A dependency install alone does not supply them. Do not substitute unreviewed binaries or treat missing fixtures as passing tests; see [build instructions](CONTRIBUTION.md).

## Result, FC and calculated metrics

Current ordinary indexing, imports and viewer/background analysis do not produce the separately qualified recorded-outcome evidence required by Result/FC. Newly indexed/imported real plays therefore remain **Result Unknown**, and Passed, Failed and FC filters can return no matches even after analysis. Existing stored records with qualifying recorded evidence can differ. Reconstructed source-domain coverage is a separate proof and cannot become a recorded outcome.

Calculated PP/UR/timing availability depends on source evidence and supported reconstruction. Unsupported automation, incomplete object coverage or missing resources can limit metrics. An unavailable outcome is not evidence that a play failed.

Zero misses, maximum combo, an independent perfect-combo indication and hypothetical **PP if FC** do not independently establish recorded pass/fail or FC. Viewer progressive PP, the library's completion-aware primary PP and whole-map PP if FC have different meanings. Do not substitute one for another when reporting a discrepancy. Reindexing cannot create evidence that the source does not contain.

Analysis reconstructs gameplay under the selected profile and is not automatically historical-client verification. Saved grade, score, miss or combo disagreements must be reported with context; they are not alone proof of a replay cause.

## Validation limits

The inherited R11 evidence is limited to the integration/static/bounded recovery checks described in [preview notes](PREVIEW-NOTES.md). This independent preview has not inherited a full GUI, original populated-profile, clean-machine or playback-performance pass. Fresh preview checks are identified in its separate release report. A first-run/help/restart smoke does not cover replay playback, source indexing, complete background work, clip export, accessibility or every navigation state.

Full performance acceptance remains open, including matched comparisons, measurement overhead and displayed playback performance. No timing claim follows from successful compilation or normal process closure.

## Publication holds

- The exact bundled GPL-enabled FFmpeg requires a verified corresponding-source and build-material distribution arrangement, including covered dependency sources and build configuration. A license file and upstream link alone do not close it.
- Permission to redistribute the bundled YUGEN skin has not been established.

These holds remain in force for the complete Windows binary. No asset or feature was removed or replaced to hide them. The source snapshot omits held skin/media payloads and retains CC BY-NC 4.0 embedded mod artwork with its attribution, license and modification disclosures. The application's MIT license does not relicense those assets. See [asset licensing](ASSET-LICENSING.md).

Local packaging/testing does not authorize publication. GitHub owner/repository, visibility, exact source/binary contents and any commercial-use scope require owner confirmation.

Source publication revision 2 removes the two inherited pointer-only files after a build/runtime reference audit. No actual image was fetched, guessed or replaced. The supported Windows path keeps its valid favicon.ico and separately embedded Hidden artwork; the invalid dormant non-Windows icon fallback is omitted. See PREVIEW-NOTES.md. Other held build inputs remain missing, and independent source-build/cross-platform validation has not been performed.
