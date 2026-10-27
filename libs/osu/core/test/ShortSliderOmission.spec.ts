import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

const profiles = [
  { name: "Stable", profile: "stable", mods: [], lazerMods: [] },
  { name: "ScoreV2", profile: "stable", mods: ["SCORE_V2"], lazerMods: [] },
  { name: "native", profile: "lazer", mods: [], lazerMods: [] },
  {
    name: "Classic",
    profile: "lazer",
    mods: [],
    lazerMods: [{ acronym: "CL", settings: { classic_note_lock: true, no_slider_head_accuracy: true } }],
  },
] as const;
function source() {
  return [
    700, 800, 890, 910, 920, 930, 940, 960, 970, 980, 1000, 1010, 1020, 1030, 1040, 1060, 1080, 1090, 1110, 1200,
  ].map((t) =>
    traceFrame(
      t,
      t < 930 ? 100 : t < 980 ? 110 : t <= 1000 ? 120 : t <= 1080 ? 120 + (t - 1000) / 5 : 136,
      t < 910 || t >= 1030 ? [] : t < 930 ? [0] : t < 980 ? [0, 1] : [1],
    ),
  );
}
function fixture(p: typeof profiles[number] = profiles[0], prefix = "") {
  return errorFixture(
    prefix + "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
    source(),
    p.profile,
    [...p.mods],
    p.lazerMods.map((m) => ({ ...m, settings: { ...m.settings } })),
  );
}
describe("source-certified short-slider head omission", () => {
  function laterReceipt(p:typeof profiles[number],tap=971,repair=false){
    const times=[700,920,940,960,tap,980,985,995,1000,1010,1030,1040,1060,1080,1090,1110,1200].sort((a,b)=>a-b),
      frames=[...new Set(times)].map(t=>traceFrame(t,t<980?100:120,t>=tap&&t<1030&&!(repair&&t===985)?[1]:[]));
    return errorFixture("100,192,939,1,0\n120,192,1000,2,0,L|136:192,1,16",frames,p.profile,[...p.mods],p.lazerMods.map(m=>({...m,settings:{...m.settings}})));
  }
  it.each(profiles)("uses the actual prior $name receipt rather than a half-spacing ownership guess",p=>{
    const f=laterReceipt(p),e=deriveCircleEvidence(f.trace,f.map,"1/HEAD"),fixed=laterReceipt(p,971,true);
    expect(f.state.hitCircleVerdict["0"]).toMatchObject({type:"OK",judgementTime:971});
    expect(971-939).toBeGreaterThan((1000-939)/2);
    expect(e.terminal?.result).toBe("MISS");
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("No tap");
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toMatchObject({type:"GREAT",judgementTime:995});
    expect(fixed.state.hitCircleVerdict["0"]).toEqual(f.state.hitCircleVerdict["0"]);
  });
  it.each(profiles)("does not call a consumed on-time $name action an omission",p=>{
    const f=laterReceipt(p,985),e=deriveCircleEvidence(f.trace,f.map,"1/HEAD");
    expect(f.state.hitCircleVerdict["0"].type).not.toBe("MISS");
    expect(e.inputs.some(i=>i.inLiveSuccess&&i.record.freshActions.length&&Math.abs(i.record.timeMs-1000)<=e.geometry!.hitWindows[0])).toBe(true);
    expect(derivePrimaryInputEvidence(e,f.map,f.trace).missingAction).toBeUndefined();
  });
  it.each(profiles)("preserves independent later $name release after an omitted long head",p=>{
    const frames=[...source().filter(q=>q.time<1200),... [1200,1400,1600,1800,2000,2100].map(t=>traceFrame(t,120+(Math.min(t,2000)-1000)/5,t<1600?[1]:[]))];
    const f=errorFixture("100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|320:192,1,200",frames,p.profile,[...p.mods],p.lazerMods.map(m=>({...m,settings:{...m.settings}})));
    const e=deriveCircleEvidence(f.trace,f.map,"2/HEAD");expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("No tap");
    const analysis=buildErrorAnalysis(f.trace,f.map),parent=analysis.inventory.atoms.find(a=>a.component==="slider-parent");
    if(parent)expect(analysis.classifications.find(c=>c.atomId===parent.id)?.mechanism.codes).toEqual(["no-tap","released-early"]);
  });
  it.each(profiles)("certifies the complete $name head gap independently of longer body duration",p=>{
    const objects="100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|160:192,1,40";
    const f=errorFixture(objects,source(),p.profile,[...p.mods],p.lazerMods.map(m=>({...m,settings:{...m.settings}})));
    const e=deriveCircleEvidence(f.trace,f.map,"2/HEAD");
    expect(e.terminal?.result).toBe("MISS");
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("No tap");
    const recovery=errorFixture(objects,source().map(q=>q.time===1040?{...q,actions:[0],position:{x:500,y:192}}:q),p.profile,[...p.mods],p.lazerMods.map(m=>({...m,settings:{...m.settings}})));
    const recoveredEvidence=deriveCircleEvidence(recovery.trace,recovery.map,"2/HEAD");
    expect(recoveredEvidence.terminal?.result).toBe("MISS");
    expect(classifyCircleLoss(recoveredEvidence,recovery.map,recovery.trace).codes).not.toContain("no-tap");
  });
  it.each(profiles)("certifies the $name head independently of irregular consumed anchor phases", (p) => {
    const f = fixture(p),
      e = deriveCircleEvidence(f.trace, f.map, "2/HEAD"),
      before = JSON.stringify(f.trace);
    expect(f.state.hitCircleVerdict["0"].type).toBe("OK");
    expect(f.state.hitCircleVerdict["1"].type).toBe("GREAT");
    expect(e.terminal?.result).toBe("MISS");
    expect(Object.values(e.dependencies).every((d) => d.status === "complete")).toBe(true);
    expect(e.inputs.filter((i) => i.inLiveSuccess && i.record.freshActions.length).map((i) => i.record.timeMs)).toEqual(
      [910, 930],
    );
    const mechanism = classifyCircleLoss(e, f.map, f.trace);
    expect(mechanism.headline).toBe("No tap");
    expect(mechanism.diagnostics?.primary?.association.missingAction?.scope).toBe("complete-recorded-head-gap");
    expect(mechanism.eventIds).toEqual(
      expect.arrayContaining([e.terminal!.id, ...e.inputs.filter((i) => i.inLiveSuccess).map((i) => i.record.id)]),
    );
    expect(JSON.stringify(f.trace)).toBe(before);
    const repair = errorFixture(
      "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
      source().map((q) => (q.time === 1000 ? { ...q, actions: [0, 1] } : q)),
      p.profile,
      [...p.mods],
      p.lazerMods.map((m) => ({ ...m, settings: { ...m.settings } })),
    );
    expect(repair.state.hitCircleVerdict["2/HEAD"].type).toBe("GREAT");
    const analysis = buildErrorAnalysis(f.trace, f.map),
      parent = analysis.inventory.atoms.find((a) => a.component === "slider-parent");
    if (p.name === "native") expect(parent).toBeUndefined();
    else {
      expect(parent?.result).toBe("MISS");
      const cause = analysis.classifications.find((c) => c.atomId === parent!.id)!.mechanism;
      expect(cause.status).toBe("supported");
      // M62E: the carried old hold is a scoring consequence of the omitted
      // action, not proof of a second independent player release mistake.
      expect(cause.codes).toEqual(["no-tap"]);
      expect(cause.parentEvidence?.comparison.filter((c) => c.selected).map((c) => c.contributionCount)).toEqual([
        1,
      ]);
      expect(cause.parentEvidence?.contributions).toHaveLength(2);
    }
  });
  it.each([
    "source-gap",
    "raw-skip",
    "history",
    "raw-mask",
    "receipt-kind",
    "receipt-offset",
    "receipt-selection",
    "extra-attempt",
    "missing-activation",
    "parent-conflict",
    "parent-routing",
    "activation-after-input",
  ])("withholds omission for %s despite filtered context", (fault) => {
    const f = fixture(),
      trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    trace.records.forEach((r) => {
      if (r.kind === "input" && r.source.origin === "parsed") {
        r.source.rawTokenIndex = r.source.parsedFrameIndex + (fault === "raw-skip" && r.timeMs >= 1010 ? 3 : 2);
        if (r.timeMs === 1000) {
          if (fault === "source-gap") r.source.discontinuityBefore = ["source-gap"];
          if (fault === "history") r.previousActions = [];
          if (fault === "raw-mask") r.rawButtonMask = 0;
        }
      }
      if (r.kind === "resolution" && r.componentId === "1") {
        if (fault === "receipt-kind") r.component = "slider-head";
      }
      if (r.kind === "policy" && r.componentId === "1" && fault === "receipt-offset") r.offsetMs = 0;
      if (r.kind === "selection" && r.componentId === "1" && fault === "receipt-selection") r.inside = false;
      if (r.kind === "attempt" && r.timeMs === 930 && fault === "extra-attempt") r.actionCandidates = [0, 1];
    });
    let records = [
      ...(fault === "missing-activation"
        ? trace.records.filter((r) => !(r.kind === "lifecycle" && r.componentId === "1"))
        : trace.records),
    ];
    if (fault === "activation-after-input") {
      const activation = records.find((r) => r.kind === "lifecycle" && r.componentId === "1")!;
      records = records.filter((r) => r.id !== activation.id);
      activation.timeMs = 930;
      records.splice(records.findIndex((r) => r.kind === "input" && r.timeMs === 930) + 1, 0, activation);
      records.forEach((r, i) => (r.sequence = i));
    }
    const failures = [
      ...trace.failures,
      ...(fault === "parent-conflict"
        ? ["dependency-conflict:lifecycle:2"]
        : fault === "parent-routing"
        ? ["dependency-conflict:routing:2"]
        : []),
    ];
    const changed = { ...trace, records, failures },
      e = deriveCircleEvidence(changed, f.map, "2/HEAD");
    expect(classifyCircleLoss(e, f.map, changed).codes).not.toContain("no-tap");
  });
  it.each(["0", "1", "2", "2/HEAD"])("retains saved-outcome conflict protection for %s", (excluded) => {
    const f = fixture(),
      e = deriveCircleEvidence(f.trace, f.map, "2/HEAD");
    expect(derivePrimaryInputEvidence(e, f.map, f.trace, new Set([excluded])).missingAction).toBeUndefined();
  });
  it.each(["lifecycle", "routing"])("honours a source-domain parent %s conflict", (channel) => {
    const f = fixture(),
      trace = {
        ...f.trace,
        domain: {
          ...f.trace.domain,
          sourceCoverageLimits: [...f.trace.domain.sourceCoverageLimits, `dependency-conflict:${channel}:2`],
        },
      };
    const e = deriveCircleEvidence(trace, f.map, "2/HEAD");
    expect(classifyCircleLoss(e, f.map, trace).codes).not.toContain("no-tap");
  });
  it.each(["excluded", "conflict"])("does not use an invalidated earlier order receipt: %s", (fault) => {
    const f = errorFixture("450,192,500,1,0\n100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16", [
      traceFrame(300, 450),
      traceFrame(500, 450, [0]),
      traceFrame(510, 450),
      ...source(),
    ]);
    const trace = {
      ...f.trace,
      failures: [...f.trace.failures, ...(fault === "conflict" ? ["dependency-conflict:lifecycle:0"] : [])],
    };
    const e = deriveCircleEvidence(trace, f.map, "3/HEAD");
    expect(
      derivePrimaryInputEvidence(e, f.map, trace, fault === "excluded" ? new Set(["0"]) : undefined).missingAction,
    ).toBeUndefined();
  });
  it("does not trust a consumed slider head through its conflicting parent", () => {
    const f = errorFixture("100,192,880,1,0\n110,192,940,2,0,L|111:192,1,1\n120,192,1000,2,0,L|136:192,1,16", source());
    const e = deriveCircleEvidence(f.trace, f.map, "2/HEAD");
    expect(derivePrimaryInputEvidence(e, f.map, f.trace).missingAction?.scope).toBe("complete-recorded-head-gap");
    const trace = { ...f.trace, failures: [...f.trace.failures, "dependency-conflict:geometry:1"] };
    expect(
      derivePrimaryInputEvidence(deriveCircleEvidence(trace, f.map, "2/HEAD"), f.map, trace).missingAction,
    ).toBeUndefined();
  });
  it("does not let an impossible parent deadline hide a real fresh edge", () => {
    const f = errorFixture(
      "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
      source().map((q) => (q.time === 1020 ? { ...q, actions: [0, 1], position: { x: 500, y: 192 } } : q)),
    );
    const trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    trace.records.forEach((r) => {
      if (r.kind === "slider-parent" && r.componentId === "2") r.timeMs = 1010;
    });
    const e = deriveCircleEvidence(trace, f.map, "2/HEAD");
    expect(classifyCircleLoss(e, f.map, trace).codes).not.toContain("no-tap");
  });
  it("does not move a parent's own same-time input after its cutoff", () => {
    const f = errorFixture(
      "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
      source().map((q) => (q.time === 1080 ? { ...q, position: { x: 500, y: 192 }, actions: [0] } : q)),
    );
    const trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace,
      records = [...trace.records];
    const parent = records.find((r) => r.kind === "slider-parent" && r.componentId === "2")!;
    records.splice(records.indexOf(parent), 1);
    records.splice(
      records.findIndex((r) => r.kind === "input" && r.timeMs === 1080),
      0,
      parent,
    );
    records.forEach((r, i) => (r.sequence = i));
    const changed = { ...trace, records };
    expect(classifyCircleLoss(deriveCircleEvidence(changed, f.map, "2/HEAD"), f.map, changed).codes).not.toContain(
      "no-tap",
    );
  });
  it("keeps a genuine second same-time post-parent action outside the head opportunity", () => {
    const frames = source().flatMap((q) =>
      q.time === 1080 ? [q, { ...q, position: { x: 500, y: 192 }, actions: [0] }] : [q],
    );
    const f = errorFixture("100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16", frames);
    const e = deriveCircleEvidence(f.trace, f.map, "2/HEAD");
    expect(classifyCircleLoss(e, f.map, f.trace).headline).toBe("No tap");
    expect(e.inputs.find((i) => i.record.timeMs === 1080 && i.record.freshActions.length)?.inLiveSuccess).toBe(false);
  });
  it.each([profiles[2], profiles[3]])(
    "retains explicit $name release when accepted tracking started before the head",
    (p) => {
      const f = fixture(p),
        a = buildErrorAnalysis(f.trace, f.map);
      const release = f.trace.records.find(
        (r) => r.kind === "slider-tracking" && r.componentId === "2" && r.timeMs === 1030,
      )!;
      expect(release).toMatchObject({
        tracking: { started: true, beforeTracking: true, geometryAccepted: true, holdAccepted: false, actions: [] },
      });
      expect(
        f.trace.records.some((r) => r.kind === "slider-tracking" && r.componentId === "2" && r.timeMs === 1000),
      ).toBe(false);
      const tail = a.inventory.atoms.find((x) => x.componentId === "2/TAIL")!;
      const mechanism = a.classifications.find((c) => c.atomId === tail.id)!.mechanism;
      expect(mechanism.codes).toEqual(["released-early"]);
      expect(mechanism.eventIds).toContain(release.id);
    },
  );
  it.each([profiles[2], profiles[3]])("does not import a $name carried release after the part's deadline", (p) => {
    const f = errorFixture(
      "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
      source().map((q) => (q.time >= 1030 && q.time <= 1040 ? { ...q, actions: [1] } : q)),
      p.profile,
      [...p.mods],
      p.lazerMods.map((m) => ({ ...m, settings: { ...m.settings } })),
    );
    const a = buildErrorAnalysis(f.trace, f.map),
      tail = a.inventory.atoms.find((x) => x.componentId === "2/TAIL")!;
    const checkpoint = f.trace.records.find((r) => r.kind === "slider-checkpoint" && r.componentId === "2/TAIL")!;
    const release = f.trace.records.find(
      (r) => r.kind === "slider-tracking" && r.componentId === "2" && r.timeMs === 1060,
    )!;
    expect(checkpoint).toMatchObject({ deadlineMs: 1044 });
    expect(release).toMatchObject({
      tracking: { started: true, beforeTracking: true, geometryAccepted: true, holdAccepted: false, actions: [] },
    });
    expect(a.classifications.find((c) => c.atomId === tail.id)!.mechanism.codes).not.toContain("released-early");
  });
  it.each(["prestart-release", "never-held", "geometry-loss", "recovered"])(
    "preserves carried-tracking negative: %s",
    (mode) => {
      const frames = source().map((q) => ({
        ...q,
        actions:
          mode === "never-held"
            ? []
            : mode === "prestart-release" && q.time >= 980
            ? []
            : mode === "recovered" && q.time >= 1040
            ? [1]
            : q.actions,
        position: mode === "geometry-loss" && q.time >= 1030 ? { x: 500, y: 192 } : q.position,
      }));
      const f = errorFixture(
        "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
        frames,
        "lazer",
        [],
        [{ acronym: "CL", settings: { classic_note_lock: true, no_slider_head_accuracy: true } }],
      );
      const a = buildErrorAnalysis(f.trace, f.map),
        tail = a.inventory.atoms.find((x) => x.componentId === "2/TAIL");
      if (mode === "recovered") expect(tail).toBeUndefined();
      else
        expect(a.classifications.find((c) => c.atomId === tail!.id)!.mechanism.codes).not.toContain("released-early");
    },
  );
  it.each(profiles)("does not confuse fresh held-key alternation with $name omission", (p) => {
    const f = errorFixture(
      "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
      source().map((q) => (q.time === 1000 ? { ...q, actions: [0, 1] } : q)),
      p.profile,
      [...p.mods],
      p.lazerMods.map((m) => ({ ...m, settings: { ...m.settings } })),
    );
    const e = deriveCircleEvidence(f.trace, f.map, "2/HEAD");
    expect(e.terminal?.result).toBe("GREAT");
    expect(classifyCircleLoss(e, f.map, f.trace).codes).not.toContain("no-tap");
  });
  it.each(["stable", "lazer"] as const)("does not call an unconsumed outside press a missing %s tap", (profile) => {
    const f = errorFixture(
      "100,192,880,1,0\n110,192,940,1,0\n120,192,1000,2,0,L|136:192,1,16",
      source().map((q) => (q.time === 1020 ? { ...q, position: { x: 500, y: 192 }, actions: [0, 1] } : q)),
      profile,
    );
    expect(classifyCircleLoss(deriveCircleEvidence(f.trace, f.map, "2/HEAD"), f.map, f.trace).codes).not.toContain(
      "no-tap",
    );
  });
  it.each([profiles[0], profiles[1], profiles[3]])(
    "requires an unblocked $name opportunity, not just predecessor success",
    (p) => {
      const frames = [800, 900, 920, 940, 960, 980, 1000, 1020, 1040, 1080, 1110, 1200].map((t) =>
        traceFrame(t, t < 940 ? 100 : 110, t >= 920 && t < 1040 ? [0] : []),
      );
      const f = errorFixture(
        "450,192,917,1,0\n100,192,920,1,0\n110,192,1000,2,0,L|126:192,1,16",
        frames,
        p.profile,
        [...p.mods],
        p.lazerMods.map((m) => ({ ...m, settings: { ...m.settings } })),
      );
      expect(f.state.hitCircleVerdict["1"].type).toBe("GREAT");
      const e = deriveCircleEvidence(f.trace, f.map, "2/HEAD");
      expect(classifyCircleLoss(e, f.map, f.trace).codes).not.toContain("no-tap");
      const tap = errorFixture(
        "450,192,917,1,0\n100,192,920,1,0\n110,192,1000,2,0,L|126:192,1,16",
        frames.map((q) => (q.time === 1000 ? { ...q, actions: [0, 1] } : q)),
        p.profile,
        [...p.mods],
        p.lazerMods.map((m) => ({ ...m, settings: { ...m.settings } })),
      );
      expect(classifyCircleLoss(deriveCircleEvidence(tap.trace, tap.map, "2/HEAD"), tap.map, tap.trace).headline).toBe(
        "Notelock",
      );
    },
  );
});
