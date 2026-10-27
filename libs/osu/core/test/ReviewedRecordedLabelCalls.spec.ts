import { attributePrimaryPresses, certifyPrimaryAttribution, decidePressAttribution } from "../src/gameplay/error-analysis/PrimaryAttribution";
import { PrimaryApproachResult, PrimaryContact, refineDirectionalPlacement, isPrimaryCursorPass } from "../src/gameplay/error-analysis/PrimaryApproach";
import { PrimaryCandidate } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { farReturnCalls } from "./fixtures/ReviewedFarReturnCalls";

interface RecordedCall {
  provenance: string;
  tap: number;
  g: number;
  h: number;
  distance: number;
  contacts: number[][];
  placement?: "overshoot" | "misaim";
  rightCensored?: boolean;
  landing?: { transverseR: number; timeMs: number };
  expected: string;
}

// Sealed v26 and v30 review facts, not replay-specific classifier branches. These unit
// fixtures enter at the attribution boundary after geometry extraction. Their
// synthetic trace supplies an ordered press, not a historical repair certificate.
// Add future reviewed calls to this table; full-corpus checks cover extraction.
const calls: RecordedCall[] = [
  { provenance: "307/487", tap: 4, g: 19, h: 99, distance: 1.2976595787696676,
    contacts: [[-14.761796284234151, -.45737048621231224, .7816739088570475]], expected: "misaim" },
  { provenance: "3/396", tap: 21, g: 26, h: 110, distance: 1.043192113964065,
    contacts: [[25.14588308428938, 61.160162768297596, .1042820952267193],
      [-13.0210218703578, 9.084113302465994, .8945318264544065]], placement: "overshoot",
    landing: { transverseR: .9387111830346755, timeMs: 10 }, expected: "misaim" },
  { provenance: "306/198", tap: -42, g: 19, h: 99, distance: 3.1610735545649873,
    contacts: [[-18.352096383572643, -12.139904960815329, .9453388071215355]], expected: "misaim" },
  { provenance: "2/910", tap: 11, g: 23, h: 107, distance: 1.0080620958146522,
    contacts: [[-91.19036801395123, 1.2570341126993299, .15720182083166284],
      [14.889873937034281, 91, .2507941663621745]], expected: "misaim" },
  { provenance: "307/219", tap: 13, g: 19, h: 99, distance: 1.0115511860272561,
    contacts: [[-84.68079469315853, 12.84656161446037, .05430776023315419]], expected: "late-tap" },
  { provenance: "306/840", tap: -4, g: 19, h: 99, distance: 1.0694594194518623,
    contacts: [[-104.90678110840963, -9.114178982752492, .2241297907799941]], expected: "left-early" },
  { provenance: "expanded Ataraxia 591", tap: 56, g: 23, h: 107, distance: 3.1508498173424297,
    contacts: [[-28.606223135400796, 9.932630308787338, .8352291367226236]], expected: "late-tap" },
  { provenance: "307/100 retention", tap: 49, g: 19, h: 99, distance: 1.3852491346756388,
    contacts: [[-47.46518237727287, 18.016329085472535, .8924208568653693]], expected: "late-tap" },
  { provenance: "306/83 retention", tap: 45, g: 19, h: 99, distance: 2.478637968649878,
    contacts: [[-29.8682617421764, 8.291277065263785, .8008578876731509]], expected: "late-tap" },
  { provenance: "1/769", tap: 0, g: 23, h: 107, distance: 1.0224830808544998,
    contacts: [[6.0676720344345085,95,.46064496921800496]], rightCensored: true, expected: "aim-late" },
  { provenance: "307/1062", tap: 21, g: 19, h: 99, distance: 1.5674558072709084,
    contacts: [[94.26403423061129,100,.7738097627495105]], rightCensored: true, placement: "misaim", expected: "misaim" },
  { provenance: "13/1142 (complete observation; historical certificate refused)", tap: -101, g: 23, h: 107,
    distance: 2.1375351258205786, contacts: [], placement: "misaim", expected: "misaim" },
  { provenance: "337/793 ordinary comparison (final chain remains Late tap from 791/r15080)", tap: -91,
    g: 19, h: 99, distance: 1.4804587727878922, contacts: [[-80.76116316804837,-35,.1082467926697977]],
    rightCensored: true, expected: "aim-late" },
];

