# Hindsight 0.1.0-preview.1

Windows x64, unsigned, locally prepared preview candidate. This establishes Hindsight's independent version; it does not continue Rewind's version sequence. No public download or support destination is confirmed. No remote repository, tag or release is created by this preparation.

The preview includes the replay library, Stable/Replays/native lazer/import sources, search and filters, collections/favourites/review state, and the inherited viewer with F2, playback, timing/incident inspection, same-map comparison, PP/SR and MP4 export. Initial setup requires Stable, and only osu!standard is supported. Features and PP/UR/FC semantics are unchanged from the fixed R11 checkpoint.

## Evidence carried forward

The supplied R11 summary records 10,390 passing tests in 530 suites, six skipped tests in four skipped suites, four passing typechecks and zero lint errors. Its static package audit records five compiled workers, 469 native files and zero private-path findings. A bounded isolated recovery used the candidate-matched three utilities and native EXE/DLL against an exact fixture. These are **inherited checks of R11**, not fresh runs on 0.1.0-preview.1.

The R11 handoff explicitly does **not** establish original populated-profile GUI acceptance, full GUI coverage, clean-machine acceptance or playback-performance acceptance. Earlier descriptions of relocated-package playback/export checks refer to earlier candidates and are not asserted for this release. Fresh checks of the derived preview are recorded separately in its release verification report and checksums. Successful compilation, hashing or launch alone does not establish those broader gates.

## Release changes

- Set authoritative product metadata and packaging checks to 0.1.0-preview.1. Rebuild Windows version resources and package metadata for the derived binary.
- Retain dev.hindsight.app, profile locations, native assembly identity and schema/protocol/cache versions.
- Keep publication disabled in the package configuration and manual CI; retain mixed-license supplements in ordinary package inputs.
- Clarify setup, missing source-build inputs, diagnostic privacy and evidence limitations.

Binary publication remains **HOLD** for the exact GPL-enabled FFmpeg corresponding-source/build distribution and YUGEN redistribution permission. Source excludes those binary/skin payloads but retains separately licensed embedded artwork and source archives. See [asset licensing](ASSET-LICENSING.md), [known limitations](KNOWN-LIMITATIONS.md) and [backup guidance](DATA-AND-BACKUP.md).

Based on Rewind by abstrakt; **Copyright (c) 2021 abstrakt** and [MIT](LICENSE.md) remain intact.


## Source publication revision 2

This source-only preparation removes two inherited Git LFS pointer files. The prior source/Windows candidates are preserved; the Windows binary was not rebuilt or changed and remains local under its existing distribution holds.

| Removed pointer-only file | Missing object SHA-256 / expected bytes | Reference finding |
| --- | --- | --- |
| apps/desktop/frontend/src/assets/mod_hidden.png | 04862926106b7463ae5b4dc4407ab4af5273fdf2ee331d5ecc403523a3a88c59 / 1,722 | Frontend asset-directory copying included the pointer, but no runtime consumer was found in source or preserved compiled JS/HTML/CSS/JSON. Hidden badges use the separately embedded FULL_MAP_MOD_ICONS.HIDDEN image. |
| tools/electron-builder/build-resources/icon.png | cceae28fec491bf1306c40daad13eee832fed4d410e085b6b4e121392b257528 / 36,764 | Supported Windows packaging and release staging explicitly use the real favicon.ico. The removed invalid image was a dormant default/fallback candidate for unvalidated non-Windows targets; those targets remain unsupported/unvalidated. |

No missing object was recovered or substituted, so no new artwork provenance or redistribution right is asserted. Original attribution and mixed-license notices are unchanged. Normal Git LFS filters, object checks, pre-push hook and upload validation must remain enabled for the actual remaining images. This cleanup does not establish a complete source build: held skin/media inputs, native output and optional external fixtures are still excluded.
