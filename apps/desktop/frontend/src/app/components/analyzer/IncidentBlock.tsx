import { Box, ButtonBase, Typography } from "@mui/material";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import { memo, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useErrorNavigation } from "../../hooks/error-navigation";
import { useGameClockControls, useGameClockTime } from "../../hooks/game-clock";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import {
  formatRun,
  type MemberRun,
  nextIncidentIndex,
  previousIncidentIndex,
  REPLAY_SPEEDS,
  type ReplaySpeed,
  summarizeIncident,
} from "../../services/analysis/incident-summary";
import { buildDensityBins, incidentIndexOf, type Incident } from "../../services/analysis/incidents";
import type { ReplayError } from "../../services/analysis/replay-events";
import { thinScrollbar } from "../../styles/scrollbar";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { ChainedGlyph } from "./ChainedGlyph";
import { DensityBar } from "./DensityBar";
import { type CauseDetail, formatCauseDetail, presentCause, type TapTiming } from "./error-cause-presentation";
import { HitWindowDiagram } from "./HitWindowDiagram";
import {
  chainMessage,
  EMPTY_CAUSES,
  ERROR_TYPE_COLOR,
  errorTypeLabel,
  formatIncidentPosition,
  memberLabeller,
  quietTextButton,
  splitErrorTime,
  visuallyHidden,
} from "./incident-format";
import { IncidentMembers } from "./IncidentMembers";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";

// Other files import these from here.
export { ERROR_TYPE_COLOR, errorTypeLabel, splitErrorTime };

/**
 * The area under the navigator (prompt, lead entry, runs, Show / Hide, members) has one fixed flex basis and
 * scrolls inside, so inspecting, following, expanding and collapsing never move or resize the incidents list.
 * Only a short window shrinks it (down to `INCIDENT_BODY_MIN_HEIGHT`).
 */
export const INCIDENT_BODY_HEIGHT = 236;
/** In a window too short for the full body, it shrinks with the window down to this, and still scrolls inside. */
export const INCIDENT_BODY_MIN_HEIGHT = 96;

const stepButton = {
  width: 28,
  height: 28,
  borderRadius: "5px",
  color: REWIND_COLORS.textBright,
  "&:hover": { backgroundColor: "rgba(255,255,255,0.08)", color: REWIND_COLORS.white },
  "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
  "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: 1 },
} as const;

const PreviousGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <rect x="0.5" y="1" width="1.6" height="8" fill="currentColor" />
    <polygon points="9.5,1 9.5,9 3,5" fill="currentColor" />
  </svg>
);
const NextGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <polygon points="0.5,1 0.5,9 7,5" fill="currentColor" />
    <rect x="7.9" y="1" width="1.6" height="8" fill="currentColor" />
  </svg>
);

interface EntryProps {
  error: ReplayError;
  mechanisms: readonly ComponentMechanism[];
  displayMode: "concise" | "brief";
  lead: boolean;
  announce: boolean;
  /** Label of the entry directly above, when a notelock link to it is proven. */
  lockedBy?: string;
  baseRate: number;
  /** The profile the causes were computed for; the diagram draws that profile's hit windows. */
  ruleset: ReplayAnalysisRuleset;
  /** The chain message of a chained error: show the earlier press (map time) that caused it. */
  onGoToChainStart(timeMs: number): void;
}

/** `Caused by early tap at 1:10.192` under a chained headline: quiet text, underlined because it is the way there. */
const chainMessageButton = {
  alignSelf: "flex-start",
  justifyContent: "flex-start",
  textAlign: "left",
  borderRadius: "3px",
  fontSize: 13,
  lineHeight: 1.35,
  color: REWIND_COLORS.textSecondary,
  textDecoration: "underline",
  textDecorationColor: "rgba(255,255,255,0.25)",
  textUnderlineOffset: "3px",
  "&:hover": { color: REWIND_COLORS.textPrimary, textDecorationColor: "currentColor" },
  "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: 2 },
} as const;
const CHAIN_MESSAGE_TITLE = "Go to the earlier mistake";

/**
 * Brief detail without what is already on the screen: a locked follow-up shows no timing at all, and a
 * metric that is the tap offset is not printed again (the offset is on the hit-window diagram).
 */
function visibleDetail(detail: CauseDetail, timing: TapTiming | undefined, locked: boolean): CauseDetail {
  if (!detail.metric) return detail;
  const metricText = `${Math.round(detail.metric.value)} ${detail.metric.unit}`;
  return locked || metricText === timing?.text ? { phrase: detail.phrase } : detail;
}

