import { Box, ButtonBase } from "@mui/material";
import { useObservable } from "rxjs-hooks";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { isLazerReplay } from "../../model/OsuReplay";
import { preventPointerFocus } from "../../utils/focus";
import { REWIND_COLORS, REWIND_FOCUS_RING } from "../../styles/tokens";

/**
 * The Stable/Lazer switch. With `preview` it is a read-only look at the ruleset a loading replay will use:
 * both segments disabled, the previewed one drawn selected, and no simulator call.
 */
export function RulesetSwitch({ preview }: { preview?: "Stable" | "Lazer" } = {}) {
  const { gameSimulator } = useAnalysisApp();
  const rulesetFocus = useObservable(() => gameSimulator.rulesetFocus$, "stable");
  const lazerAvailable = useObservable(() => gameSimulator.lazerAvailable$, false);
  const replay = gameSimulator.getPrimaryReplay();
  const previewing = preview !== undefined;
  const sourceRuleset = replay && !previewing ? (isLazerReplay(replay) ? "lazer" : "stable") : undefined;
  const rulesets: ReplayAnalysisRuleset[] = ["stable", "lazer"];
  return (
    <Box
      role="group"
      aria-label="Analysis ruleset"
      sx={{
        flex: "none",
        display: "grid",
        gridTemplateColumns: "auto auto",
        p: "2px",
        borderRadius: "7px",
        backgroundColor: REWIND_COLORS.inset,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      {rulesets.map((ruleset) => {
        const selected = previewing ? preview.toLowerCase() === ruleset : rulesetFocus === ruleset;
        const original = sourceRuleset === ruleset;
        const label = ruleset === "stable" ? "Stable" : "Lazer";
        return (
          <ButtonBase
            key={ruleset}
            disabled={previewing || (ruleset === "lazer" && !lazerAvailable)}
            aria-pressed={selected}
            aria-label={original ? `${label}, original replay mode` : label}
            title={
              previewing ? undefined : original ? `${label} · Original replay mode` : `Analyze replay using ${label}`
            }
            onClick={previewing ? undefined : () => gameSimulator.setRulesetFocus(ruleset)}
            onMouseDown={preventPointerFocus}
            sx={{
              height: 24,
              px: "10px",
              borderRadius: "5px",
              fontSize: 12.5,
              fontWeight: 500,
              color: selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textSecondary,
              backgroundColor: selected ? REWIND_COLORS.controlActive : "transparent",
              boxShadow: selected ? "inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 3px rgba(0,0,0,0.5)" : "none",
              "&.Mui-disabled": {
                color: previewing ? (selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textSecondary) : REWIND_COLORS.textQuaternary,
              },
              "&.Mui-focusVisible": REWIND_FOCUS_RING,
            }}
          >
            {label}
          </ButtonBase>
        );
      })}
    </Box>
  );
}
