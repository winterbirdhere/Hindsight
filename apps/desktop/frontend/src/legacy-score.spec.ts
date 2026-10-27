import {
  StableLegacyScoreEvent,
  StableLegacyScoreLookup,
  stableSpinnerSpinScore,
} from "@rewind/osu-performance/legacy-score";

describe("Stable spinner raw awards", () => {
  it("matches the per-half-turn scoring branches across both requirement parities", () => {
    for (let required = 0; required <= 40; required++) {
      let score = 0;
      for (let halfTurns = 0; halfTurns <= 200; halfTurns++) {
        if (halfTurns > required + 3 && (halfTurns - required - 3) % 2 === 0) score += 1100;
        else if (halfTurns > 1 && halfTurns % 2 === 0) score += 100;
        expect(stableSpinnerSpinScore({ stableScoredHalfTurns: halfTurns, stableRequiredHalfTurns: required })).toBe(
          score,
        );
      }
    }
  });

  it.each([undefined, {}, { stableScoredHalfTurns: 2 }, { stableRequiredHalfTurns: 2 }])(
    "preserves unavailable state %p",
    (state) => expect(stableSpinnerSpinScore(state)).toBeUndefined(),
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid or out-of-range counts %p", (value) => {
    expect(stableSpinnerSpinScore({ stableScoredHalfTurns: value, stableRequiredHalfTurns: 5 })).toBeUndefined();
    expect(stableSpinnerSpinScore({ stableScoredHalfTurns: 5, stableRequiredHalfTurns: value })).toBeUndefined();
  });
});

const circle = (objectIndex: number, baseScore: 0 | 50 | 100 | 300 = 300): StableLegacyScoreEvent => ({
  objectIndex,
  baseScore,
  combo: baseScore === 0 ? "reset" : "increment",
  applyComboMultiplier: true,
});

const nested = (objectIndex: number, baseScore: 0 | 10 | 30, tail = false): StableLegacyScoreEvent => ({
  objectIndex,
  baseScore,
  combo: baseScore > 0 ? "increment" : tail ? "none" : "reset",
  applyComboMultiplier: false,
});

const sliderResult = (objectIndex: number, baseScore: 0 | 50 | 100 | 300 = 300): StableLegacyScoreEvent => ({
  ...circle(objectIndex, baseScore),
  combo: "none",
});