const ErrorEntry = memo(function ErrorEntry({ error, mechanisms, displayMode, lead, announce, lockedBy, baseRate, ruleset, onGoToChainStart }: EntryProps) {
  const presentation = presentCause(mechanisms, displayMode);
  const [time, milliseconds] = splitErrorTime(error.time / baseRate);
  // A chained error shows an earlier mistake's cause; that mistake's offset and detail are not this error's.
  const chainStartMs = presentation?.chainStartMs;
  const chained = chainStartMs !== undefined;
  const timing = lockedBy || chained ? undefined : presentation?.timing;
  const headlineColor = presentation && lead ? REWIND_COLORS.textPrimary : REWIND_COLORS.textMuted;
  const typeLabel = errorTypeLabel(error);
  const headline = presentation ? presentation.labels.join(" · ") : typeLabel;
  const detail =
    presentation?.detail && !chained ? formatCauseDetail(visibleDetail(presentation.detail, timing, Boolean(lockedBy))) : "";
  const heading = (
    <Typography component="h2" sx={{ fontSize: 24, fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: headlineColor }}>
      {headline}
    </Typography>
  );
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <Box
          role={presentation && announce ? "status" : undefined}
          aria-label={presentation && announce ? "Error cause" : undefined}
          sx={{ display: "flex", flexDirection: "column", gap: "6px" }}
        >
          {chainStartMs !== undefined ? (
            <>
              <Box data-chained sx={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <Box component="span" sx={{ display: "inline-flex", flex: "none", color: REWIND_COLORS.textMuted }}>
                  <ChainedGlyph size={20} />
                </Box>
                {heading}
              </Box>
              <ButtonBase
                data-chain-message
                title={CHAIN_MESSAGE_TITLE}
                onClick={() => onGoToChainStart(chainStartMs)}
                onMouseDown={preventPointerFocus}
                sx={chainMessageButton}
              >
                {chainMessage(chainStartMs, presentation?.chainCause, baseRate)}
              </ButtonBase>
            </>
          ) : (
            heading
          )}
          {detail && (
            <Box component="span" sx={{ order: 2, position: "relative", fontSize: 13, color: REWIND_COLORS.textSecondary }}>
              <Box component="span" sx={visuallyHidden}>
                {" · "}
              </Box>
              {detail}
            </Box>
          )}
        </Box>
        {/* Type and time; the tap offset is on the hit-window diagram below, so it is not printed here. */}
        <Box component="span" data-incident-entry-line sx={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: "8px", rowGap: "2px", fontSize: 14 }}>
          {presentation && (
            <Box component="span" sx={{ flex: "none", whiteSpace: "nowrap", fontWeight: 600, color: ERROR_TYPE_COLOR[error.type] }}>
              {typeLabel}
            </Box>
          )}
          <Box component="span" sx={{ flex: "none", whiteSpace: "nowrap", fontFamily: REWIND_FONTS.mono, fontWeight: 500, fontSize: 20, lineHeight: 1, letterSpacing: "-0.01em", color: REWIND_COLORS.white }}>
            {time}
            <Box component="span" sx={{ color: REWIND_COLORS.textMuted }}>
              {milliseconds}
            </Box>
          </Box>
        </Box>
        {lockedBy && (
          <Box component="span" sx={{ fontSize: 13, color: REWIND_COLORS.textSecondary }}>
            {`Locked by the ${lockedBy.toLowerCase()} above`}
          </Box>
        )}
      </Box>
      {timing && <HitWindowDiagram offsetMs={timing.offsetMs} ruleset={ruleset} />}
    </Box>
  );
});

function lockedByAbove(incident: Incident, position: number, errors: readonly ReplayError[]): string | undefined {
  if (position === 0) return undefined;
  const above = incident.errorIndices[position - 1];
  const here = incident.errorIndices[position];
  return incident.links.some((link) => link.kind === "notelock" && link.from === above && link.to === here)
    ? errorTypeLabel(errors[above])
    : undefined;
}

/** A step leaves Follow as it was; the density bar and the list are manual selections and turn it off. */
const STEP_OPTIONS = { keepFollowing: true } as const;

/**
 * Previous / next incident, always relative to the playhead (inspecting an incident seeks to its lead error, so
 * repeated presses still walk one incident at a time). This small child reads the clock; the density bar is passed
 * through as `children`, so a tick here does not re-render it.
 */
