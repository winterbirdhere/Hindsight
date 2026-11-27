# Known limitations

## Platform and setup

The desktop build targets Windows x64. Validation on a clean Windows installation is outstanding. Linux and macOS packages are unverified. Initial setup requires an osu!stable installation. The library has separate settings for native lazer sources. Only osu!standard is supported. Missing or inaccessible replay, beatmap or media files can prevent a play from opening.

## Result and FC

**Result** uses saved pass/fail evidence and can also recognize a full combo when complete replay analysis verifies the pass, misses and combo breaks. Those plays appear under both **FC** and **Passed**. Replay details identify a full combo confirmed by analysis.

For example, a play can have zero misses and still lose combo on a slider. A score with insufficient evidence stays **Unknown**, even if its grade, combo or PP looks like a pass. Some recordings lack the evidence needed to settle the result. Opening a filter only reads the available results.

Analysis reconstructs gameplay under the selected profile; it is not automatically a historical-client verification. Differences from saved score, grade, miss or combo statistics should be reported with their context.

## Performance

Playback performance during background calculations has yet to be fully measured.

On older or very large libraries, the FC filter and its result count can take longer to appear.

## Windows distribution

Windows packages that bundle the encoder must include its redistribution materials.

- Distribute all four matching media source downloads with the Windows package that contains the MSYS2 encoder. The package includes the FFmpeg, Rust and LLVM compiler runtime notices. [Filenames, checksums and notices](resources/clip-media/README.md)

The legacy osu! skin and embedded mod artwork carry CC BY-NC 4.0 attribution, license and modification disclosures. Preserve these disclosures and the runtime, native dependency, JavaScript, font and asset notices when distributing a build. The artwork has separate NonCommercial terms.

Hindsight includes Garin’s **YUGEN** skin. Its credits accompany the skin files.
