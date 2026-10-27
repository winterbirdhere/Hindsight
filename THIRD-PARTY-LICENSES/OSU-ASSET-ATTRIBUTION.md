# osu! artwork and audio attribution

The following assets retain their own Creative Commons Attribution-NonCommercial 4.0 International license. They are separate from Hindsight's MIT source-code license. The complete official license texts accompany this notice. Use and sharing of these assets must satisfy the NonCommercial condition and the other terms of CC BY-NC 4.0. No endorsement by ppy or osu! is implied.

## Legacy skin

Source project: **osu!resources**, maintained by **ppy**.

Source: https://github.com/ppy/osu-resources/tree/46d344264e5938e168cfbbd2c8fab5f572ebeda4/osu.Game.Resources/Skins/Legacy

License: **Creative Commons Attribution-NonCommercial 4.0 International**, https://creativecommons.org/licenses/by-nc/4.0/

Local payload: the 105 image/audio files in `resources/Skins/OsuDefaultSkin`. Every payload file matches the Git blob from the pinned upstream directory; the subset was selected without changing the asset bytes. The local `README.md` is Hindsight/Rewind documentation and is outside that upstream payload comparison. File-level proof is in `provenance/notice-provenance.json`.

Full upstream license/disclaimer: `osu-resources-Legacy-CC-BY-NC-4.0.md`.

## Mod icons

**osu!lazer artwork © ppy Pty Ltd.**

Source: https://github.com/ppy/osu-resources/tree/d8d01c29ce0f298159aea3644b947d8b4a1882a2/osu.Game.Resources/Textures/Icons

License: **Creative Commons Attribution-NonCommercial 4.0 International**, https://creativecommons.org/licenses/by-nc/4.0/

Local payload: the 19 original PNGs embedded in `apps/desktop/frontend/src/assets/full-map-mod-icons.ts`. Their decoded PNG bytes match the pinned upstream Git blobs. Hindsight tints, resizes and layers the original assets in SVG using mod-category colours and geometry; that display adaptation is a modification. The original source-byte and local adaptation distinction is retained in the source comment and SVG description.

Full upstream license/disclaimer: `osu-resources-ModIcons-CC-BY-NC-4.0.md`.

The palette/category reference is osu!web at `61b0a41431395f86ff68fa12744f3266448ec885`; its retained upstream MIT license is `osu-web-palette-MIT-LICENCE.txt`. The source also identifies osu!'s MIT-licensed `ModIcon.cs` geometry reference. These code/reference licenses do not relicense the PNG artwork.

This notice covers the matched legacy skin and embedded mod icons. It does not supply a redistribution grant for the separate YUGEN skin in `RewindDefaultSkin`.