function attribute(facts: RecordedCall, otherPressPlacement = false, completeness?: boolean) {
  const seed = errorFixture("300,192,1000,1,0", [traceFrame(0), traceFrame(1300)]);
  const radius = deriveCircleEvidence(seed.trace, seed.map, "0").geometry!.radius;
  const x = 300 + facts.distance * radius;
  const f = errorFixture("300,192,1000,1,0", [traceFrame(0, x),
    traceFrame(1000 + facts.tap, x, [0]), traceFrame(1300, x)]);
  const evidence = deriveCircleEvidence(f.trace, f.map, "0");
  evidence.geometry!.hitWindows = [facts.g, (facts.g + facts.h) / 2, facts.h];
  const id = evidence.inputs.find(i => i.record.freshActions.length)!.record.id;
  const contacts: PrimaryContact[] = facts.contacts.map(([entry, exit, depth]) => ({
    entryTimeMs: 1000 + entry, exitTimeMs: 1000 + exit,
    closestTimeMs: 1000 + (entry + exit) / 2, closestOffsetMs: (entry + exit) / 2,
    minRadialR: depth, sampledMinimumRadius: null, deepSampled: false,
    sampledEventIds: [], placementSupport: "reconstructed-coherent", eventIds: [id],
    reconstructedBoundary: true, leftCensored: false, rightCensored: facts.rightCensored ?? false, relation: "same-approach",
  }));
  const approaches: PrimaryApproachResult = { policyVersion: "recorded-contact-fixture", limitations: [],
    episodes: [{ inputId: id, status: "supported", pressTimeMs: 1000 + facts.tap, pressOffsetMs: facts.tap,
      placement: "unproven", relation: "no-proper-pass", contacts, eventIds: [id], limitations: [],
      spatialCandidates: [], timingIndependent: false, sampledMinimumRadius: null, reconstructedMinimumRadius: null }] };
  const placement = facts.landing ? refineDirectionalPlacement("overshoot",facts.landing.transverseR,
    contacts.some(c=>c.entryTimeMs<1000+facts.landing!.timeMs && c.placementSupport!=="unproven" && isPrimaryCursorPass(c))) : facts.placement ?? "overshoot";
  const candidates: PrimaryCandidate[] = facts.placement || otherPressPlacement ? [{
    code: placement, headline: placement === "misaim" ? "Misaim" : "Overshoot", family: "placement", strength: facts.distance,
    independent: false, relationId: "placement", inputIds: [otherPressPlacement ? "another-press" : id], eventIds: [id],
  }] : [];
  const ranking = attributePrimaryPresses(evidence, f.map, f.trace, approaches, candidates, [id]);
  return completeness === undefined ? ranking : certifyPrimaryAttribution(evidence, f.map, undefined, ranking, completeness);
}

