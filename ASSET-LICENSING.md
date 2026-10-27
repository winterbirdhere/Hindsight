# Source and binary licensing

The original Rewind code license and **Copyright (c) 2021 abstrakt** remain in [LICENSE.md](LICENSE.md). Hindsight's MIT declaration applies to that application code; retain all third-party terms with their respective material. No new copyright holder, author identity or contact has been inferred.

## Included in source

[THIRD-PARTY-LICENSES/NOTICE-INDEX.md](THIRD-PARTY-LICENSES/NOTICE-INDEX.md) maps supplemental dependency/font/icon notices and exact provenance. The embedded mod artwork in full-map-mod-icons.ts includes 19 CC BY-NC 4.0 PNGs. Keep the osu! resource attribution, original license/disclaimer and modification disclosures. NonCommercial and attribution conditions remain; this is a mixed-license source tree.

The native engine's licenses directory includes dependency notices, inventories and the TagLibSharp/OpenTabletDriver source archives used to accompany covered binaries. Keep the archives and their inventory/provenance. JavaScript, Electron, Chromium and font notices must accompany their redistributed payloads.

## Omitted source-build inputs

This snapshot does not include the two bundled skin directories, FFmpeg.exe, prebuilt native runtime, external Git LFS fixtures or personal replay/beatmap/profile data. The media pin/configuration and native source/locked dependencies are retained. The ordinary build still needs the reviewed skin/media inputs: source availability is not a claim of a complete runnable package.

## Windows binary holds

The local candidate retains its exact bundled FFmpeg and skins for evaluation. Publication is blocked until the owner resolves both:

1. **FFmpeg:** provide and verify the complete corresponding source for the exact FFmpeg binary and covered libraries, configuration/patches and scripts/material needed to build it, with a compliant delivery arrangement and notices. The provider archive URL, executable hash and upstream FFmpeg revision identify the binary but do not by themselves provide that complete source.
2. **YUGEN:** obtain and retain written permission/license covering the exact bundled files and intended redistribution, with all required credits and any underlying asset rights established. The upstream profile link and skin name are not permission.

An owner may instead approve a reviewed source-complete FFmpeg build or an asset/feature substitution/omission. Those choices can affect dependencies or product scope and require an explicit decision plus new affected QA. No such change is made by this release preparation. No third party has been contacted.

Source publication may be considered separately because the held executable/skins are absent; it still requires acceptance of mixed-license artwork conditions and confirmation of the exact public destination/contents. The complete Windows binary remains on hold.

Source publication revision 2 removes the two inherited pointer-only files after a build/runtime reference audit. No actual image was fetched, guessed or replaced. The supported Windows path keeps its valid favicon.ico and separately embedded Hidden artwork; the invalid dormant non-Windows icon fallback is omitted. See PREVIEW-NOTES.md. Other held build inputs remain missing, and independent source-build/cross-platform validation has not been performed.
