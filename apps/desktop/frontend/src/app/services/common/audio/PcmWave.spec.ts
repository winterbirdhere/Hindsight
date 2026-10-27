import { createPcmWaveBlob } from "./PcmWave";

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function parseWave(blob: Blob) {
  const bytes = await readBlob(blob);
  const view = new DataView(bytes);
  const text = (first: number, length: number) => String.fromCharCode(...new Uint8Array(bytes, first, length));
  expect(text(0, 4)).toBe("RIFF");
  expect(view.getUint32(4, true) + 8).toBe(bytes.byteLength);
  expect(text(8, 4)).toBe("WAVE");
  let format!: { encoding: number; channels: number; sampleRate: number; blockAlign: number; bits: number };
  let sampleFrames!: number;
  let dataOffset!: number;
  let dataBytes!: number;
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const id = text(offset, 4);
    const length = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = {
        encoding: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        blockAlign: view.getUint16(offset + 20, true),
        bits: view.getUint16(offset + 22, true),
      };
    } else if (id === "fact") {
      sampleFrames = view.getUint32(offset + 8, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataBytes = length;
    }
    offset += 8 + length + (length % 2);
  }
  return {
    format,
    sampleFrames,
    dataBytes,
    sample: (frame: number, channel: number) =>
      view.getFloat32(dataOffset + frame * format.blockAlign + channel * 4, true),
  };
}

describe("seekable decoded song WAV", () => {
  it("preserves decoded sample zero, channel order, float precision, and exact duration", async () => {
    const channels = [new Float32Array([0.25, -0.5, 1.125]), new Float32Array([-0.125, 0.75, -1.25])];
    const blob = createPcmWaveBlob({
      numberOfChannels: 2,
      sampleRate: 48000,
      length: 3,
      getChannelData: (channel) => channels[channel],
    });
    const wave = await parseWave(blob);
    expect(blob.type).toBe("audio/wav");
    expect(wave.format).toEqual({ encoding: 3, channels: 2, sampleRate: 48000, blockAlign: 8, bits: 32 });
    expect(wave.sampleFrames).toBe(3);
    expect(wave.dataBytes / wave.format.blockAlign / wave.format.sampleRate).toBe(3 / 48000);
    for (let frame = 0; frame < 3; frame++) {
      for (let channel = 0; channel < 2; channel++) expect(wave.sample(frame, channel)).toBe(channels[channel][frame]);
    }
  });

  it("locates impulses by sample frame across chunk boundaries without a seek-time shift", async () => {
    const first = new Float32Array(180001);
    const second = new Float32Array(first.length);
    const markers = [0, 1, 131071, 131072, 131073, 180000];
    for (const frame of markers) {
      first[frame] = 0.625;
      second[frame] = -0.375;
    }
    const wave = await parseWave(
      createPcmWaveBlob({
        numberOfChannels: 2,
        sampleRate: 44100,
        length: first.length,
        getChannelData: (channel) => (channel === 0 ? first : second),
      }),
    );
    for (const frame of markers) {
      expect(wave.sample(frame, 0)).toBe(0.625);
      expect(wave.sample(frame, 1)).toBe(-0.375);
      if (frame + 1 < first.length && !markers.includes(frame + 1)) expect(wave.sample(frame + 1, 0)).toBe(0);
    }
    expect(wave.sampleFrames).toBe(first.length);
  });

  it("rejects data that cannot be represented by a WAV RIFF header before reading channels", () => {
    const getChannelData = jest.fn();
    expect(() =>
      createPcmWaveBlob({
        numberOfChannels: 2,
        sampleRate: 48000,
        length: 0x100000000 / 8,
        getChannelData,
      }),
    ).toThrow("RIFF size limit");
    expect(getChannelData).not.toHaveBeenCalled();
  });

  it("rejects invalid or inconsistent decoded dimensions", () => {
    expect(() =>
      createPcmWaveBlob({ numberOfChannels: 1, sampleRate: 0, length: 1, getChannelData: () => new Float32Array(1) }),
    ).toThrow("invalid PCM");
    expect(() =>
      createPcmWaveBlob({
        numberOfChannels: 1,
        sampleRate: 48000,
        length: 2,
        getChannelData: () => new Float32Array(1),
      }),
    ).toThrow("inconsistent channels");
  });
});
