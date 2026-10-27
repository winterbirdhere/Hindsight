import { STARTUP_STEPS, startupCaption } from "./startup-steps";

describe("startupCaption", () => {
  it("lists the two real startup steps in order", () => {
    expect([...STARTUP_STEPS]).toEqual(["Reading osu! folder", "Loading skin"]);
  });

  it("shows the folder step first with no progress", () => {
    expect(startupCaption({ stepIndex: 0 })).toEqual({ label: "Reading osu! folder", counter: "1 / 2", fraction: 0 });
  });

  it("shows the skin step at half progress", () => {
    expect(startupCaption({ stepIndex: 1 })).toEqual({ label: "Loading skin", counter: "2 / 2", fraction: 0.5 });
  });

  it("keeps the last label at full progress once finished", () => {
    expect(startupCaption({ stepIndex: 2 })).toEqual({ label: "Loading skin", counter: "2 / 2", fraction: 1 });
  });
});
