# Supplemental release notices

These materials supplement the notices already carried by the compiled frontend, Electron runtime and native engine. Copy this directory with a local candidate and retain applicable materials with a future source/binary distribution. Its presence does not close the FFmpeg corresponding-source or YUGEN redistribution holds.

| Material | Coverage and provenance |
| --- | --- |
| `rxjs-hooks-0.7.0-MIT-NOTICE.txt` | MIT declaration verified in official npm 0.7.0 metadata and the exact `v0.7.0` source commit. This is curated standard MIT text, not a claimed upstream LICENSE file; the pinned source tree has none. No copyright holder/year was invented. |
| `use-constant-1.1.1-UPSTREAM-LICENSE.txt` | Verbatim `Copyright (c) Andarist` and MIT grant from upstream `20784f1…`, the immediately following commit that adds only LICENSE to `v1.1.1` without changing code. |
| `Geist-5.3.0-OFL-LICENSE.txt`, `Geist-Mono-5.3.0-OFL-LICENSE.txt` | Verbatim installed font licenses, also already in the frontend's extracted notices. |
| `mui-icons-material-5.16.14-MIT-LICENSE.txt` | Verbatim installed MUI wrapper license for icons actually imported in desktop source. |
| `Google-Material-Icons-APACHE-2.0.txt` | Official original Material Icons artwork license, supplementing MUI's MIT wrapper notice. MUI documents that its package converts Google's Material Icons into SVG components: https://mui.com/material-ui/material-icons/ |
| `OSU-ASSET-ATTRIBUTION.md` and the two `osu-resources-*-CC-BY-NC-4.0.md` files | Exact legacy payload and embedded mod-icon provenance, required asset attribution and original license/disclaimer. |
| `osu-web-palette-MIT-LICENCE.txt` | Exact upstream license from the palette/category source revision already recorded in the embedded icon source. |
| `provenance/notice-provenance.json` | Source URLs, exact commits/tags, SHA-256 values, byte counts and the 105+19 Git blob matches. |

Keep the original `LICENSE.md` crediting Rewind by abstrakt, the frontend `3rdpartylicenses.txt`/minifier notice files, external npm dependency notices, Electron `LICENSE`/`LICENSES.chromium.html`, and the full native-engine `licenses/`, source ZIPs and inventories. These supplemental files do not replace them.

Source staging that includes `full-map-mod-icons.ts` still contains CC BY-NC PNG artwork embedded as base64. Preserve its source attribution and this asset notice/license set; do not describe the whole staged tree as exclusively MIT. Excluding the two resource-skin directories removes their payload from that source tree, but does not remove embedded artwork. Font packages need not be copied into source staging when dependency declarations/lockfile install them; their applicable notices must accompany any redistributed font payload. Stage required build and test source while documenting that external integration fixtures and privately supplied skin/media payloads are not included.

Status: prepared for **private local QA**. Publication remains **HOLD** for bundled GPL FFmpeg corresponding-source/build delivery and YUGEN skin permission. No upstream author was contacted and no external publication occurred.
