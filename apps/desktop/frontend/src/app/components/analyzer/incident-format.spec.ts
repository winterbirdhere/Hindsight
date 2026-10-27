import { chainMessage, formatIncidentPosition } from "./incident-format";

describe("formatIncidentPosition", () => {
  it("names one error by its number and the total, without an incident number", () => {
    expect(formatIncidentPosition([33], 92)).toBe("34/92");
  });

  it("joins a contiguous run with an en dash", () => {
    expect(formatIncidentPosition([33, 34, 35], 92)).toBe("34–36/92");
    expect(formatIncidentPosition([4, 5], 18)).toBe("5–6/18");
  });

  it("lists errors that are not contiguous, comma separated", () => {
    expect(formatIncidentPosition([33, 35], 92)).toBe("34, 36/92");
    expect(formatIncidentPosition([4, 5, 7], 18)).toBe("5, 6, 8/18");
  });

  it("numbers errors from 1", () => {
    expect(formatIncidentPosition([0], 1)).toBe("1/1");
  });
});

describe("chainMessage", () => {
  it("names the earlier mistake and its displayed time in a few words", () => {
    expect(chainMessage(70_192, ["Early tap"], 1)).toBe("Caused by early tap at 1:10.192");
    expect(chainMessage(76_331, ["Late entry"], 1)).toBe("Caused by late entry at 1:16.331");
    expect(chainMessage(222_176, ["Misaim", "Early tap"], 1)).toBe("Caused by misaim and early tap at 3:42.176");
  });

  it("falls back to an earlier mistake without a cause, and shows time at the playback rate", () => {
    expect(chainMessage(70_192, undefined, 1)).toBe("Caused by an earlier mistake at 1:10.192");
    expect(chainMessage(70_192, [], 1)).toBe("Caused by an earlier mistake at 1:10.192");
    expect(chainMessage(70_192, ["Early tap"], 1.5)).toBe("Caused by early tap at 0:46.795");
  });
});
