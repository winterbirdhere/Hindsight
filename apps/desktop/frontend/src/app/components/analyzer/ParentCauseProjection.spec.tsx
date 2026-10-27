import { render } from "@testing-library/react";
import { buildBeatmap, parseBlueprint, parseReplayFramesWithDiagnostics } from "@osujs/core";
import { traceMapText } from "../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { GameSimulator } from "../../services/common/game/GameSimulator";
import { summarizeReplayEvents } from "../../services/analysis/replay-events";
import { selectedErrorCauses } from "./error-cause";
import { PlayerErrorCause } from "./PlayerErrorPanel";

it.each(["continued","ends-at-parent"])("actual Analyze projects a %s pending short-slider cause immediately in both display modes", async ending => {
  const map = buildBeatmap(parseBlueprint(traceMapText("100,192,1000,2,0,L|110:192,1,10")), { mods: [], addStacking: false });
  const parsed = parseReplayFramesWithDiagnostics("0|256|-500|0,0|256|-500|0,800|500|192|0,100|500|192|0,100|500|192|0,50|500|192|0,"+
    (ending === "continued" ? "50|100|192|5,100|500|192|0," : ""));
  const simulator = new GameSimulator();
  try {
    simulator.simulateReplay(map,{ md5hash:"pending-head",beatmapMd5:"map",gameVersion:20200101,player:"fixture",mods:[],frames:parsed.frames,parseDiagnostics:parsed.diagnostics });
    const events = simulator.replayEvents$.value, state = simulator.getCurrentState();
    const errors = summarizeReplayEvents(events,"stable").errors;
    const error = errors.find(e => e.type === "MISS" && e.hitObjectId === "0")!;
    expect(error).toBeDefined();
    const session = await simulator.analyzeMisses();
    expect(["ready","partial"]).toContain(session.status);
    const causes = selectedErrorCauses(error,events,"stable",session);
    const view = render(<PlayerErrorCause mechanisms={causes} />);
    expect(view.container.textContent).toBe("No tap");
    view.rerender(<PlayerErrorCause mechanisms={causes} displayMode="brief" />);
    expect(view.container.textContent).toBe("No tap");
    expect(view.container.querySelectorAll("button,p,details,[role=dialog]")).toHaveLength(0);
    expect(simulator.replayEvents$.value).toBe(events);
    expect(simulator.getCurrentState()).toBe(state);
    expect(await simulator.analyzeMisses()).toBe(session);
    expect(summarizeReplayEvents(events,"stable").errors).toEqual(errors);
  } finally { simulator.clear(); }
});
