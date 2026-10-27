import { OsuDBReader } from "./OsuDBReader";

it.each([20200101, 20250106, 20250107, 20260908])(
  "reads stars and the following field without misalignment in database version %s",
  (version) => {
    const usesDouble = version < 20250107;
    const width = usesDouble ? 8 : 4;
    const bytes = Buffer.alloc(10 + width + 4);
    bytes.writeInt32LE(1, 0);
    bytes[4] = 0x08;
    bytes.writeInt32LE(64, 5);
    bytes[9] = usesDouble ? 0x0d : 0x0c;
    if (usesDouble) bytes.writeDoubleLE(5.25, 10);
    else bytes.writeFloatLE(5.25, 10);
    bytes.writeUInt32LE(123456, 10 + width);
    const reader = new OsuDBReader(bytes);
    expect(reader.readStarRatings(version)).toEqual([[64, 5.25]]);
    expect(reader.readInt()).toBe(123456);
  },
);

it("rejects incompatible typed star records instead of silently misaligning the remaining database", () => {
  const bytes = Buffer.alloc(18);
  bytes.writeInt32LE(1, 0);
  bytes[4] = 0x08;
  bytes[9] = 0x0d;
  expect(() => new OsuDBReader(bytes).readStarRatings(20250107)).toThrow("Invalid star rating record");
});
