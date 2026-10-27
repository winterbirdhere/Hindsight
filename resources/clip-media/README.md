# Clip media runtime

Rewind invokes the pinned Windows x64 FFmpeg 9.0.1 executable as a separate local process for clip export. The deterministic exporter supplies every scheduled RGBA video frame to the H.264 encoder with bounded backpressure, then muxes the optional recorded audio into an indexed MP4 with front-loaded metadata. Video encoding uses libx264; it does not require a hardware video encoder. Audio is encoded as AAC and trimmed or padded to the video frame-grid duration.

The earlier MediaRecorder compatibility path also uses this executable to finalize existing MP4 recordings by stream-copying their compressed tracks. That older lossless remux path is distinct from encoding a new deterministic clip. The binary and its pinned checksum are unchanged.

The executable comes from [Gyan's Windows builds](https://www.gyan.dev/ffmpeg/builds/), a binary provider linked by [FFmpeg's download page](https://ffmpeg.org/download.html). The archive was verified against the provider's published SHA-256 before extraction. `runtime.json` records the pinned URLs, version, binary size and archive/executable hashes.

Upstream license and build configuration/source information are retained in `win-x64/LICENSE-GPL-3.0.txt` and `win-x64/UPSTREAM-README.txt`. This GPLv3-enabled executable is separate from Rewind's JavaScript process. Preserve these notices and provide the corresponding source/build materials required by the upstream license when distributing binaries; this workspace package is not a substitute for a release distribution review.

Restore/verify this resource with `tools/media/prepare-runtime.ps1`. The Windows build is currently the supported packaged target. The application must not silently fall back to a random `ffmpeg` executable from PATH.
