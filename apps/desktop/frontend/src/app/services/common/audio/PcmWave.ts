/** Samples remain at their full-decode time positions, including decoder padding. */
type DecodedAudio = Pick<AudioBuffer, "numberOfChannels" | "sampleRate" | "length" | "getChannelData">;

// Avoid another song-sized interleaved ArrayBuffer while building the Blob.
const PCM_CHUNK_BYTES = 1024 * 1024;
const WAVE_HEADER_BYTES = 58;
const MAX_PCM_BYTES = 0xffffffff - (WAVE_HEADER_BYTES - 8);

/**
 * Float PCM keeps decoded samples unchanged and provides exact sample-frame
 * seeks. The first decoded sample stays at t=0; no decoder offset is assumed.
 */
export function createPcmWaveBlob(audio: DecodedAudio): Blob {
  const { numberOfChannels: channels, sampleRate, length: frames } = audio;
  const blockAlign = channels * 4;
  const dataBytes = frames * blockAlign;
  if (
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 32 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > 768000 ||
    !Number.isSafeInteger(frames) ||
    frames < 1 ||
    !Number.isSafeInteger(dataBytes)
  ) {
    throw new Error("Decoded song has invalid PCM dimensions");
  }
  if (dataBytes > MAX_PCM_BYTES) {
    throw new Error("Decoded song exceeds the WAV RIFF size limit");
  }
  const header = new ArrayBuffer(WAVE_HEADER_BYTES);
  const view = new DataView(header);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, WAVE_HEADER_BYTES - 8 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 18, true);
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  view.setUint16(36, 0, true);
  tag(38, "fact");
  view.setUint32(42, 4, true);
  view.setUint32(46, frames, true);
  tag(50, "data");
  view.setUint32(54, dataBytes, true);
  const source = Array.from({ length: channels }, (_, channel) => audio.getChannelData(channel));
  if (source.some((channel) => channel.length !== frames)) throw new Error("Decoded song has inconsistent channels");
  const parts: BlobPart[] = [new Blob([header])];
  const framesPerChunk = Math.max(1, Math.floor(PCM_CHUNK_BYTES / blockAlign));
  for (let first = 0; first < frames; first += framesPerChunk) {
    const count = Math.min(framesPerChunk, frames - first);
    const chunk = new ArrayBuffer(count * blockAlign);
    const samples = new DataView(chunk);
    for (let frame = 0; frame < count; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        samples.setFloat32((frame * channels + channel) * 4, source[channel][first + frame], true);
      }
    }
    // Blob parts are immutable backing stores; do not retain each temporary
    // ArrayBuffer until the entire song has been interleaved.
    parts.push(new Blob([chunk]));
  }
  return new Blob(parts, { type: "audio/wav" });
}
