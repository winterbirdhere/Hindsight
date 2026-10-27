import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import { formatCauseDetail, presentCause } from "./error-cause-presentation";
import { errorFixture } from "../../../../../../../libs/osu/core/test/ErrorAnalysisFixtures";
import { traceFrame } from "../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { buildErrorAnalysis } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorAnalysis";

const cause = (headline: string, extra: Partial<ComponentMechanism> = {}): ComponentMechanism => ({
  status: "supported",
  headline,
  codes: [headline.toLowerCase().replace(/\s+/g, "-")],
  description: "Never render this",
  eventIds: [],
  limitations: [],
  ...extra,
});

describe("presentCause", () => {
  it.each(["concise", "brief"] as const)("%s shows the omitted action alone, retaining internal tail evidence", mode => {
    const f=errorFixture("100,192,500,1,0\n120,192,1000,2,0,L|136:192,1,16",
      Array.from({length:99},(_,i)=>{const t=300+i*10;return traceFrame(t,t<960?100:120,t>=500&&t<1030?[1]:[]);}));
    const analysis=buildErrorAnalysis(f.trace,f.map),parent=analysis.inventory.atoms.find(a=>a.component==="slider-parent")!;
    const mechanism=analysis.classifications.find(c=>c.atomId===parent.id)!.mechanism;
    expect(analysis.classifications.some(c=>c.mechanism.codes.includes("released-early"))).toBe(true);
    expect(presentCause([mechanism],mode)).toEqual({labels:["No tap"]});
  });
  it("returns nothing for no, unavailable or forbidden causes", () => {
    expect(presentCause([])).toBeUndefined();
    expect(presentCause([cause("Late tap", { status: "unavailable" })])).toBeUndefined();
    expect(presentCause([cause("No re-tap", { codes: ["no-retap"] })])).toBeUndefined();
    expect(presentCause([cause("A"), cause("B"), cause("C")])).toBeUndefined();
  });

  it("keeps the existing player wording", () => {
    expect(presentCause([cause("Aim late", { codes: ["aim-late"] })])?.labels).toEqual(["Late entry"]);
    expect(presentCause([cause("Off track"), cause("No hold")])?.labels).toEqual(["Off track", "No hold"]);
    expect(presentCause([cause("Off track"), cause("Off track")])?.labels).toEqual(["Off track"]);
  });

  it("shows Overshoot and Undershoot as Overaim and Underaim, in a label and in a joined headline", () => {
    expect(presentCause([cause("Overshoot", { codes: ["overshoot"] })])?.labels).toEqual(["Overaim"]);
    expect(presentCause([cause("Undershoot", { codes: ["undershoot"] })])?.labels).toEqual(["Underaim"]);
    // One mechanism can carry a joined headline; each part is renamed.
    expect(presentCause([cause("Overshoot · Late entry", { codes: ["overshoot", "aim-late"] })])?.labels).toEqual([
      "Overaim",
      "Late entry",
    ]);
    expect(presentCause([cause("Overshoot"), cause("Undershoot")])?.labels).toEqual(["Overaim", "Underaim"]);
    // Whole words only: other words keep their letters.
    expect(presentCause([cause("Overshooting wide")])?.labels).toEqual(["Overshooting wide"]);
  });

  it("renames the words in the brief detail phrase too, keeping the case", () => {
    const detailed = (phrase: string) => cause("Late tap", { briefDetail: { phrase } });
    expect(presentCause([detailed("Following an earlier overshoot")], "brief")?.detail?.phrase).toBe(
      "Following an earlier overaim",
    );
    expect(presentCause([detailed("Following an earlier undershoot and overshoot")], "brief")?.detail?.phrase).toBe(
      "Following an earlier underaim and overaim",
    );
    expect(presentCause([detailed("Overshoot, then Undershoot")], "brief")?.detail?.phrase).toBe("Overaim, then Underaim");
    const detail = presentCause([detailed("after an overshoot")], "brief")?.detail;
    expect(detail && formatCauseDetail(detail)).toBe("after an overaim");
  });

  it("reports tap timing for one early or late cause, in either display mode", () => {
    const late = cause("Late tap", { metric: { value: 43, unit: "ms late" } });
    expect(presentCause([late])?.timing).toEqual({ offsetMs: 43, text: "43 ms late" });
    expect(presentCause([late], "brief")?.timing).toEqual({ offsetMs: 43, text: "43 ms late" });
    const early = cause("Early tap", { metric: { value: 12, unit: "ms early" } });
    expect(presentCause([early])?.timing).toEqual({ offsetMs: -12, text: "12 ms early" });
  });

  it("reports no timing for other units, non-finite values or two causes", () => {
    expect(presentCause([cause("Off track", { metric: { value: 40, unit: "px" } })])?.timing).toBeUndefined();
    expect(presentCause([cause("Late tap", { metric: { value: NaN, unit: "ms late" } })])?.timing).toBeUndefined();
    const late = cause("Late tap", { metric: { value: 43, unit: "ms late" } });
    expect(presentCause([late, cause("Off track")])?.timing).toBeUndefined();
  });

  it("supplies brief detail only in brief mode and only when unambiguous", () => {
    const detailed = cause("Late tap", { briefDetail: { phrase: "after the window", metric: { value: 46, unit: "ms late" } } });
    expect(presentCause([detailed])?.detail).toBeUndefined();
    expect(presentCause([detailed], "brief")?.detail).toEqual({ phrase: "after the window", metric: { value: 46, unit: "ms late" } });
    const other = cause("Off track", { briefDetail: { phrase: "left the path" } });
    expect(presentCause([detailed, other], "brief")?.detail).toBeUndefined();
  });

  it("gives the start of a chained cause, and none unless every shown cause has that one start", () => {
    const from = (timeMs: number, startCause = { codes: ["early-tap"], headline: "Early tap" }): ComponentMechanism["chain"] => ({
      policy: "recorded-input-chain-v1",
      chained: true,
      start: { componentId: "290", inputId: "r1", timeMs, kind: "hit-nothing" },
      opportunities: [],
      pressIds: [],
      durationMs: 0,
      stop: "hit-nothing",
      disposition: "inherited",
      cause: { ...startCause, observationOnly: false, reason: "", eventIds: [] },
      certification: { status: "observation", reason: "" },
    });
    expect(presentCause([cause("Early tap", { chain: from(70_192) })])).toEqual({
      labels: ["Early tap"],
      chainStartMs: 70_192,
      chainCause: ["Early tap"],
    });
    expect(presentCause([cause("Early tap")])).toEqual({ labels: ["Early tap"] });
    // Two causes share one arrow only when both come from the same press.
    expect(presentCause([cause("Early tap", { chain: from(70_192) }), cause("Notelock", { chain: from(70_192) })])?.chainStartMs).toBe(70_192);
    expect(presentCause([cause("Early tap", { chain: from(70_192) }), cause("Notelock", { chain: from(70_767) })])?.chainStartMs).toBeUndefined();
    expect(presentCause([cause("Early tap", { chain: from(70_192) }), cause("Off track")])?.chainStartMs).toBeUndefined();
    expect(presentCause([cause("Early tap", { chain: from(NaN) })])?.chainStartMs).toBeUndefined();
  });

  it("names the earlier mistake in player wording, and only from a usable record", () => {
    const from = (codes: string[], headline: string): ComponentMechanism["chain"] => ({
      policy: "recorded-input-chain-v1",
      chained: true,
      start: { componentId: "334", inputId: "r1", timeMs: 76_331, kind: "hit-nothing" },
      opportunities: [],
      pressIds: [],
      durationMs: 0,
      stop: "hit-nothing",
      disposition: "protected",
      cause: { codes, headline, observationOnly: false, reason: "", eventIds: [] },
      certification: { status: "observation", reason: "" },
    });
    // A protected label keeps its own headline; the start's cause is named apart from it.
    const locked = (codes: string[], headline: string) => presentCause([cause("Notelock", { chain: from(codes, headline) })]);
    expect(locked(["aim-late"], "Aim late")).toMatchObject({ labels: ["Notelock"], chainCause: ["Late entry"] });
    expect(locked(["overshoot"], "Overshoot")?.chainCause).toEqual(["Overaim"]);
    expect(locked(["misaim", "early-tap"], "Misaim · Early tap")?.chainCause).toEqual(["Misaim", "Early tap"]);
    // Without a usable cause the arrow and its time stay; only the name is missing.
    expect(locked([], "Late tap")).toMatchObject({ chainStartMs: 76_331 });
    expect(locked([], "Late tap")?.chainCause).toBeUndefined();
    expect(locked(["late-tap"], " ")?.chainCause).toBeUndefined();
  });

  it("formats the detail like the existing row", () => {
    expect(formatCauseDetail({ phrase: "after the window", metric: { value: 45.6, unit: "ms late" } })).toBe("after the window · 46 ms late");
    expect(formatCauseDetail({ phrase: "", metric: { value: 46, unit: "ms late" } })).toBe("46 ms late");
    expect(formatCauseDetail({ phrase: "left the path" })).toBe("left the path");
  });
});
