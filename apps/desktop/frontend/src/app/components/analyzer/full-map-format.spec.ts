import { formatEffectiveMiss, formatSignedOffset, lastIndexAtOrBefore, nearestIndexByTime } from "./full-map-format";

describe("formatEffectiveMiss", () => {
  it.each([
    [0, "0"],
    [2, "2"],
    [2.375, "2.38"],
    [2.5, "2.5"],
    [1.999, "2"],
    [0.004, "0"],
    [12.3, "12.3"],
    [100, "100"],
    [20, "20"],
  ])("writes %s as %s: two decimals at most, no trailing zeros", (value, text) => {
    expect(formatEffectiveMiss(value)).toBe(text);
  });

  it.each([[null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY], [-0.5]])(
    "writes %s as a dash, never as a zero",
    (value) => {
      expect(formatEffectiveMiss(value)).toBe("—");
    },
  );
});

describe("formatSignedOffset", () => {
  it.each([
    [31, "+31.0"],
    [-18.04, "-18.0"],
    [0, "0.0"],
    [4.25, "+4.3"],
  ])("writes %p as %s", (value, text) => {
    expect(formatSignedOffset(value)).toBe(text);
  });

  it("writes a dash for what is not a number", () => {
    expect(formatSignedOffset(Number.NaN)).toBe("—");
  });
});

describe("searching a list sorted by time", () => {
  const items = [100, 200, 200, 400].map((time) => ({ time }));

  it.each([
    [-50, 0],
    [100, 0],
    [140, 0],
    [160, 1],
    [200, 1],
    [290, 2],
    [310, 3],
    [400, 3],
    [9_999, 3],
  ])("finds the nearest to %p at index %p (a tie goes to the earlier)", (time, index) => {
    expect(nearestIndexByTime(items, time)).toBe(index);
  });

  it.each([
    [99, -1],
    [100, 0],
    [199, 0],
    [200, 2],
    [399, 2],
    [400, 3],
    [1_000_000, 3],
  ])("finds the last at or before %p at index %p", (time, index) => {
    expect(lastIndexAtOrBefore(items, time)).toBe(index);
  });

  it("finds nothing in an empty list", () => {
    expect(nearestIndexByTime([], 5)).toBe(-1);
    expect(lastIndexAtOrBefore([], 5)).toBe(-1);
  });

  it("looks at a few items of a long list, and copies none", () => {
    let reads = 0;
    const long = Array.from({ length: 150_000 }, (_, index) => ({
      get time() {
        reads++;
        return index * 10;
      },
    }));
    expect(nearestIndexByTime(long, 749_996)).toBe(75_000);
    expect(lastIndexAtOrBefore(long, 749_996)).toBe(74_999);
    expect(reads).toBeLessThan(80);
  });
});