describe("Stable ScoreV1 inputs", () => {
  it.each([{ mods: [] }, { mods: [{ acronym: "HD" }, { acronym: "DT" }] }, { mods: [{ acronym: "SO" }] }])(
    "adds spin awards once without mod/combo scaling or extra combo increments: %p",
    ({ mods }) => {
      const ordinary = [circle(0), circle(1), circle(2), circle(3)];
      const spins = ordinary.map((event, index) => (index === 2 ? { ...event, spinnerSpinScore: 2600 } : event));
      const lookup = new StableLegacyScoreLookup(spins, mods);
      const baseline = new StableLegacyScoreLookup(ordinary, mods);
      expect(lookup.scoresAtPrefix(2)).toEqual(baseline.scoresAtPrefix(2));
      for (const prefix of [3, 3, 4]) {
        const expected = baseline.scoresAtPrefix(prefix);
        expect(expected).toBeDefined();
        expect(lookup.scoresAtPrefix(prefix)).toEqual(expected?.map((score) => score + 2600));
      }
    },
  );

  it("recomputes overlapping prefixes without duplicating spinner awards", () => {
    const lookup = new StableLegacyScoreLookup([circle(0), { ...circle(2), spinnerSpinScore: 1200 }, circle(1)], []);
    expect(lookup.scoresAtPrefix(2)?.[4]).toBe(600);
    expect(lookup.scoresAtPrefix(3)?.[4]).toBe(2148);
    expect(lookup.scoresAtPrefix(3)?.[4]).toBe(2148);
  });

  it.each([-1, 0.5, NaN, Infinity, 2147483648])("keeps malformed spin awards unavailable: %p", (spinnerSpinScore) => {
    const lookup = new StableLegacyScoreLookup([circle(0), { ...circle(1), spinnerSpinScore }], []);
    expect(lookup.scoresAtPrefix(1)?.[0]).toBe(300);
    expect(lookup.scoresAtPrefix(2)).toBeUndefined();
    expect(lookup.unavailableReason).toBe("spinner-bonus-unavailable");
  });

  it("retains explicit unsupported spinner fallback even when an award is supplied", () => {
    const lookup = new StableLegacyScoreLookup([{ ...circle(0), spinnerSpinScore: 100, unsupportedSpinner: true }], []);
    expect(lookup.scoresAtPrefix(1)).toBeUndefined();
  });
  it("uses combo before each judgement and leaves the first two circles without combo bonus", () => {
    const lookup = new StableLegacyScoreLookup([circle(0), circle(1), circle(2)], []);
    expect(lookup.scoresAtPrefix(0)?.[4]).toBe(0);
    expect(lookup.scoresAtPrefix(1)?.[4]).toBe(300);
    expect(lookup.scoresAtPrefix(2)?.[4]).toBe(600);
    expect(lookup.scoresAtPrefix(3)?.[4]).toBe(948);
  });

  it("scores nested slider parts without a multiplier and does not increment at its final judgement", () => {
    const lookup = new StableLegacyScoreLookup(
      [circle(0), nested(1, 30), nested(1, 10), nested(1, 30, true), sliderResult(1), circle(2)],
      [],
    );
    expect(lookup.scoresAtPrefix(2)?.[4]).toBe(814);
    expect(lookup.scoresAtPrefix(3)?.[4]).toBe(1258);
  });

  it("keeps combo on a missed tail but resets on a missed head or tick", () => {
    const missedTail = new StableLegacyScoreLookup(
      [circle(0), nested(1, 30), nested(1, 10), nested(1, 0, true), sliderResult(1, 100)],
      [],
    );
    expect(missedTail.scoresAtPrefix(2)?.[4]).toBe(472);
    const missedTick = new StableLegacyScoreLookup(
      [circle(0), nested(1, 30), nested(1, 0), nested(1, 30, true), sliderResult(1, 100)],
      [],
    );
    expect(missedTick.scoresAtPrefix(2)?.[4]).toBe(460);
  });

  it("projects overlapping objects in original event order, including previously buffered combo breaks", () => {
    const lookup = new StableLegacyScoreLookup(
      [circle(0), nested(1, 30), circle(2, 0), nested(1, 30, true), sliderResult(1, 100)],
      [],
    );
    expect(lookup.scoresAtPrefix(1)?.[4]).toBe(300);
    expect(lookup.scoresAtPrefix(2)?.[4]).toBe(492);
    expect(lookup.scoresAtPrefix(3)?.[4]).toBe(460);
  });

  it("propagates cached combo across excluded events between two included objects", () => {
    const lookup = new StableLegacyScoreLookup([circle(0), circle(3, 0), circle(1), circle(2)], []);
    expect(lookup.scoresAtPrefix(1)?.[4]).toBe(300);
    expect(lookup.scoresAtPrefix(2)?.[4]).toBe(600);
    expect(lookup.scoresAtPrefix(3)?.[4]).toBe(948);
    expect(lookup.scoresAtPrefix(4)?.[4]).toBe(900);
  });

  it("truncates each combo bonus and applies mods only to that bonus", () => {
    const events = [circle(0), circle(1), circle(2, 50), circle(3, 100)];
    const lookup = new StableLegacyScoreLookup(events, [{ acronym: "HD" }]);
    // Bonus increments at base factor 3: trunc(1 * 2 * 3 * 1.06) = 6,
    // then trunc(2 * 4 * 3 * 1.06) = 25. Base score remains 750.
    expect(lookup.scoresAtPrefix(4)?.[3]).toBe(781);
    expect(lookup.scoresAtPrefix(4)?.[0]).toBe(750);
  });

  it("uses Stable mod order and counts NC/DT aliases once", () => {
    const events = [circle(0), circle(1), circle(2), circle(3, 100)];
    const first = new StableLegacyScoreLookup(events, [{ acronym: "HD" }, { acronym: "NC" }]);
    const second = new StableLegacyScoreLookup(events, [{ acronym: "DT" }, { acronym: "NC" }, { acronym: "HD" }]);
    expect(first.scoresAtPrefix(4)).toEqual(second.scoresAtPrefix(4));
  });

  it("returns unavailable only when a spinner enters the completed prefix", () => {
    const lookup = new StableLegacyScoreLookup([circle(0), { ...circle(1), unsupportedSpinner: true }], []);
    expect(lookup.scoresAtPrefix(1)?.[4]).toBe(300);
    expect(lookup.scoresAtPrefix(2)).toBeUndefined();
    expect(lookup.unavailableReason).toBe("spinner-bonus-unavailable");
  });

  it.each([
    [{ acronym: "SV2" }],
    [{ acronym: "DA", settings: { overall_difficulty: 9 } }],
    [{ acronym: "DT", settings: { speed_change: 1.25 } }],
    [{ acronym: "HT", settings: { speed_change: 0.6 } }],
    [{ acronym: "NC", settings: { speed_change: 1.2 } }],
  ])("does not invent ScoreV1 for an unsupported configuration %p", (mod) => {
    const lookup = new StableLegacyScoreLookup([circle(0)], [mod]);
    expect(lookup.scoresAtPrefix(1)).toBeUndefined();
    expect(lookup.unavailableReason).toBe("unsupported-mods");
  });

  it.each([
    { acronym: "DA", settings: { overall_difficulty: 9 } },
    { acronym: "DT", settings: { speed_change: 1.25 } },
    { acronym: "HT", settings: { speed_change: 0.6 } },
    { acronym: "V2" },
  ])("does not allocate per-event score buffers for unavailable $acronym reconstruction", (mod) => {
    const events = Array.from({ length: 10_000 }, (_, i) => circle(i));
    const allocate = jest.spyOn(global, "Float64Array");
    try {
      const lookup = new StableLegacyScoreLookup(events, [mod]);
      expect(lookup.unavailableReason).toBe("unsupported-mods");
      expect(lookup.scoresAtPrefix(0)).toBeUndefined();
      expect(lookup.scoresAtPrefix(events.length)).toBeUndefined();
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "still rejects invalid object and prefix indexes %p when mods disable reconstruction",
    (index) => {
      const mods = [{ acronym: "DA" }];
      expect(() => new StableLegacyScoreLookup([circle(0), circle(index)], mods)).toThrow(
        "Stable score events require non-negative object indices",
      );
      const lookup = new StableLegacyScoreLookup([circle(0)], mods);
      expect(() => lookup.scoresAtPrefix(index)).toThrow("Stable score prefixes must be non-decreasing");
    },
  );

  it("retains independent supported snapshots and rejects backward prefixes", () => {
    const lookup = new StableLegacyScoreLookup([circle(0), circle(1), circle(2)], []);
    const first = lookup.scoresAtPrefix(1)!;
    const final = lookup.scoresAtPrefix(3)!;
    expect(first).toEqual(Array(11).fill(300));
    expect(final[4]).toBe(948);
    expect(lookup.scoresAtPrefix(3)).not.toBe(final);
    expect(lookup.scoresAtPrefix(3)?.[4]).toBe(948);
    expect(() => lookup.scoresAtPrefix(2)).toThrow("Stable score prefixes must be non-decreasing");
  });

  it("bounds work for reverse-ordered overlapping judgements", () => {
    const events = Array.from({ length: 2100 }, (_, i) => circle(2099 - i));
    const lookup = new StableLegacyScoreLookup(events, []);
    for (let prefix = 1; prefix <= events.length; prefix++) lookup.scoresAtPrefix(prefix);
    expect(lookup.unavailableReason).toBe("work-limit");
  });

  it("handles a long ordinary map without reaching the overlap work limit", () => {
    const events = Array.from({ length: 10_000 }, (_, i) => circle(i));
    const lookup = new StableLegacyScoreLookup(events, []);
    for (let prefix = 1; prefix <= events.length; prefix++) lookup.scoresAtPrefix(prefix);
    expect(lookup.unavailableReason).toBeUndefined();
    expect(lookup.scoresAtPrefix(events.length)?.[4]).toBe(2_402_280_048);
  });
});