function IncidentNavigator({
  incidents,
  errors,
  onSelect,
  children,
}: {
  incidents: readonly Incident[];
  errors: readonly ReplayError[];
  onSelect(incidentIndex: number, options: typeof STEP_OPTIONS): void;
  children: ReactNode;
}) {
  const currentTime = useGameClockTime(15);
  const from = { timeMs: currentTime };
  const previousIndex = previousIncidentIndex(incidents, errors, from);
  const nextIndex = nextIncidentIndex(incidents, errors, from);
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) 28px", alignItems: "center", gap: "8px", mt: "-6px" }}>
      <ButtonBase aria-label="Previous incident" disabled={previousIndex < 0} onClick={() => onSelect(previousIndex, STEP_OPTIONS)} onMouseDown={preventPointerFocus} sx={stepButton}>
        <PreviousGlyph />
      </ButtonBase>
      {children}
      <ButtonBase aria-label="Next incident" disabled={nextIndex < 0} onClick={() => onSelect(nextIndex, STEP_OPTIONS)} onMouseDown={preventPointerFocus} sx={stepButton}>
        <NextGlyph />
      </ButtonBase>
    </Box>
  );
}

/** `→ Notelock ×5` over `Miss ×5 · 1:04.661 – 1:04.989`: one compact line pair per run of equal members. */
function RunSummary({ run, errors, baseRate }: { run: MemberRun; errors: readonly ReplayError[]; baseRate: number }) {
  const count = run.errorIndices.length;
  const time = (errorIndex: number) => splitErrorTime(errors[errorIndex].time / baseRate).join("");
  const first = time(run.errorIndices[0]);
  const span = count > 1 ? `${first} – ${time(run.errorIndices[count - 1])}` : first;
  // With no cause the type is the label above; it is not printed a second time.
  const detail = run.label === run.type ? span : `${formatRun(run.type, count)} · ${span}`;
  return (
    <Box data-incident-run sx={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <Box sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.25, color: REWIND_COLORS.textMuted }}>
        {`→ ${formatRun(run.label, count)}`}
      </Box>
      {/* One line at any width: a narrow inspector ends it with an ellipsis (the full text is the title). */}
      <Box
        data-incident-run-times
        title={detail}
        sx={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 12.5,
          color: REWIND_COLORS.textSecondary,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {detail}
      </Box>
    </Box>
  );
}

const speedLabel = (speed: ReplaySpeed) => `${speed}×`;

const replaySpeedButton = {
  flex: "none",
  height: 24,
  px: "7px",
  borderRadius: "5px",
  fontFamily: REWIND_FONTS.mono,
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: "nowrap",
  color: REWIND_COLORS.textBright,
  backgroundColor: "transparent",
  "&:hover": { backgroundColor: "rgba(255,255,255,0.07)" },
  "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
  "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: 1 },
} as const;

/**
 * `REPLAY  0.25× 0.5× 1×`: each speed plays the inspected incident once at that speed, from 1.5 s of real time before
 * it, then stops and gives the viewer's own speed back. The button of the replay that is playing is marked; the row
 * is not a control of the viewer's speed.
 */
function ReplayRow({
  disabled,
  playing,
  onReplay,
}: {
  disabled: boolean;
  playing: ReplaySpeed | undefined;
  onReplay(speed: ReplaySpeed): void;
}) {
  return (
    // 28 px of controls area (the buttons are 24 px), one line at the narrowest inspector (about 170 of 204 px).
    <Box data-replay-row sx={{ display: "flex", alignItems: "center", gap: "8px", minHeight: 28, my: "-6px" }}>
      <Box
        component="span"
        data-replay-label
        aria-hidden
        sx={{
          flex: "none",
          fontFamily: REWIND_FONTS.mono,
          fontWeight: 500,
          fontSize: 11,
          letterSpacing: "0.08em",
          color: REWIND_COLORS.textTertiary,
        }}
      >
        REPLAY
      </Box>
      <Box role="group" aria-label="Replay selection" sx={{ flex: "none", display: "flex", alignItems: "center", gap: "2px" }}>
        {REPLAY_SPEEDS.map((speed) => {
          const active = playing === speed;
          return (
            <ButtonBase
              key={speed}
              aria-label={`Replay at ${speedLabel(speed)} speed`}
              aria-pressed={active}
              title="Play this incident once at this speed"
              disabled={disabled}
              onClick={() => onReplay(speed)}
              onMouseDown={preventPointerFocus}
              sx={{
                ...replaySpeedButton,
                ...(active ? { color: REWIND_COLORS.textPrimary, backgroundColor: "rgba(255,255,255,0.12)" } : {}),
                "&:hover": { backgroundColor: active ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.07)" },
              }}
            >
              {speedLabel(speed)}
            </ButtonBase>
          );
        })}
      </Box>
    </Box>
  );
}

