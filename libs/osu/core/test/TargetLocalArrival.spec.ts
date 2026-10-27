import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { deriveTargetLocalArrival } from "../src/gameplay/error-analysis/TargetLocalArrival";

function fixture(profile: "stable" | "lazer", arrival = 1060, head = false) {
  const knots = [
    [700, 100],
    [930, 100],
    [arrival - 90, 120],
    [arrival - 60, 170],
    [arrival - 30, 235],
    [arrival, 300],
    [arrival + 60, 460],
    [1400, 460],
  ];
  const times = [...new Set([...Array.from({ length: 71 }, (_, k) => 700 + 10 * k), 932])].sort((a, b) => a - b);
  const frames = times.map((t) => {
    const k = knots.findIndex((p, j) => j > 0 && p[0] >= t),
      a = knots[Math.max(0, k - 1)],
      b = knots[k < 0 ? knots.length - 1 : k];
    const x = a[0] === b[0] ? a[1] : a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
    return traceFrame(t, x, t === 930 ? [0] : [], t === 930 ? 5 : 0);
  });
  const f = errorFixture(
    "100,192,920,1,0\n" + (head ? "300,192,1000,2,0,L|400:192,1,100" : "300,192,1000,1,0"),
    frames,
    profile,
  );
  const id = head ? "1/HEAD" : "1",
    e = deriveCircleEvidence(f.trace, f.map, id);
  return { ...f, e, id, frames };
}

