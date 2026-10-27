import type { Incident } from "./incidents";
import type { ReplayError } from "./replay-events";
import {
  REPLAY_LEAD_IN_REAL_MS,
  REPLAY_SPEEDS,
  formatRun,
  incidentIndexAtOrBefore,
  nearestIncidentIndex,
  nextIncidentIndex,
  parseTimeEntry,
  previousIncidentIndex,
  replayStartTime,
  summarizeIncident,
  type MemberLabel,
} from "./incident-summary";

const incident = (errorIndices: number[], leadIndex = errorIndices[0]): Incident => ({
  id: `incident:${leadIndex}`,
  errorIndices,
  leadIndex,
  links: [],
});
const labels =
  (table: Record<number, MemberLabel>) =>
  (index: number): MemberLabel =>
    table[index] ?? { type: "Unknown" };
const err = (time: number, index = 0): ReplayError => ({ id: `e${index}`, time, type: "MISS", hitObjectId: `o${index}` });
const errorsAt = (...times: number[]): ReplayError[] => times.map((time, index) => err(time, index));

describe("formatRun", () => {
  it("omits the count for a single member and uses a multiplication sign otherwise", () => {
    expect(formatRun("Notelock", 1)).toBe("Notelock");
    expect(formatRun("Notelock", 5)).toBe("Notelock ×5");
    expect(formatRun("Notelock", 5)).toBe("Notelock ×5");
  });
});

