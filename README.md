# Hindsight

Hindsight is a Windows desktop replay library and analyzer for osu!standard, based on **Rewind by abstrakt**. Its independent preview version is **0.1.0-preview.1**.

This is a release candidate under local preparation. There is no confirmed public download, issue tracker or release repository. The unsigned Windows x64 binary is **not cleared for redistribution**: exact FFmpeg corresponding-source/build delivery and YUGEN skin permission remain open. See [preview notes](PREVIEW-NOTES.md), [known limitations](KNOWN-LIMITATIONS.md) and [asset licensing](ASSET-LICENSING.md).

## What it does

- Browse Stable local scores, the Stable Replays folder, native lazer scores and explicitly imported replay files.
- Search and filter the library; organize plays with favourites, collections and review states.
- Open a replay with **F2** or drop it onto Hindsight; move between the viewer and library.
- Play, pause, seek, step through frames, change speed and loop a selected range.
- Inspect hit timing, UR, gameplay events and available miss evidence; compare same-map replays and view PP/SR calculations.
- Customize the viewer and skins, capture screenshots and export MP4 clips.

Current ordinary indexing, imports and analysis leave recorded **Result/FC Unknown**; Passed, Failed and FC filters can therefore have no matches. Stored records with separately qualified recorded outcomes can differ. Calculated metric availability depends on the evidence available for each play; zero misses, combo and hypothetical **PP if FC** do not independently establish recorded Result/FC. Analysis reconstructs gameplay and does not establish historical-client equivalence. Only osu!standard is supported.

## Run a Windows x64 preview

Keep the complete extracted application folder together and run Hindsight.exe. Packaged users do not need Node.js or .NET installed. This candidate is unsigned; clean-machine validation is pending. Read [data locations and backups](DATA-AND-BACKUP.md) before using an existing profile.

For first setup, select an osu!stable installation containing osu!.db, scores.db and Skins, rather than its Songs or Replays subfolder. A usual location is %LOCALAPPDATA%\osu!. **Setup help** includes offline guidance for custom installations and Songs locations. Replays is optional. Initial setup still requires Stable; configure native lazer separately through the library's source controls. Replay playback needs the matching beatmap and media.

For isolated testing in PowerShell, choose a new absent profile directory and pass its absolute path explicitly:

~~~powershell
& '.\Hindsight.exe' '--user-data-dir=D:\Hindsight-preview-test\profile-new'
~~~

Use a writable location you own. Do not select real replay sources for a first-run-only smoke check. The development and packaged default profiles remain separate; see the backup guide.

## Build and report issues

[CONTRIBUTION.md](CONTRIBUTION.md) lists the pinned toolchain, locked dependency installation and supported verification. This source snapshot omits held runtime media/skins and prebuilt native outputs; installing dependencies alone does not produce a runnable app. [Desktop development instructions](apps/desktop/DEVELOPMENT.md) explain the required inputs.

Keep a report locally until a support destination is confirmed. Include the exact version, reproduction steps, selected source/profile/mods and sanitized diagnostics; follow [bug-report guidance](BUG-REPORTING.md).

## Credits and licensing

Hindsight is based on **Rewind by abstrakt**. **Copyright (c) 2021 abstrakt** and the original MIT terms are preserved in [LICENSE.md](LICENSE.md). Third-party libraries, runtimes, fonts and artwork retain their own terms. Embedded osu! mod artwork includes **CC BY-NC 4.0** material, so this source tree and binary are not exclusively MIT. Preserve [THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES/NOTICE-INDEX.md) and native notices/source archives.

The source publication snapshot removes two inherited unused pointer-only assets, as recorded in [preview notes](PREVIEW-NOTES.md#source-publication-revision-2). It retains actual remaining images with their mixed-license notices. Held runtime/build inputs are still missing; independent source-build validation has not been performed.
