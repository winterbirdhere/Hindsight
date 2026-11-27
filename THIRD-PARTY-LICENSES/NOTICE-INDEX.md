# Supplemental release notices

These materials accompany Hindsight’s source and desktop preview. The desktop package also carries notices for its compiled frontend, Electron runtime and native engine.

| Material | Coverage and provenance |
| --- | --- |
| `rxjs-hooks-0.7.0-MIT-NOTICE.txt` | MIT declaration verified in official npm 0.7.0 metadata and the exact `v0.7.0` source commit. This is curated standard MIT text, not a claimed upstream LICENSE file; the pinned source tree has none. No copyright holder/year was invented. |
| `use-constant-1.1.1-UPSTREAM-LICENSE.txt` | Verbatim `Copyright (c) Andarist` and MIT grant from upstream `20784f1…`, the immediately following commit that adds only LICENSE to `v1.1.1` without changing code. |
| `Geist-5.3.0-OFL-LICENSE.txt`, `Geist-Mono-5.3.0-OFL-LICENSE.txt` | Verbatim installed font licenses, also already in the frontend's extracted notices. |
| `mui-icons-material-5.16.14-MIT-LICENSE.txt` | Verbatim installed MUI wrapper license for icons actually imported in desktop source. |
| `Google-Material-Icons-APACHE-2.0.txt` | Official original Material Icons artwork license, supplementing MUI's MIT wrapper notice. MUI documents that its package converts Google's Material Icons into SVG components: https://mui.com/material-ui/material-icons/ |
| `OSU-ASSET-ATTRIBUTION.md` and the two `osu-resources-*-CC-BY-NC-4.0.md` files | Credits for Garin’s YUGEN selection and ppy’s Legacy sounds and images, including the spinner loop, the two embedded slider-miss images and the 19 embedded mod icons. The accompanying license files apply to the ppy assets identified in the notice. |
| `osu-web-palette-MIT-LICENCE.txt` | Exact upstream license from the palette/category source revision already recorded in the embedded icon source. |
| `provenance/notice-provenance.json` | Source URLs, exact commits/tags, SHA-256 values, byte counts and the 105+19 Git blob matches. |

Keep the original `LICENSE.md` crediting Rewind by abstrakt, the frontend `3rdpartylicenses.txt`/minifier notice files, external npm dependency notices, Electron `LICENSE`/`LICENSES.chromium.html`, and the full native-engine `licenses/`, source ZIPs and inventories. These supplemental files do not replace them.

The source distribution carries 19 mod icons in `full-map-mod-icons.ts` and two slider-miss markers in `OfficialLazerSliderMissAssets.ts`. Retain the artwork credits and CC BY-NC 4.0 license texts with these files. Redistributed font payloads must also carry their applicable font notices. [Artwork and audio credits](OSU-ASSET-ATTRIBUTION.md)

The Windows candidate includes MSYS2 FFmpeg and its shared libraries. Keep its three notice archives in the package and supply all four matching media source downloads alongside it. The source tree includes the same notices. [Package notices](../resources/third-party-notices/ffmpeg/PACKAGE-NOTICES.zip) · [Rust notices](../resources/third-party-notices/ffmpeg/RUST-NOTICES.zip) · [LLVM compiler runtime license and credits](../resources/third-party-notices/ffmpeg/COMPILER-RT-NOTICES.zip) · [Source downloads and checksums](../resources/clip-media/README.md)
