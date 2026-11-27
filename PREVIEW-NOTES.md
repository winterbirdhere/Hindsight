# Hindsight 0.1.0

This archive contains the source for Hindsight 0.1.0. The desktop build targets Windows x64.

Hindsight includes Hindsight branding, a replay library with Stable local scores, the Replays folder, native lazer scores and explicit imports, plus search, 20 filter fields, 12 sorts, collections, favourites and review states. The replay viewer retains F2 and drop-to-open, playback/seeking, timing and incident inspection, same-map comparison, PP/SR calculations and MP4 clip export.

First setup still requires an osu!stable installation. Lazer sources are configured separately in the library. Only osu!standard is supported.

**Result → FC** finds full combos supported by the recording or confirmed by complete replay analysis. These also appear under **Passed**. Choosing a filter uses the results already available. Plays without enough evidence stay under **Unknown**.

For build prerequisites and project checks, see [the contribution guide](CONTRIBUTION.md).

Hindsight includes “YUGEN” by Garin and supports installed osu! skins. Windows builds use MSYS2 FFmpeg for MP4 export. Distribute the matching media source downloads with any Windows package that includes the encoder. See the [media guide](resources/clip-media/README.md), [known limitations](KNOWN-LIMITATIONS.md), [backup guidance](DATA-AND-BACKUP.md) and [bug-report instructions](BUG-REPORTING.md).

Based on Rewind by abstrakt; **Copyright (c) 2021 abstrakt** is retained under [MIT](LICENSE.md). Third-party components retain their separate terms.
