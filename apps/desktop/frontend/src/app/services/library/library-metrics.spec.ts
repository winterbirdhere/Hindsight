import { completionMetric, comboMetrics, performanceMetrics, timingMetrics } from "./library-metrics";

const complete = () => completionMetric({ coverage: { exactMapAndProfile: true, expectedJudgements: 10, observedJudgements: 10,
  terminalJudgementObserved: true, replayCoverage: "complete" } });

it("requires source-qualified completion and never manufactures it from partial or censored coverage", () => {
  expect(completionMetric({})).toMatchObject({ state: "unknown" });
  expect(completionMetric({ sourcePassed: true, sourceVerified: false })).toMatchObject({ state: "unknown" });
  for (const replayCoverage of ["partial", "unknown"] as const)
    expect(completionMetric({ coverage: { exactMapAndProfile: true, expectedJudgements: 10, observedJudgements: 10,
      terminalJudgementObserved: true, replayCoverage } })).toMatchObject({ state: "unknown" });
  expect(complete()).toMatchObject({ state: "known", value: "passed" });
  expect(completionMetric({ sourcePassed: false, sourceVerified: true })).toMatchObject({ state: "known", value: "failed" });
  expect(completionMetric({ sourcePassed: true, sourceVerified: true, conflicting: true })).toMatchObject({ state: "unknown" });
});

it("keeps tail loss ordinary FC separate from perfect combo and rejects hidden combo-zero breaks", () => {
  const input = { ruleset: "stable" as const, completion: complete(), misses: 0, sliderBreaks: 0, comboLosses: 0, completeBreakEvidence: true, maxCombo: 9, exactMapMaxCombo: 10 };
  expect(comboMetrics(input)).toMatchObject({ fc: { state: "known", value: true }, perfectCombo: { state: "known", value: false } });
  expect(comboMetrics({ ...input, maxCombo: 10 })).toMatchObject({ fc: { value: true }, perfectCombo: { value: true } });
  // Native head/large-tick misses and Stable combo-zero/whole-slider loss must enter raw evidence,
  // even when a presentation counter suppresses that particular break.
  expect(comboMetrics({ ...input, comboLosses: 1 })).toMatchObject({ fc: { value: false }, perfectCombo: { value: false } });
  expect(comboMetrics({ ...input, sliderBreaks: 1 })).toMatchObject({ fc: { value: false } });
});

it("requires complete zero-break proof for FC independently of perfect combo", () => {
  for (const patch of [{ completeBreakEvidence: false }, { comboLosses: null }, { sliderBreaks: null }, { misses: null },
    { completion: completionMetric({}) }, { misses: Number.NaN }]) {
    const result = comboMetrics({ ruleset: "stable" as const, completion: complete(), misses: 0, sliderBreaks: 0, comboLosses: 0,
      completeBreakEvidence: true, maxCombo: 10, exactMapMaxCombo: 10, ...patch });
    expect(result.fc.state).toBe("unknown"); expect(result.perfectCombo).toEqual({ state: "known", value: true });
  }
  expect(comboMetrics({ ruleset: "stable" as const, completion: complete(), misses: 0, sliderBreaks: 0, comboLosses: 0,
    completeBreakEvidence: true, maxCombo: 10, exactMapMaxCombo: null }).perfectCombo.state).toBe("unknown");
});

it("compares exact combo evidence independently of the replay outcome and break result", () => {
  const input = { ruleset: "stable" as const, completion: complete(), misses: 0, sliderBreaks: 0, comboLosses: 0,
    completeBreakEvidence: true, maxCombo: 10, exactMapMaxCombo: 10 };
  expect(comboMetrics({ ...input, completion: completionMetric({}) })).toMatchObject({
    fc: { state: "unknown" }, perfectCombo: { state: "known", value: true } });
  expect(comboMetrics({ ...input, completion: completionMetric({ sourcePassed: false, sourceVerified: true }) })).toMatchObject({
    fc: { state: "not-applicable" }, perfectCombo: { state: "known", value: true } });
  expect(comboMetrics({ ...input, misses: 1, comboLosses: 1, sliderBreaks: 1 })).toMatchObject({
    fc: { state: "known", value: false }, perfectCombo: { state: "known", value: true } });
  expect(comboMetrics({ ...input, completion: completionMetric({}), maxCombo: 9 }).perfectCombo)
    .toEqual({ state: "known", value: false });
});