describe("target-local arrival with positively accounted earlier presses", () => {
  it.each(["stable", "lazer"] as const)(
    "retains a %s late arrival without reallocating the earlier successful tap",
    (profile) => {
      const f = fixture(profile),
        prior = f.trace.records.find((r) => r.kind === "resolution" && r.componentId === "0"),
        before = JSON.stringify(f.trace);
      expect(prior).toMatchObject({ result: "GREAT", mechanism: "successful-input", timeMs: 930 });
      expect(f.e.terminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
      expect(
        f.e.inputs.filter((i) => i.inLiveSuccess && i.record.freshActions.length).map((i) => i.record.timeMs),
      ).toEqual([930]);
      expect(f.e.insideIntervals[0].startTimeMs - 1000).toBeCloseTo(profile === "stable" ? 43.156177 : 43.163077, 5);
      const r = classifyCircleLoss(f.e, f.map, f.trace);
      expect(r.headline).toBe("Late entry");
      expect(r.codes).toEqual(["aim-late"]);
      expect(r.diagnostics?.primary?.association.relevantInputIds).toEqual([]);
      expect(JSON.stringify(f.trace)).toBe(before);
    },
  );
  it("applies to a live slider head without borrowing its body", () => {
    const f = fixture("stable", 1060, true);
    expect(f.e.terminal?.result).toBe("MISS");
    expect(classifyCircleLoss(f.e, f.map, f.trace).headline).toBe("Late entry");
  });
  it.each(["stable", "lazer"] as const)("does not call an on-time %s passage late", (profile) => {
    const f = fixture(profile, 1030);
    expect(f.e.insideIntervals[0].startTimeMs).toBeLessThan(1000 + f.e.geometry!.hitWindows[0]);
    expect(classifyCircleLoss(f.e, f.map, f.trace).codes).not.toContain("aim-late");
  });
  it.each(["input", "geometry", "routing", "lifecycle"] as const)("requires complete local %s evidence", (channel) => {
    const f = fixture("stable");
    f.e.dependencies[channel] = { status: "partial", reasons: ["test-gap"] };
    expect(classifyCircleLoss(f.e, f.map, f.trace).headline).toBe("");
  });
  it("does not use an excluded earlier receipt", () => {
    const f = fixture("stable");
    const result=classifyCircleLoss(f.e, f.map, f.trace, new Set(["0"]));
    expect(result.headline).toBe("Late entry");
    expect(result.diagnostics?.primary?.targetLocalArrival).toBeUndefined();
    expect(result.diagnostics?.primary?.unconsumedContextComparison?.ranking.selected[0].observationOnly).toBe(true);
  });
  it.each([
    "gap",
    "reconstructed",
    "raw-gap",
    "mask",
    "actions",
    "zero-time",
    "parent-cutoff",
    "post-terminal",
    "no-motion",
    "earlier-crossing",
  ])("refuses a %s arrival certificate", (fault) => {
    const f = fixture("stable"),
      e = JSON.parse(JSON.stringify(f.e)) as typeof f.e;
    const association = derivePrimaryInputEvidence(f.e, f.map, f.trace),
      i = e.inputs.find((i) => i.record.timeMs === 1020)!;
    if (fault === "gap")
      i.record.source = { origin: "parsed", parsedFrameIndex: 999, discontinuityBefore: ["test-gap"] };
    if (fault === "reconstructed") i.record.source = { origin: "provided-frame", preparedFrameIndex: 1 };
    if (fault === "raw-gap") i.record.source = { origin: "parsed", parsedFrameIndex: 32, rawTokenIndex: 999 };
    if (fault === "mask") i.record.rawButtonMask = 5;
    if (fault === "actions") i.record.previousActions = [1];
    if (fault === "zero-time") i.record.timeMs = 1010;
    if (fault === "parent-cutoff")
      e.domains.liveSuccess.end = { timeMs: 1020, sequence: i.record.sequence, inclusive: false, eventId: "parent" };
    if (fault === "post-terminal")
      for (const q of e.inputs.filter((x) => x.record.timeMs >= 1030)) q.postTerminal = true;
    if (fault === "no-motion")
      for (const q of e.inputs.filter((x) => x.record.timeMs >= 980 && x.record.timeMs <= 1040)) {
        q.record.position.x = 262;
        q.inside = false;
      }
    if (fault === "earlier-crossing") {
      const q = e.inputs.find((x) => x.record.timeMs === 1040)!;
      q.record.position.x = 340;
      q.inside = false;
      // Both recorded endpoints are outside; their chord crossed the receptor.
      // The later sampled entry must not replace that earlier passage.
    }
    expect(deriveTargetLocalArrival(e, f.map, f.trace, association)).toBeUndefined();
  });
  it.each(["unknown", "ambiguous", "relevant", "missing", "double", "unconsumed"])(
    "does not convert %s input accounting into arrival",
    (fault) => {
      const f = fixture("stable"),
        e = JSON.parse(JSON.stringify(f.e)) as typeof f.e,
        a = derivePrimaryInputEvidence(f.e, f.map, f.trace);
      const press = e.inputs.find((i) => i.record.freshActions.length)!;
      if (fault === "unknown") press.freshActionsKnown = false;
      if (fault === "ambiguous") a.associations.find((q) => q.inputId === press.record.id)!.role = "ambiguous";
      if (fault === "relevant") a.relevantInputIds.push(press.record.id);
      if (fault === "missing")
        a.missingAction = {
          previousComponentId: "0",
          eventIds: [],
          contextEventIds: [],
          scope: "complete-recorded-tail-gap",
        };
      if (fault === "double") {
        press.record.actions = [0, 1];
        press.record.freshActions = [0, 1];
        press.record.rawButtonMask = 15;
      }
      if (fault === "unconsumed") e.routing = e.routing.filter((r) => r.kind !== "policy");
      expect(deriveTargetLocalArrival(e, f.map, f.trace, a)).toBeUndefined();
    },
  );
  it("keeps a right-censored late entry without a future landing", () => {
    const f = fixture("stable"),
      e = JSON.parse(JSON.stringify(f.e)) as typeof f.e;
    for (const i of e.inputs.filter((x) => x.record.timeMs >= 1060)) {
      i.record.position.x = 300;
      i.inside = true;
    }
    const r = deriveTargetLocalArrival(e, f.map, f.trace, derivePrimaryInputEvidence(f.e, f.map, f.trace));
    expect(r?.entryTimeMs).toBeCloseTo(1043.156177, 5);
    expect(r?.inputIds).toEqual([]);
  });
  it.each(["stable", "lazer"] as const)(
    "retains fresh other-key evidence while an old key is held in %s",
    (profile) => {
      const original = fixture(profile),
        frames = original.frames.map((f) => ({
          ...f,
          position: { ...f.position },
          actions: f.time === 930 ? [0, 1] : [1],
          rawButtonMask: f.time === 930 ? 15 : 10,
        }));
      frames[0].position.x = 0;
      const f = errorFixture("100,192,920,1,0\n300,192,1000,1,0", frames, profile),
        e = deriveCircleEvidence(f.trace, f.map, "1");
      expect(f.trace.records.find((r) => r.kind === "resolution" && r.componentId === "0")).toMatchObject({
        result: "GREAT",
        timeMs: 930,
      });
      expect(e.inputs.find((i) => i.record.timeMs === 930)!.record).toMatchObject({
        previousActions: [1],
        freshActions: [0],
        actions: [0, 1],
      });
      expect(classifyCircleLoss(e, f.map, f.trace).headline).toBe("Late entry");
    },
  );
  it.each(["ScoreV2", "Classic"])("uses %s's prepared head and actual receipts", (mode) => {
    const f = errorFixture(
      "100,192,920,1,0\n300,192,1000,2,0,L|400:192,1,100",
      fixture("stable").frames,
      mode === "Classic" ? "lazer" : "stable",
      mode === "ScoreV2" ? ["SCORE_V2"] : [],
      mode === "Classic"
        ? [{ acronym: "CL", settings: { classic_note_lock: true, no_slider_head_accuracy: true } }]
        : [],
    );
    const e = deriveCircleEvidence(f.trace, f.map, "1/HEAD");
    expect(e.terminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
    expect(classifyCircleLoss(e, f.map, f.trace).headline).toBe("Late entry");
  });
  it.each(["attempt", "policy", "resolution"])(
    "refuses a %s receipt chain delayed beyond its source update",
    (kind) => {
      const f = fixture("stable"),
        trace = { ...f.trace, records: f.trace.records.map((r) => ({ ...r })) };
      const attempt = trace.records.find((r) => r.kind === "attempt" && r.timeMs === 930)!;
      const delayed = trace.records.filter(
        (r) => r.timeMs === 930 && r.kind !== "input" && r.sequence >= attempt.sequence,
      );
      const cut = delayed.findIndex((r) => r.kind === kind),
        moved = delayed.slice(cut);
      trace.records = trace.records.filter((r) => !moved.includes(r));
      const next = trace.records.findIndex((r) => r.kind === "input" && r.timeMs === 1040);
      trace.records.splice(next + 1, 0, ...moved);
      trace.records.forEach((r, k) => {
        r.sequence = k;
      });
      const e = deriveCircleEvidence(trace, f.map, "1"),
        a = derivePrimaryInputEvidence(e, f.map, trace);
      expect(Object.values(e.dependencies).every((d) => d.status === "complete")).toBe(true);
      expect(deriveTargetLocalArrival(e, f.map, trace, a)).toBeUndefined();
    },
  );
  it.each(["duplicate-receipt", "already-resolved-target"])("refuses a conflicting %s", (fault) => {
    const f = fixture("stable"),
      trace = { ...f.trace, records: f.trace.records.map((r) => ({ ...r })) };
    if (fault === "duplicate-receipt") {
      const at = trace.records.findIndex((r) => r.kind === "resolution" && r.componentId === "0");
      trace.records.splice(at + 1, 0, { ...trace.records[at], id: "duplicate" });
      trace.records.forEach((r, k) => {
        r.sequence = k;
      });
    } else {
      const terminal = trace.records.find((r) => r.kind === "resolution" && r.componentId === "1")!;
      if (terminal.kind === "resolution") terminal.previousUnresolved = false;
    }
    const e = deriveCircleEvidence(trace, f.map, "1"),
      a = derivePrimaryInputEvidence(e, f.map, trace);
    expect(deriveTargetLocalArrival(e, f.map, trace, a)).toBeUndefined();
  });
});
