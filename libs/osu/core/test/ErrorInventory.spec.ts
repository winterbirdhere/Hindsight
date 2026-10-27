import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
describe("complete scored-loss inventory", () => {
  it("links an unresolved short-slider head to its earlier parent penalty", () => {
    const { inventory, trace } = errorFixture("100,192,1000,2,0,L|110:192,1,10", [
      traceFrame(100, 500, [0]),
      traceFrame(900, 500, [0]),
      traceFrame(1000, 100, [0]),
      traceFrame(1070, 110, [0]),
      traceFrame(1250, 500, [0]),
    ]);
    const parent = inventory.atoms.find((a) => a.component === "slider-parent")!;
    const head = inventory.atoms.find((a) => a.component === "slider-head")!;
    expect(parent.result).toBe("OK");
    expect(head.result).toBe("MISS");
    expect(parent.scoringOrder).toBeLessThan(head.scoringOrder);
    expect(parent.pendingContributionIds).toContain(head.componentId);
    expect(parent.relatedAtomIds).toContain(head.id);
    const record = trace.records.find((r) => r.id === parent.eventId);
    expect(record?.kind).toBe("slider-parent");
    expect(record?.kind === "slider-parent" ? record.headResult : null).toBeUndefined();
  });
  it("counts a native tail hit and Classic parent hit before a following combo break", () => {
    const objects = "100,192,1000,2,0,L|300:192,1,200\n500,192,2300,1,0";
    const frames = [
      traceFrame(900, 100),
      traceFrame(1000, 500),
      traceFrame(1200, 500),
      traceFrame(1500, 500),
      traceFrame(1970, 300, [0]),
      traceFrame(2100, 300, [0]),
      traceFrame(2500, 500),
    ];
    for (const mods of [[], [{ acronym: "CL" }]]) {
      const { inventory } = errorFixture(objects, frames, "lazer", [], mods);
      expect(inventory.atoms.find((a) => a.component === "circle")?.comboBroken).toBe(true);
    }
  });
  it.each(["stable", "lazer"] as const)("%s includes100/50/Miss but excludes unplayed future objects", (profile) => {
    const { inventory } = errorFixture(
      "300,192,1000,1,0\n300,192,1400,1,0\n300,192,1800,1,0\n300,192,9000,1,0",
      [
        traceFrame(900),
        traceFrame(1050, 300, [0]),
        traceFrame(1200),
        traceFrame(1490, 300, [0]),
        traceFrame(1600),
        traceFrame(2000),
      ],
      profile,
    );
    expect(inventory.atoms.map((a) => a.result)).toEqual(["OK", "MEH", "MISS"]);
    expect(new Set(inventory.atoms.map((a) => a.id)).size).toBe(3);
  });
  it.each(["stable", "lazer"] as const)(
    "%s keeps every failed component even at zero combo and links parent consequences",
    (profile) => {
      const { inventory, state } = errorFixture(
        "100,192,1000,2,0,L|300:192,2,200",
        [
          traceFrame(800, 500),
          traceFrame(1100, 500),
          traceFrame(1500, 500),
          traceFrame(2000, 500),
          traceFrame(2500, 500),
          traceFrame(2990, 500),
          traceFrame(3200, 500),
        ],
        profile,
      );
      expect(inventory.atoms.filter((a) => a.component === "slider-head")).toHaveLength(1);
      expect(
        inventory.atoms.filter((a) => ["slider-tick", "slider-repeat", "slider-legacy-tail"].includes(a.component))
          .length,
      ).toBe(Object.values(state.checkPointVerdict).filter((v) => !v.hit).length);
      const parents = inventory.atoms.filter((a) => a.component === "slider-parent");
      expect(parents.length).toBe(profile === "stable" ? 1 : 0);
      expect(parents.every((a) => a.role === "consequence" && a.relatedAtomIds.length > 0)).toBe(true);
    },
  );
  it("V1 harmless head timing is not a loss but V2 retains the head cause and parent consequence", () => {
    const frames = [
      traceFrame(900, 100),
      traceFrame(1080, 116, [0]),
      traceFrame(1500, 200, [0]),
      traceFrame(1970, 294, [0]),
      traceFrame(2100, 300, [0]),
    ];
    const v1 = errorFixture("100,192,1000,2,0,L|300:192,1,200", frames);
    const v2 = errorFixture("100,192,1000,2,0,L|300:192,1,200", frames, "stable", ["SCORE_V2"]);
    expect(v1.inventory.atoms).toHaveLength(0);
    expect(v2.inventory.atoms.map((a) => a.component)).toEqual(["slider-head", "slider-parent"]);
    expect(v2.inventory.atoms[1].relatedAtomIds).toContain(v2.inventory.atoms[0].id);
  });
  it("does not invent failed tick judgements for Stable backlog", () => {
    const { inventory, state } = errorFixture("100,192,1000,2,0,L|300:192,3,200", [
      traceFrame(900, 100),
      traceFrame(1000, 100, [0]),
      traceFrame(5000, 500),
    ]);
    const processed = Object.keys(state.checkPointVerdict);
    expect(
      inventory.atoms
        .filter((a) => a.component === "slider-tick" || a.component === "slider-repeat")
        .every((a) => processed.includes(a.componentId)),
    ).toBe(true);
    expect(inventory.atoms.find((a) => a.component === "slider-parent")?.pendingContributionIds.length).toBeGreaterThan(
      0,
    );
  });
  it("Classic independently selects head accuracy versus parent scoring", () => {
    const frames = [
      traceFrame(900, 100),
      traceFrame(1080, 116, [0]),
      traceFrame(1500, 200, [0]),
      traceFrame(1970, 294, [0]),
      traceFrame(2100, 300, [0]),
    ];
    const classic = errorFixture("100,192,1000,2,0,L|300:192,1,200", frames, "lazer", [], [{ acronym: "CL" }]);
    const accuracy = errorFixture(
      "100,192,1000,2,0,L|300:192,1,200",
      frames,
      "lazer",
      [],
      [{ acronym: "CL", settings: { no_slider_head_accuracy: false, classic_note_lock: true } }],
    );
    expect(classic.inventory.atoms).toHaveLength(0);
    expect(accuracy.inventory.atoms.map((a) => a.component)).toEqual(["slider-head"]);
  });
});
