import { Box, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useReadoutIdentity } from "../../hooks/readout";
import { useReplayLoadState } from "../../hooks/replay-load-state";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import type { LoadedMap, ReplayLoadState } from "../../services/manager/replay-load-state";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { OpenReplayButton } from "./OpenReplayButton";
import { ReplayModIcons, replayModsFromAcronyms } from "./ReplayModIcons";
import { RulesetSwitch } from "./RulesetSwitch";
import { LibraryViewerStepper } from "../replay-library-host";

const truncate = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

const headerFrame = {
  p: "14px 18px",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  boxShadow: `inset 0 -1px 0 ${REWIND_COLORS.hairline}`,
} as const;

/** `[difficulty] · mapper`, leaving out what the beatmap does not provide. */
function subtitleOf(map: Pick<LoadedMap, "difficulty" | "mapper">): string {
  return [map.difficulty ? `[${map.difficulty}]` : "", map.mapper ?? ""].filter(Boolean).join(" · ");
}

/** The heading and the quiet line under it, in a column that gives way (ellipsis) in a narrow inspector. */
function TitleColumn({ children }: { children: ReactNode }) {
  return <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>{children}</Box>;
}

function Subtitle({ text }: { text: string }) {
  return (
    <Box component="span" sx={{ ...truncate, fontSize: 12, color: REWIND_COLORS.textSecondary }}>
      {text}
    </Box>
  );
}

function MapHeading({ artist, title }: { artist?: string; title: string }) {
  const heading = `${artist ? `${artist} - ` : ""}${title}`;
  return (
    <Typography component="h1" title={heading} sx={{ ...truncate, fontSize: 15.5, fontWeight: 500, lineHeight: 1.25 }}>
      {artist && (
        <Box component="span" sx={{ color: REWIND_COLORS.textSecondary, fontWeight: 400 }}>
          {artist} -{" "}
        </Box>
      )}
      {title}
    </Typography>
  );
}

/** One line at any width: the player name gives way (ellipsis); the mod badges and the switch keep their size. */
function IdentityRow({ player, mods, ruleset }: { player?: string; mods?: string; ruleset: ReactNode }) {
  return (
    <Box data-header-identity-row sx={{ display: "flex", flexWrap: "nowrap", alignItems: "center", gap: "8px", fontSize: 12.5, minWidth: 0 }}>
      {player && (
        <Box component="span" title={player} sx={{ ...truncate, flex: "0 1 auto", minWidth: 0, fontWeight: 500, color: REWIND_COLORS.textBright }}>
          {player}
        </Box>
      )}
      <ReplayModIcons mods={replayModsFromAcronyms(mods)} height={16} />
      <Box sx={{ flex: 1, minWidth: 0 }} />
      {ruleset}
    </Box>
  );
}

/** The header while a replay is loading or has failed to load: only what the load state knows so far. */
function PendingHeader({ state, openButton }: { state: ReplayLoadState; openButton: ReactNode }) {
  const unknownMap = state.phase === "failed" && state.failure?.kind === "beatmap-not-found";
  const map = unknownMap ? undefined : state.map;
  const fileName = state.fileName;
  return (
    <Box component="header" sx={headerFrame}>
      <Box data-header-title-row sx={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
        <TitleColumn>
          {unknownMap ? (
            <>
              <Typography
                component="h1"
                sx={{ ...truncate, fontSize: 15.5, fontWeight: 500, lineHeight: 1.25, color: REWIND_COLORS.textSecondary }}
              >
                Unknown beatmap
              </Typography>
              {fileName && (
                <Box
                  component="span"
                  title={fileName}
                  sx={{ ...truncate, fontFamily: REWIND_FONTS.mono, fontSize: 11.5, color: REWIND_COLORS.textSoft }}
                >
                  {fileName}
                </Box>
              )}
            </>
          ) : map ? (
            <>
              <MapHeading artist={map.artist} title={map.title} />
              {subtitleOf(map) && <Subtitle text={subtitleOf(map)} />}
            </>
          ) : (
            <Typography
              component="h1"
              title={fileName}
              sx={{ ...truncate, fontSize: 15.5, fontWeight: 500, lineHeight: 1.25 }}
            >
              {fileName ?? "—"}
            </Typography>
          )}
        </TitleColumn>
        {openButton}
      </Box>
      <IdentityRow
        player={state.player}
        mods={state.mods}
        ruleset={state.ruleset ? <RulesetSwitch preview={state.ruleset} /> : null}
      />
    </Box>
  );
}

/** Map, player, mods and the Stable/Lazer switch (README §4.1 inspector item 1); `Rewind` and the open button before a replay. */
export function InspectorHeader() {
  const identity = useReadoutIdentity();
  const loadState = useReplayLoadState();
  const { osuFolderService } = useAnalysisApp();
  const openButton = <OpenReplayButton disabled={!osuFolderService.getOsuFolder()} />;

  if (loadState.phase === "idle") {
    return (
      <Box component="header" sx={{ ...headerFrame, flexDirection: "row", alignItems: "center", gap: "10px", minHeight: 72 }}>
        <Typography component="h1" sx={{ flex: 1, minWidth: 0, fontSize: 15.5, fontWeight: 500, color: REWIND_COLORS.textSecondary }}>
          Hindsight
        </Typography>
        {openButton}
      </Box>
    );
  }
  if (loadState.phase !== "ready") return <PendingHeader state={loadState} openButton={openButton} />;

  const heading = identity ? `${identity.artist ? `${identity.artist} - ` : ""}${identity.title}` : "No replay loaded";
  const subtitle = identity ? subtitleOf(identity) : "";
  return (
    <Box component="header" sx={headerFrame}>
      <Box data-header-title-row sx={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
        <TitleColumn>
          <Typography
            component="h1"
            title={heading}
            aria-label={identity ? undefined : heading}
            sx={{ ...truncate, fontSize: 15.5, fontWeight: 500, lineHeight: 1.25 }}
          >
            {identity?.artist && (
              <Box component="span" sx={{ color: REWIND_COLORS.textSecondary, fontWeight: 400 }}>
                {identity.artist} -{" "}
              </Box>
            )}
            {identity ? identity.title : "—"}
          </Typography>
          {subtitle && <Subtitle text={subtitle} />}
        </TitleColumn>
        {openButton}
      </Box>
      <IdentityRow player={identity?.player} mods={identity?.mods} ruleset={<RulesetSwitch />} />
      <LibraryViewerStepper/>
    </Box>
  );
}