/** The idle label: the error count only. The incident count is beside the list's title, and a longer label is cut off. */
function countLabel(errors: number): string {
  return `${errors} ${errors === 1 ? "ERROR" : "ERRORS"}`;
}

/**
 * Label, Follow, navigator, density bar, the inspected incident and Replay (spec §5.9).
 *
 * This component is the only reader of the navigation state and never reads the clock: it renders when the
 * inspection changes, not on a clock tick. The two ticking parts (step buttons, playhead mark) are small
 * children. The body under the navigator has a fixed height (`INCIDENT_BODY_HEIGHT`).
 */
export function IncidentBlock() {
  const {
    errors,
    incidents,
    selectedIndex,
    selectError,
    selectIncident,
    following,
    setFollowing,
    expanded,
    toggleExpanded,
    replaySelection,
    replayingSpeed,
    causes,
    analysisStatus,
    displayMode,
    ruleset,
  } = useErrorNavigation();
  const { duration, baseRate, seekTo, pause } = useGameClockControls();
  const hasReplay = Boolean(useAnalysisApp().gameSimulator.getPrimaryReplay());
  // Paused on the earlier press with Follow off, so the chained error stays inspected while the user watches from there.
  const goToChainStart = useCallback(
    (timeMs: number) => {
      setFollowing(false);
      pause();
      seekTo(timeMs);
    },
    [setFollowing, pause, seekTo],
  );

  const incidentIndex = selectedIndex >= 0 ? incidentIndexOf(incidents, selectedIndex) : -1;
  const incident = incidentIndex >= 0 ? incidents[incidentIndex] : undefined;
  const label = incident
    ? formatIncidentPosition(incident.errorIndices, errors.length)
    : errors.length
    ? countLabel(errors.length)
    : hasReplay
    ? "NO ERRORS"
    : "—";
  const bins = useMemo(() => buildDensityBins(incidents, errors, duration), [incidents, errors, duration]);
  const labelOf = useMemo(() => memberLabeller(errors, causes, displayMode), [errors, causes, displayMode]);
  const followers = useMemo(() => (incident ? summarizeIncident(incident, labelOf).followers : []), [incident, labelOf]);
  const followerCount = incident ? incident.errorIndices.length - 1 : 0;
  // The body scrolls inside its fixed height; a different incident starts at the top, the same one keeps its position.
  const body = useRef<HTMLDivElement>(null);
  const incidentId = incident?.id;
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [incidentId]);
  // While a non-lead member is inspected its row must stay on screen, so the members cannot be hidden.
  const memberInspected = Boolean(incident && followerCount > 1 && selectedIndex !== incident.leadIndex);
  const membersShown = Boolean(incident && followerCount > 1 && (expanded.has(incident.id) || memberInspected));
  // Set by a click on Show; once the members are on screen they are brought into view inside the body (and
  // nothing else is scrolled). Not for members shown because one is inspected, nor for the initial render.
  const membersBox = useRef<HTMLDivElement>(null);
  const revealMembers = useRef(false);
  useLayoutEffect(() => {
    const reveal = revealMembers.current;
    revealMembers.current = false;
    if (reveal && membersShown) membersBox.current?.scrollIntoView?.({ block: "nearest" });
  }, [membersShown]);
  const entry = (errorIndex: number, position: number) =>
    incident && (
      <ErrorEntry
        error={errors[errorIndex]}
        mechanisms={causes.get(errors[errorIndex].id) ?? EMPTY_CAUSES}
        displayMode={displayMode}
        lead={position === 0}
        // Only an inspected error with Follow off is announced; a followed incident is shown silently.
        announce={!following && errorIndex === selectedIndex}
        lockedBy={lockedByAbove(incident, position, errors)}
        baseRate={baseRate}
        ruleset={ruleset}
        onGoToChainStart={goToChainStart}
      />
    );

  return (
    <Box
      component="section"
      aria-label="Current incident"
      // Label row, navigator, body and Replay row. Its height changes only with the window (the body is the part
      // that shrinks), never with what is inspected, followed or expanded, so the incidents list keeps its minimum.
      sx={{
        flex: "0 1 auto",
        minHeight: 0,
        p: "18px 18px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        boxShadow: `inset 0 -1px 0 ${REWIND_COLORS.hairline}`,
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", minHeight: 28, mt: "-6px" }}>
          {/* One line at any width (the block's height must not change); the full text is the title. */}
          <Box
            component="span"
            title={label}
            data-incident-label
            sx={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: REWIND_FONTS.mono,
              fontWeight: 500,
              fontSize: 11,
              letterSpacing: "0.08em",
              color: REWIND_COLORS.textTertiary,
            }}
          >
            {label}
          </Box>
          {errors.length > 0 && (
            <ButtonBase
              aria-pressed={following}
              title="Follow playback by incident"
              onClick={() => setFollowing(!following)}
              onMouseDown={preventPointerFocus}
              sx={{
                ...quietTextButton,
                flex: "none",
                mr: "-8px",
                ...(following ? { color: REWIND_COLORS.textPrimary, backgroundColor: "rgba(255,255,255,0.12)" } : {}),
                "&:hover": { backgroundColor: following ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.07)", color: REWIND_COLORS.textPrimary },
              }}
            >
              Follow
            </ButtonBase>
          )}
        </Box>
        {analysisStatus && (
          <Typography
            role="status"
            aria-label="Error analysis status"
            aria-live="polite"
            aria-atomic="true"
            sx={{ fontSize: 12, color: REWIND_COLORS.textTertiary }}
          >
            {analysisStatus}
          </Typography>
        )}
      </Box>
      <IncidentNavigator incidents={incidents} errors={errors} onSelect={selectIncident}>
        <DensityBar bins={bins} incidents={incidents} errors={errors} labelOf={labelOf} duration={duration} baseRate={baseRate} onSelect={selectIncident} />
      </IncidentNavigator>
      <Box
        ref={body}
        data-incident-scroll
        sx={{
          // A 236 px basis (never content-dependent); only a short window shrinks it, down to the minimum.
          flex: `0 1 ${INCIDENT_BODY_HEIGHT}px`,
          minHeight: INCIDENT_BODY_MIN_HEIGHT,
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          // 8 px of side padding inside the block's 18 px: hover fills and focus rings of the members and of
          // Show / Hide lie inside the scroller instead of being cut off or making it scroll sideways.
          mx: "-8px",
          px: "8px",
          overflowY: "auto",
          overflowX: "hidden",
          // Taller content scrolls; nothing is squeezed to fit.
          "& > *": { flexShrink: 0 },
          ...thinScrollbar,
        }}
      >
        {incident ? (
          <>
            {entry(incident.leadIndex, 0)}
            {followerCount > 0 && <Box aria-hidden sx={{ flex: "none", height: "1px", backgroundColor: REWIND_COLORS.hairline }} />}
            {followerCount === 1 && entry(incident.errorIndices[1], 1)}
            {followerCount > 1 && (
              <Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {followers.map((run) => (
                  <RunSummary key={errors[run.errorIndices[0]].id} run={run} errors={errors} baseRate={baseRate} />
                ))}
                <ButtonBase
                  aria-expanded={membersShown}
                  disabled={memberInspected}
                  title={memberInspected ? "A member is selected" : undefined}
                  onClick={() => {
                    revealMembers.current = !membersShown;
                    toggleExpanded(incident.id);
                  }}
                  onMouseDown={preventPointerFocus}
                  sx={{
                    ...quietTextButton,
                    flex: "none",
                    alignSelf: "flex-start",
                    ml: "-8px",
                    mt: "-4px",
                    // Inside the scroller's padding box, so the ring is drawn inwards.
                    "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: -2 },
                    // Disabled, but still hoverable so the title can say why.
                    "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary, pointerEvents: "auto", cursor: "default" },
                  }}
                >
                  {membersShown ? "Hide" : `Show ${followerCount}`}
                </ButtonBase>
                {membersShown && (
                  <div ref={membersBox} data-incident-members>
                    <IncidentMembers
                      incident={incident}
                      errors={errors}
                      causes={causes}
                      displayMode={displayMode}
                      selectedIndex={selectedIndex}
                      announce={!following}
                      baseRate={baseRate}
                      onSelect={selectError}
                    />
                  </div>
                )}
              </Box>
            )}
          </>
        ) : (
          errors.length > 0 && (
            <Box sx={{ fontSize: 13, color: REWIND_COLORS.textTertiary }}>Select an incident, or follow playback.</Box>
          )
        )}
      </Box>
      {errors.length > 0 && <ReplayRow disabled={!incident} playing={replayingSpeed} onReplay={replaySelection} />}
    </Box>
  );
}
