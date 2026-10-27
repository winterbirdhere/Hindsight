import { REPLAY_STATS_DESIGN } from "./replay-stats-design";
import { rewindTheme } from "../../styles/theme";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

it("keeps the pinned stats look independent of the analyzer theme tokens (spec §8)", () => {
  // Pre-redesign values: the full-map performance summary must not follow the redesigned theme.
  expect(REPLAY_STATS_DESIGN.fontFamily).toBe('"Segoe UI", Inter, Arial, sans-serif');
  expect(REPLAY_STATS_DESIGN.pp.color).toBe("#fff");
  expect(REPLAY_STATS_DESIGN.letterSpacingEm).toBe(0);
  expect(REPLAY_STATS_DESIGN.fontFamily).not.toBe(rewindTheme.typography.fontFamily);
  expect(REPLAY_STATS_DESIGN.fontFamily).not.toContain("Geist");
  expect(REPLAY_STATS_DESIGN.fontFamily).not.toBe(REWIND_FONTS.ui);
  expect(REPLAY_STATS_DESIGN.pp.color).not.toBe(rewindTheme.palette.text.primary);
  expect(REPLAY_STATS_DESIGN.pp.color).not.toBe(REWIND_COLORS.textPrimary);
});