it("does not require either combo count for ordinary FC or treat missing counts as zero", () => {
  const input = { ruleset: "stable" as const, completion: complete(), misses: 0, sliderBreaks: 0, comboLosses: 0,
    completeBreakEvidence: true, maxCombo: 10, exactMapMaxCombo: 10 };
  for (const patch of [{ maxCombo: null }, { exactMapMaxCombo: null }, { maxCombo: null, exactMapMaxCombo: null },
    { maxCombo: Number.NaN }, { exactMapMaxCombo: 0 }, { maxCombo: -1 }, { exactMapMaxCombo: 1.5 }]) {
    expect(comboMetrics({ ...input, ...patch })).toMatchObject({
      fc: { state: "known", value: true }, perfectCombo: { state: "unknown" } });
  }
  expect(comboMetrics({ ...input, maxCombo: 0 }).perfectCombo).toEqual({ state: "known", value: false });
});

it("keeps conflicting and failed combo evidence out of a positive FC badge", () => {
  const input = { ruleset: "stable" as const, completion: complete(), misses: 0, sliderBreaks: 0, comboLosses: 0, completeBreakEvidence: true, maxCombo: 11, exactMapMaxCombo: 10 };
  expect(comboMetrics(input).perfectCombo.state).toBe("unknown");
  expect(comboMetrics({ ...input, conflicting: true }).fc.state).toBe("unknown");
  expect(comboMetrics({ ...input, completion: completionMetric({ sourcePassed: false, sourceVerified: true }) }).fc.state).toBe("not-applicable");
});

it("keeps failed prefix PP in Peak PP while awarding no PP and no FC estimate", () => {
  const failed = completionMetric({ sourcePassed: false, sourceVerified: true });
  expect(performanceMetrics(failed, { pp: 125, ppIfFc: 190, peakPp: 145 })).toMatchObject({
    pp: { state: "not-applicable", reason: "failed-no-pp-awarded" }, ppIfFc: { state: "not-applicable" }, peakPp: { value: 145 } });
  expect(performanceMetrics(completionMetric({}), { pp: 125, ppIfFc: 190 }).pp.state).toBe("unknown");
  expect(performanceMetrics(complete(), { pp: 0, ppIfFc: null, peakPp: null })).toMatchObject({
    pp: { state: "known", value: 0 }, ppIfFc: { state: "unknown" }, peakPp: { state: "unknown" } });
});

it("shares canonical successful timing samples, rate semantics, empty and one-sample UR", () => {
  expect(timingMetrics([], 1, "stable")).toMatchObject({ ur: { state: "unknown" }, biasMs: { state: "unknown" } });
  expect(timingMetrics([[10, 5, true], [20, 100, false], [30, NaN, true]], 1, "stable"))
    .toMatchObject({ sampleCount: 1, ur: { value: 0 }, biasMs: { value: 5 } });
  expect(timingMetrics([[10, -10, true], [20, 10, true]], 2, "stable").ur).toMatchObject({ value: 100 });
  expect(timingMetrics([[10, -10, true], [20, 10, true]], 2, "lazer").ur).toMatchObject({ value: 50 });
  expect(timingMetrics([[10, 5, true]], 0, "lazer").ur.state).toBe("unknown");
});

it("native FC uses complete raw combo-loss evidence without inventing a Stable slider-break count", () => {
  const input = { ruleset: "lazer" as const, completion: complete(), misses: 0, comboLosses: 0,
    completeBreakEvidence: true, maxCombo: 9, exactMapMaxCombo: 10 };
  expect(comboMetrics(input)).toMatchObject({ fc: { state: "known", value: true }, perfectCombo: { value: false } });
  expect(comboMetrics({ ...input, maxCombo: 10 }).perfectCombo).toEqual({ state: "known", value: true });
  expect(comboMetrics({ ...input, comboLosses: 1 }).fc).toEqual({ state: "known", value: false });
  expect(comboMetrics({ ...input, completeBreakEvidence: false }).fc.state).toBe("unknown");
  expect(comboMetrics({ ...input, comboLosses: null }).fc.state).toBe("unknown");
});
