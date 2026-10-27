import { Box, Typography } from "@mui/material";
import { FULL_MAP_MOD_ICONS, fullMapModColor } from "../../../assets/full-map-mod-icons";
import {
  buildFullMapReplayMods,
  type FullMapReplayMod,
} from "../../services/analysis/full-map-analysis-view-model";

/** The badges are drawn 30 x 23; the width follows the height. */
const BADGE_WIDTH = 30;
const BADGE_HEIGHT = 23;

/**
 * The replay's mods as their badges, one line that keeps its width (in a header it is the map's name that gives way).
 * Nothing at all for no mods.
 */
export function ReplayModIcons({ mods, height = BADGE_HEIGHT }: { mods: readonly FullMapReplayMod[]; height?: number }) {
  if (!mods.length) return null;
  return (
    <Box
      component="ul"
      aria-label="Replay mods"
      sx={{ display: "flex", alignItems: "center", flexShrink: 0, gap: 0.5, m: 0, p: 0, listStyle: "none" }}
    >
      {mods.map((mod) => (
        <Box component="li" key={mod.mod} sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
          <Box
            component="img"
            src={FULL_MAP_MOD_ICONS[mod.mod]}
            alt={`${mod.name} (${mod.acronym})`}
            draggable={false}
            sx={{
              display: "block",
              width: (height * BADGE_WIDTH) / BADGE_HEIGHT,
              height,
              objectFit: "contain",
              userSelect: "none",
            }}
          />
          {mod.settingsLabel ? (
            <Typography sx={{ fontSize: (14 * height) / BADGE_HEIGHT, color: fullMapModColor(mod.mod) }}>
              {mod.settingsLabel}
            </Typography>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

/**
 * The mods from the concatenated acronyms the load state and the readout carry ("HDDT", "NM"). Every acronym is two
 * letters; a string of any other length, "NM" or letters no mod uses give no mods rather than a guess.
 */
export function replayModsFromAcronyms(acronyms: string | undefined): readonly FullMapReplayMod[] {
  const text = acronyms?.trim() ?? "";
  if (text.length === 0 || text.length % 2 !== 0) return [];
  return buildFullMapReplayMods(text.match(/.{2}/g) ?? []);
}
