# Licensing and credits

Hindsight is based on Rewind by abstrakt. The original application code carries the MIT license and **Copyright (c) 2021 abstrakt**. Artwork, fonts, dependencies and native components retain their own licenses. [Application license](LICENSE.md) · [Third-party notices](THIRD-PARTY-LICENSES/NOTICE-INDEX.md)

## Artwork in the source

The source includes 19 osu!lazer mod icons and two osu! Legacy slider-miss markers from ppy. These assets use Creative Commons Attribution–NonCommercial 4.0 International. The mod controls tint, resize and layer the icons. Keep ppy’s credit, the license and the description of those adaptations when sharing them. [Artwork credits, exact sources and local changes](THIRD-PARTY-LICENSES/OSU-ASSET-ATTRIBUTION.md) · [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

Garin created the YUGEN skin used in the free Windows preview. That preview uses the adaptation by abstrakt and includes the credited osu! Legacy spinner sound. The source archive omits both viewer skin directories. The skin versions used in the preview and their credits are listed in the [artwork and audio notices](THIRD-PARTY-LICENSES/OSU-ASSET-ATTRIBUTION.md).

## Fonts and native dependencies

Geist and Geist Mono carry the SIL Open Font License. The source archive includes their notices alongside the notices for Material Icons, the MUI wrappers and other frontend dependencies. [Notice index](THIRD-PARTY-LICENSES/NOTICE-INDEX.md)

The native engine includes the notices, source archives and replacement instructions for its covered TagLibSharp and OpenTabletDriver assemblies. The protected Realm wrapper has its own upstream source pins, patch and notices. [Native notices and archives](engine/RewindPerformance/licenses) · [Realm wrapper sources and build instructions](tools/performance/realm-no-conversion/README.md)

## Building the Windows preview

The source archive omits the compiled app, native runtime, encoder binaries and personal replay data. The Windows build restores FFmpeg and its DLLs from 86 pinned MSYS2 packages. Keep the FFmpeg, Rust and LLVM compiler runtime notices in the desktop package and provide all four matching media source downloads alongside it. The media guide identifies their filenames and checksums. [Media notices and sources](resources/clip-media/README.md) · [Build instructions](apps/desktop/DEVELOPMENT.md)
