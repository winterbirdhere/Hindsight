# Hindsight

Hindsight is a desktop replay library and analyzer for osu!standard, based on **Rewind by abstrakt**.

This source tree contains **Hindsight 0.1.0**. Its desktop build targets Windows x64. See [version notes](PREVIEW-NOTES.md) and [known limitations](KNOWN-LIMITATIONS.md).

## What it does

- Browse Stable local scores, the Stable Replays folder, native lazer scores and explicitly imported replay files in one library.
- Search, use 20 filter fields and 12 sort options, and organize plays with favourites, collections and review states.
- Open replays with **F2** or drop a replay onto Hindsight; navigate between the viewer and library.
- Play, pause, seek, step through frames, change speed and loop a selected range.
- Inspect hit timing, UR, gameplay events and available miss-cause evidence; compare same-map replays and view PP/SR calculations.
- Customize the viewer and skins, take screenshots and export replay clips to MP4.

Only osu!standard is supported. To find your highest difficulty full combo, choose **Result → FC** and sort by **Replay SR** from high to low. The filter includes recorded full combos and plays that complete replay analysis confirms as full combos. Plays with unresolved outcomes appear under **Unknown**. [How Result works](KNOWN-LIMITATIONS.md#result-and-fc)

## First setup

Start Hindsight and select the osu!stable installation folder containing `osu!.db`, `scores.db` and `Skins`, rather than its Songs or Replays subfolder. A usual location is `%LOCALAPPDATA%\osu!`. **Setup help** provides offline guidance, including custom installations and Songs locations. Replays is optional.

The initial folder screen still requires Stable. Native lazer support is configured separately through the library's source controls; selecting a lazer folder on the Stable setup screen will not work. Replay playback also needs the matching beatmap and its media to be available.

Before trying a preview, read [data locations and backups](DATA-AND-BACKUP.md). An extracted package must stay together; moving only its executable will break it. Packaged users do not need a separate Node.js or .NET installation. Clean-machine validation is still outstanding.

## Help and development

Read [bug-report guidance](BUG-REPORTING.md) before sharing diagnostics. A public support destination has not yet been confirmed. Build prerequisites and supported checks are in [CONTRIBUTION.md](CONTRIBUTION.md).

## Credits and licensing

Hindsight is based on **Rewind by abstrakt**. The original **Copyright (c) 2021 abstrakt** and MIT terms are preserved in [LICENSE.md](LICENSE.md). Bundled runtimes, libraries, fonts, media tools and skins have their own licenses and notices; the application's MIT license does not cover every bundled asset.

See the [source licensing and artwork credits](ASSET-LICENSING.md) for the embedded images, fonts, native libraries and build inputs.
