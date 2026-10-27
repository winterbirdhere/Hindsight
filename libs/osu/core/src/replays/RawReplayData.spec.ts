import { modsFromBitmask, modsToBitmask, ReplayModBit } from "./RawReplayData";

describe("replay mod bitmasks", () => {
  it("retains TouchDevice on its own and alongside other mods", () => {
    expect(modsFromBitmask(4)).toEqual(["TOUCH_DEVICE"]);
    expect(modsToBitmask(["TOUCH_DEVICE", "HIDDEN"])).toBe(12);
    expect(modsFromBitmask(12)).toEqual(["TOUCH_DEVICE", "HIDDEN"]);
  });
  it("encodes the declared masks directly and round-trips combined mods", () => {
    const mods = ["HIDDEN", "HARD_ROCK", "DOUBLE_TIME", "FLASH_LIGHT"] as const;
    const mask = modsToBitmask([...mods]);

    expect(mask).toBe(
      ReplayModBit.HIDDEN | ReplayModBit.HARD_ROCK | ReplayModBit.DOUBLE_TIME | ReplayModBit.FLASH_LIGHT,
    );
    expect(modsFromBitmask(mask)).toEqual(expect.arrayContaining([...mods]));
  });

  it("preserves high ScoreV2 bits without a second shift", () => {
    expect(modsToBitmask(["SCORE_V2"])).toBe(ReplayModBit.SCORE_V2);
  });
});