describe("reviewed recorded label calls", () => {
  it("13/1142 keeps a complete observation after certificate refusal", () => {
    const result = attribute(calls[11], false, true);
    expect(result.selected.map(c => c.code)).toEqual(["misaim"]);
    expect(result.selected[0].observationOnly).toBe(true);
    expect(result.attribution!.presses[0].certification![0].refusals.length).toBeGreaterThan(0);
  });
  it("15/570 stays blank when the recorded proposal is incomplete and uncertified", () => {
    const result = attribute({ provenance: "15/570", tap: 6, g: 23, h: 107, distance: 3.6615924566422593,
      contacts: [[82.56658955078456,108,.7734044401174244]], rightCensored: true, expected: "" }, false, false);
    expect(result.proposed!.map(c => c.code)).toEqual(["misaim"]);
    expect(result.selected).toEqual([]);
    expect(result.reason).toBe("incomplete-primary-observation");
    expect(result.observationComplete).toBe(false);
  });
  it.each(farReturnCalls)("$name: reconstructed geometry through scoring and attribution", facts => {
    const seed = errorFixture("300,192,1000,1,0", [traceFrame(0), traceFrame(1300)]);
    const radius = deriveCircleEvidence(seed.trace, seed.map, "0").geometry!.radius;
    const points = facts.points.map((p, i) => ({ ...traceFrame(1000 + p[0], 300 + p[1] * radius, i === facts.press ? [0] : []),
      position: { x: 300 + p[1] * radius, y: 192 + p[2] * radius } }));
    const f = errorFixture("300,192,1000,1,0", [{ ...points[0], time: 0 }, ...points, { ...points[points.length-1], time: 1300 }]);
    const result = classifyCircleLoss(deriveCircleEvidence(f.trace, f.map, "0"), f.map, f.trace);
    expect(result.headline).toBe(facts.name === "1265" ? "Overshoot" : "Misaim");
  });
  it("attributes an earlier live outside press when a later recovery ends in input-MISS", () => {
    const seed = errorFixture("300,192,1000,1,0", [traceFrame(0), traceFrame(1300)]);
    const radius = deriveCircleEvidence(seed.trace, seed.map, "0").geometry!.radius;
    const frames = [traceFrame(0, 300 + 1.02 * radius), traceFrame(1000, 300 + 1.02 * radius, [0]),
      traceFrame(1010, 300 + 1.02 * radius), traceFrame(1040), traceFrame(1110, 300, [1]), traceFrame(1300)];
    const f = errorFixture("300,192,1000,1,0", frames);
    const evidence = deriveCircleEvidence(f.trace, f.map, "0");
    expect(evidence.terminal?.mechanism).toBe("input-miss");
    // This fixture enters deeply after the on-time outside press: its earlier
    // attempt is Late entry, rather than the terminal recovery's Late tap.
    expect(classifyCircleLoss(evidence, f.map, f.trace).headline).toBe("Late entry");
    const noEarlier = errorFixture("300,192,1000,1,0", frames.map((frame, i) => i === 1 ? { ...frame, actions: [] } : frame));
    expect(classifyCircleLoss(deriveCircleEvidence(noEarlier.trace, noEarlier.map, "0"), noEarlier.map, noEarlier.trace).headline).toBe("Late tap");
  });
  it.each(calls)("$provenance: $expected from recorded facts", facts => {
    const result = attribute(facts);
    expect(result.selected.map(c => c.code)).toEqual([facts.expected]);
    expect(result.attribution!.roles.chosenInputId).toBe(result.attribution!.presses[0].inputId);
    expect(result.attribution!.presses[0].certification).toBeUndefined();
  });
  it("retains the two contacts and between-passes candidate after selecting Misaim", () => {
    const result = attribute(calls[3]);
    expect(result.selected.map(c => c.code)).toEqual(["misaim"]);
    expect(result.attribution!.presses[0].passes).toHaveLength(2);
    expect(result.candidates.some(c => c.code === "between-passes")).toBe(true);
  });
  it("keeps chosen-press specificity and refuses another press's subtype", () => {
    expect(attribute({ ...calls[3], placement: "overshoot" }).selected.map(c => c.code)).toEqual(["overshoot"]);
    expect(attribute(calls[3], true).selected.map(c => c.code)).toEqual(["misaim"]);
  });
  it("does not turn a tapping winner with a later recovery contact into Misaim", () => {
    const facts = { ...calls[3], tap: 19, g: 25, h: 109,
      contacts: [[-28.2115, 18.1369, .0063], [56.6157, 97.89, .3]] };
    expect(attribute(facts).selected.map(c => c.code)).toEqual(["late-tap"]);
  });
  it.each([[-18, -12], [12, 18]])("rejects an off-beat-only graze [%s, %s] even inside G", (entryMs, exitMs) => {
    expect(decidePressAttribution({ tapOffsetMs: 42, bestWindowMs: 19, hitWindowMs: 99,
      originalInside: false, passes: [], grazes: [{ entryMs, exitMs, minRadialR: .95 }] }))
      .toMatchObject({ channel: "cursor", grazeTapAvailable: false, tapFeasible: false, nearTie: false });
  });
  it.each([[-1, 0], [0, 1]])("keeps beat boundaries inclusive without graze cursor coverage [%s, %s]", (entryMs, exitMs) => {
    expect(decidePressAttribution({ tapOffsetMs: 56, bestWindowMs: 23, hitWindowMs: 107,
      originalInside: false, passes: [], grazes: [{ entryMs, exitMs, minRadialR: .95 }] }))
      .toMatchObject({ channel: "tapping", grazeTapAvailable: true, cursorTolerance: 2 });
  });
});
