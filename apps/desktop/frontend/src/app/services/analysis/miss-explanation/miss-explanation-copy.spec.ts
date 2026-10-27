import type { MissFinding, MissExplanation, MissDescriptorCode } from "@osujs/core";
import { formatMissFinding, summarizeMissExplanation } from "./miss-explanation-copy";

function finding(code: MissDescriptorCode, changes: Partial<MissFinding> = {}): MissFinding {
  return {
    id: "f1",
    code,
    applicable: true,
    state: "supported",
    bases: ["model-trace"],
    eventIds: ["r1"],
    dependencies: ["input"],
    parameters: {},
    reasons: [],
    ...changes,
  };
}

describe("miss explanation copy", () => {
  it.each([
    ["input-miss", "The model judged a Miss from an input."],
    ["automatic-expiry", "The circle expired unresolved in the model."],
    ["ordered-force-miss", "A later judgement forced this circle to Miss in the model."],
    ["dispatch-stopped", "An in-circle input was routed to another target in the model."],
    ["order-blocked", "The model blocked this attempt under its object-order policy."],
    ["press-outside", "A fresh logical action occurred outside this circle."],
    ["no-fresh-action", "No fresh logical action occurred in the covered live success window."],
    [
      "all-fresh-actions-outside",
      "All fresh logical actions in the covered live success window were outside this circle.",
    ],
    ["entry-after-press", "The reconstructed path enters the circle after this action."],
    ["exit-before-press", "The reconstructed path leaves the circle before this action."],
    [
      "overlap-without-fresh-action",
      "The reconstructed path overlaps the live success window without an in-circle fresh action.",
    ],
  ] as const)("keeps %s factual and model-bound", (code, text) => {
    expect(formatMissFinding(finding(code)).text).toBe(text);
  });

  it.each(["not-supported", "indeterminate"] as const)("does not state an opposite fact for %s", (state) => {
    const copy = formatMissFinding(finding("no-fresh-action", { state, reasons: ["input-gap"] }));
    expect(copy.text).toBe(
      state === "not-supported"
        ? "Not supported by this evidence: absence of a fresh action."
        : "Unavailable from this evidence: absence of a fresh action.",
    );
    expect(copy.limitations).toEqual(["input-gap"]);
  });

  it("does not assert an inapplicable predicate even if its state is supported", () => {
    expect(formatMissFinding(finding("no-fresh-action", { applicable: false })).text).toBe(
      "Not applicable: absence of a fresh action.",
    );
  });

  it("retains approximate, post-terminal and timing qualifiers", () => {
    expect(
      formatMissFinding(
        finding("entry-after-press", {
          bases: ["recorded", "model-trace", "reconstructed-path"],
          parameters: { deltaMs: 12.345, crossingTimeMs: 1012.345, postTerminal: 1, approximate: 1 },
        }),
      ),
    ).toMatchObject({
      measurements: [
        "Time difference: 12.345 ms (beatmap time)",
        "Crossing time: 1012.345 ms (beatmap time)",
        "After the target resolved",
        "Approximate reconstructed crossing",
      ],
      provenance: [
        "Recorded input samples",
        "Model trace",
        "Reconstructed path; motion between samples is approximate",
      ],
    });
  });

  it("does not report an automatic expiry as a press offset", () => {
    expect(formatMissFinding(finding("automatic-expiry", { parameters: {} })).measurements).toEqual([]);
  });

  it("falls back if the nominated main finding is indeterminate or inapplicable", () => {
    const explanation = {
      mainFindingId: "f1",
      findings: [finding("input-miss", { state: "indeterminate" })],
    } as MissExplanation;
    expect(summarizeMissExplanation(explanation)).toBe("No supported explanation is available for this circle.");
  });
});