describe("summarizeIncident", () => {
  it("summarizes a single-member incident", () => {
    const summary = summarizeIncident(incident([4]), labels({ 4: { cause: "Late tap", type: "Miss" } }));
    expect(summary).toEqual({ causeChain: "Late tap", typeChain: "Miss", lead: 4, followers: [] });
  });

  it("summarizes a lead plus one follower", () => {
    const summary = summarizeIncident(
      incident([2, 3]),
      labels({ 2: { cause: "Late tap", type: "Miss" }, 3: { cause: "Notelock", type: "Miss" } }),
    );
    expect(summary.causeChain).toBe("Late tap → Notelock");
    expect(summary.typeChain).toBe("Miss ×2");
    expect(summary.lead).toBe(2);
    expect(summary.followers).toEqual([{ label: "Notelock", type: "Miss", errorIndices: [3] }]);
  });

  it("compresses a lead plus five equal followers", () => {
    const table: Record<number, MemberLabel> = { 0: { cause: "Late tap", type: "Miss" } };
    for (let index = 1; index <= 5; index++) table[index] = { cause: "Notelock", type: "Miss" };
    const summary = summarizeIncident(incident([0, 1, 2, 3, 4, 5]), labels(table));
    expect(summary.causeChain).toBe("Late tap → Notelock ×5");
    expect(summary.typeChain).toBe("Miss ×6");
    expect(summary.followers).toEqual([{ label: "Notelock", type: "Miss", errorIndices: [1, 2, 3, 4, 5] }]);
  });

  it("lets followers that share the lead's label join the lead's run", () => {
    const summary = summarizeIncident(
      incident([0, 1, 2]),
      labels({
        0: { cause: "Notelock", type: "Miss" },
        1: { cause: "Notelock", type: "Miss" },
        2: { cause: "Notelock", type: "Miss" },
      }),
    );
    expect(summary.causeChain).toBe("Notelock ×3");
    expect(summary.followers).toEqual([{ label: "Notelock", type: "Miss", errorIndices: [1, 2] }]);
  });

  it("keeps alternating causes as separate runs", () => {
    const summary = summarizeIncident(
      incident([0, 1, 2, 3, 4]),
      labels({
        0: { cause: "Late tap", type: "Miss" },
        1: { cause: "Notelock", type: "Miss" },
        2: { cause: "Notelock", type: "Miss" },
        3: { cause: "Early tap", type: "Miss" },
        4: { cause: "Notelock", type: "Miss" },
      }),
    );
    expect(summary.causeChain).toBe("Late tap → Notelock ×2 → Early tap → Notelock");
    expect(summary.typeChain).toBe("Miss ×5");
    expect(summary.followers.map((run) => [run.label, run.errorIndices])).toEqual([
      ["Notelock", [1, 2]],
      ["Early tap", [3]],
      ["Notelock", [4]],
    ]);
  });

  it("uses the type label as the chain label for members without a cause", () => {
    const summary = summarizeIncident(
      incident([0, 1, 2]),
      labels({ 0: { type: "Miss" }, 1: { type: "Miss" }, 2: { type: "Slider break" } }),
    );
    expect(summary.causeChain).toBe("Miss ×2 → Slider break");
    expect(summary.typeChain).toBe("Miss ×2 → Slider break");
    expect(summary.followers).toEqual([
      { label: "Miss", type: "Miss", errorIndices: [1] },
      { label: "Slider break", type: "Slider break", errorIndices: [2] },
    ]);
  });

  it("builds a mixed type chain", () => {
    const summary = summarizeIncident(
      incident([0, 1]),
      labels({ 0: { cause: "Late tap", type: "Miss" }, 1: { cause: "Notelock", type: "Slider break" } }),
    );
    expect(summary.typeChain).toBe("Miss → Slider break");
    expect(summary.causeChain).toBe("Late tap → Notelock");
  });

  it("splits a follower run when the type changes even if the cause label is the same", () => {
    const summary = summarizeIncident(
      incident([0, 1, 2]),
      labels({
        0: { cause: "Late tap", type: "Miss" },
        1: { cause: "Notelock", type: "Miss" },
        2: { cause: "Notelock", type: "Slider break" },
      }),
    );
    expect(summary.causeChain).toBe("Late tap → Notelock ×2");
    expect(summary.typeChain).toBe("Miss ×2 → Slider break");
    expect(summary.followers).toEqual([
      { label: "Notelock", type: "Miss", errorIndices: [1] },
      { label: "Notelock", type: "Slider break", errorIndices: [2] },
    ]);
  });

  it("joins multiple causes of one member with the supplied text unchanged", () => {
    const summary = summarizeIncident(
      incident([0]),
      labels({ 0: { cause: "Late tap · Aim", type: "Miss" } }),
    );
    expect(summary.causeChain).toBe("Late tap · Aim");
  });

  it("works with non-contiguous error indices and reports the lead error index", () => {
    const summary = summarizeIncident(
      incident([7, 12, 40], 7),
      labels({
        7: { cause: "Late tap", type: "Miss" },
        12: { cause: "Notelock", type: "Miss" },
        40: { cause: "Notelock", type: "Miss" },
      }),
    );
    expect(summary.lead).toBe(7);
    expect(summary.causeChain).toBe("Late tap → Notelock ×2");
    expect(summary.followers).toEqual([{ label: "Notelock", type: "Miss", errorIndices: [12, 40] }]);
  });

  it("stays compact for a 10-member chain", () => {
    const table: Record<number, MemberLabel> = { 0: { cause: "Late tap", type: "Miss" } };
    const indices = [0];
    for (let index = 1; index <= 9; index++) {
      table[index] = { cause: "Notelock", type: "Miss" };
      indices.push(index);
    }
    const summary = summarizeIncident(incident(indices), labels(table));
    expect(summary.causeChain).toBe("Late tap → Notelock ×9");
    expect(summary.typeChain).toBe("Miss ×10");
    expect(summary.followers).toHaveLength(1);
    expect(summary.followers[0].errorIndices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("asks labelOf for each member exactly once", () => {
    const calls: number[] = [];
    summarizeIncident(incident([3, 4, 5]), (index) => {
      calls.push(index);
      return { type: "Miss" };
    });
    expect(calls.sort()).toEqual([3, 4, 5]);
  });
});

describe("parseTimeEntry", () => {
  it.each([
    ["2:58", 178000],
    ["2:58.5", 178500],
    ["2:58.05", 178050],
    ["2:58.472", 178472],
    ["0:00", 0],
    ["0:48.161", 48161],
    ["10:05", 605000],
    ["178", 178000],
    ["178.5", 178500],
    ["0", 0],
    ["  2:58.472  ", 178472],
    ["2:05", 125000],
  ])("parses %j as %d ms", (text, expected) => {
    expect(parseTimeEntry(text)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    ["abc"],
    ["-5"],
    ["-2:58"],
    ["2:5"],
    ["2:5.5"],
    ["2:058"],
    ["2:60"],
    ["2:75"],
    ["2:58.4721"],
    ["2:58."],
    [".5"],
    ["2::58"],
    ["1:2:3"],
    ["2:58s"],
    ["1e3"],
    ["2,5"],
    ["2:-5"],
    ["178."],
  ])("rejects %j", (text) => {
    expect(parseTimeEntry(text)).toBeUndefined();
  });
});

describe("incident finding", () => {
  // Incident 0 leads error 0 and holds 0,1; incident 1 is error 2; incident 2 leads error 3 and holds 3,4.
  const errors = errorsAt(1000, 1100, 3000, 5000, 5600);
  const incidents = [incident([0, 1]), incident([2]), incident([3, 4])];

  describe("nearestIncidentIndex", () => {
    it("returns -1 for an empty list", () => {
      expect(nearestIncidentIndex([], errors, 1000)).toBe(-1);
      expect(nearestIncidentIndex([], [], 0)).toBe(-1);
    });

    it("picks the incident owning the nearest member time", () => {
      expect(nearestIncidentIndex(incidents, errors, 1090)).toBe(0);
      expect(nearestIncidentIndex(incidents, errors, 2900)).toBe(1);
      expect(nearestIncidentIndex(incidents, errors, 5500)).toBe(2);
    });

    it("measures to any member, not only the lead", () => {
      // Incident 0 = errors 0 and 2 (1000, 2000); incident 1 = error 1 (1400). At 1900 the follower is 100 away, the lead 900.
      const interleaved = errorsAt(1000, 1400, 2000);
      const groups = [incident([0, 2]), incident([1])];
      expect(nearestIncidentIndex(groups, interleaved, 1900)).toBe(0);
      expect(nearestIncidentIndex(groups, interleaved, 1500)).toBe(1);
    });

    it("uses the earlier incident on a tie", () => {
      // 2050 is 950 from member 1100 (incident 0) and 950 from error 2 (incident 1)
      expect(nearestIncidentIndex(incidents, errors, 2050)).toBe(0);
      // 4000 is 1000 from 3000 and 1000 from 5000
      expect(nearestIncidentIndex(incidents, errors, 4000)).toBe(1);
    });

    it("returns the first incident before the first error and the last after the last", () => {
      expect(nearestIncidentIndex(incidents, errors, -500)).toBe(0);
      expect(nearestIncidentIndex(incidents, errors, 99999)).toBe(2);
    });
  });

  describe("incidentIndexAtOrBefore", () => {
    it("returns -1 when there are no errors or incidents", () => {
      expect(incidentIndexAtOrBefore([], [], 1000)).toBe(-1);
      expect(incidentIndexAtOrBefore(incidents, [], 1000)).toBe(-1);
    });

    it("returns the first incident before any error is reached", () => {
      expect(incidentIndexAtOrBefore(incidents, errors, 0)).toBe(0);
    });

    it("returns the incident that contains the most recently reached error", () => {
      expect(incidentIndexAtOrBefore(incidents, errors, 1100)).toBe(0);
      expect(incidentIndexAtOrBefore(incidents, errors, 2998)).toBe(0);
      expect(incidentIndexAtOrBefore(incidents, errors, 3500)).toBe(1);
      expect(incidentIndexAtOrBefore(incidents, errors, 5100)).toBe(2);
      // a follower (error 4 at 5600) belongs to incident 2, not a later one
      expect(incidentIndexAtOrBefore(incidents, errors, 5700)).toBe(2);
    });

    it("applies the 1 ms tolerance of errorIndexAtOrBefore", () => {
      expect(incidentIndexAtOrBefore(incidents, errors, 2998.9)).toBe(0);
      expect(incidentIndexAtOrBefore(incidents, errors, 2999)).toBe(1);
    });

    it("returns the last incident after the last error", () => {
      expect(incidentIndexAtOrBefore(incidents, errors, 99999)).toBe(2);
    });
  });

  describe("nextIncidentIndex", () => {
    it("steps by one from an incident index and returns -1 at the end", () => {
      expect(nextIncidentIndex(incidents, errors, { incidentIndex: 0 })).toBe(1);
      expect(nextIncidentIndex(incidents, errors, { incidentIndex: 1 })).toBe(2);
      expect(nextIncidentIndex(incidents, errors, { incidentIndex: 2 })).toBe(-1);
    });

    it("returns -1 for an empty list", () => {
      expect(nextIncidentIndex([], [], { incidentIndex: 0 })).toBe(-1);
      expect(nextIncidentIndex([], [], { timeMs: 0 })).toBe(-1);
    });

    it("finds the first lead time greater than time + 1", () => {
      expect(nextIncidentIndex(incidents, errors, { timeMs: 0 })).toBe(0);
      expect(nextIncidentIndex(incidents, errors, { timeMs: 500 })).toBe(0);
      expect(nextIncidentIndex(incidents, errors, { timeMs: 1000 })).toBe(1);
      expect(nextIncidentIndex(incidents, errors, { timeMs: 1100 })).toBe(1);
      expect(nextIncidentIndex(incidents, errors, { timeMs: 3000 })).toBe(2);
      expect(nextIncidentIndex(incidents, errors, { timeMs: 5000 })).toBe(-1);
      expect(nextIncidentIndex(incidents, errors, { timeMs: 99999 })).toBe(-1);
    });

    it("treats a lead exactly 1 ms ahead as the current position", () => {
      expect(nextIncidentIndex(incidents, errors, { timeMs: 2999 })).toBe(2);
      expect(nextIncidentIndex(incidents, errors, { timeMs: 2998.5 })).toBe(1);
    });
  });

  describe("previousIncidentIndex", () => {
    it("steps by one from an incident index and returns -1 at the start", () => {
      expect(previousIncidentIndex(incidents, errors, { incidentIndex: 2 })).toBe(1);
      expect(previousIncidentIndex(incidents, errors, { incidentIndex: 1 })).toBe(0);
      expect(previousIncidentIndex(incidents, errors, { incidentIndex: 0 })).toBe(-1);
    });

    it("returns -1 for an empty list", () => {
      expect(previousIncidentIndex([], [], { incidentIndex: 0 })).toBe(-1);
      expect(previousIncidentIndex([], [], { timeMs: 5000 })).toBe(-1);
    });

    it("finds the last lead time less than time - 1", () => {
      expect(previousIncidentIndex(incidents, errors, { timeMs: 99999 })).toBe(2);
      expect(previousIncidentIndex(incidents, errors, { timeMs: 5000 })).toBe(1);
      expect(previousIncidentIndex(incidents, errors, { timeMs: 3000 })).toBe(0);
      expect(previousIncidentIndex(incidents, errors, { timeMs: 1000 })).toBe(-1);
      expect(previousIncidentIndex(incidents, errors, { timeMs: 0 })).toBe(-1);
    });

    it("treats a lead exactly 1 ms behind as the current position", () => {
      expect(previousIncidentIndex(incidents, errors, { timeMs: 3001 })).toBe(0);
      expect(previousIncidentIndex(incidents, errors, { timeMs: 3001.5 })).toBe(1);
    });
  });
});

describe("replayStartTime", () => {
  it("has one real-time lead-in of 1.5 s and the three replay speeds", () => {
    expect(REPLAY_LEAD_IN_REAL_MS).toBe(1500);
    expect(REPLAY_SPEEDS).toEqual([0.25, 0.5, 1]);
  });

  it.each([
    // error time, base rate, speed, expected start: errorTime − 1500 × speed × baseRate
    [10000, 1, 1, 8500],
    [10000, 1, 0.5, 9250],
    [10000, 1, 0.25, 9625],
    [10000, 1.5, 1, 7750],
    [10000, 1.5, 0.5, 8875],
    [10000, 1.5, 0.25, 9437.5],
    [10000, 0.75, 1, 8875],
    [10000, 0.75, 0.25, 9718.75],
  ])("starts a %i ms error at rate %s and %s× speed at %s ms", (errorTime, baseRate, speed, expected) => {
    expect(replayStartTime(errorTime, baseRate, speed)).toBe(expected);
  });

  it("takes a quarter of the 1× lead-in at 0.25× and half of it at 0.5×", () => {
    for (const baseRate of [1, 1.5]) {
      const full = 10000 - replayStartTime(10000, baseRate, 1);
      expect(10000 - replayStartTime(10000, baseRate, 0.5)).toBe(full / 2);
      expect(10000 - replayStartTime(10000, baseRate, 0.25)).toBe(full / 4);
    }
  });

  it.each([
    [1000, 1, 1],
    [0, 1.5, 1],
    [2000, 1.5, 1],
    [300, 1, 0.5],
    [300, 1.5, 0.25],
  ])("never goes below zero (%i ms, rate %s, %s×)", (errorTime, baseRate, speed) => {
    expect(replayStartTime(errorTime, baseRate, speed)).toBe(0);
  });
});
