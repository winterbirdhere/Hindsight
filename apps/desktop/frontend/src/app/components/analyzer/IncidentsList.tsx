import { Box, ButtonBase } from "@mui/material";
import { type KeyboardEvent, memo, type Ref, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useErrorNavigation, usePlayheadIncidentIndex } from "../../hooks/error-navigation";
import { useGameClockControls } from "../../hooks/game-clock";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { nearestIncidentIndex, summarizeIncident } from "../../services/analysis/incident-summary";
import { incidentIndexOf, type Incident } from "../../services/analysis/incidents";
import type { ReplayError } from "../../services/analysis/replay-events";
import { thinScrollbar } from "../../styles/scrollbar";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { ChainedGlyph } from "./ChainedGlyph";
import { GoToTime } from "./GoToTime";
import { chainMessage, ERROR_TYPE_COLOR, memberLabeller, splitErrorTime, visuallyHidden } from "./incident-format";

/** The list never gives up less than this to a tall incident above it (about two rows). */
const INCIDENT_LIST_MIN_HEIGHT = 160;

/** The title and the time share this fixed line height; a row's height never depends on the playback mark. */
const ROW_TITLE_LINE_HEIGHT = "20px";
/** Wide enough that the playback mark (5 px, 3 px left of the time) never touches the title. */
const ROW_GAP = "10px";

/** Keys pressed on a row button stay here: they are not playback shortcuts. */
const stopKey = (event: KeyboardEvent) => event.stopPropagation();

interface RowProps {
  index: number;
  /** The compressed cause chain, e.g. `Late tap → Notelock ×5`. */
  title: string;
  /** The compressed types, e.g. `Miss ×6`. */
  types: string;
  /** Set when the lead's cause is an earlier mistake's: the title starts with the chain arrow, which says this. */
  chainNote?: string;
  leadType: ReplayError["type"];
  /** Lead time in displayed playback ms. */
  time: number;
  selected: boolean;
  /** Playback is at this incident. A mark, not a highlight. */
  playing: boolean;
  rowRef?: Ref<HTMLButtonElement>;
  onSelect(incidentIndex: number): void;
}

// Memoised on plain values: an inspection or playback change re-renders only the rows it affects, and a
// regrouping only the rows whose text changed.
const IncidentRow = memo(function IncidentRow({ index, title, types, chainNote, leadType, time, selected, playing, rowRef, onSelect }: RowProps) {
  return (
    <Box component="li">
      <ButtonBase
        ref={rowRef}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(index)}
        // A pointer click inspects without taking the focus, so the arrow-key playback shortcuts keep working.
        onMouseDown={preventPointerFocus}
        sx={{
          // The containing block of the playback mark and its hidden text, so neither can widen the list's scroller.
          position: "relative",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: "3px",
          textAlign: "left",
          p: "10px 18px",
          backgroundColor: selected ? "rgba(255,255,255,0.07)" : "transparent",
          boxShadow: `inset 3px 0 0 ${ERROR_TYPE_COLOR[leadType]}, inset 0 -1px 0 ${REWIND_COLORS.hairlineSoft}`,
          "&:hover": { backgroundColor: selected ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.05)" },
          "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: -2 },
        }}
      >
        <Box component="span" sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: ROW_GAP }}>
          <Box component="span" sx={{ minWidth: 0, fontWeight: 600, fontSize: 14, lineHeight: ROW_TITLE_LINE_HEIGHT, color: REWIND_COLORS.textPrimary }}>
            {/* 14 px inside the 20 px title line, so a chained row is as tall as any other. */}
            {chainNote && (
              <Box component="span" data-chained sx={{ display: "inline-flex", verticalAlign: "-2px", mr: "5px", color: REWIND_COLORS.textMuted }}>
                <ChainedGlyph size={14} label={chainNote} />
              </Box>
            )}
            {title}
          </Box>
          {/*
            One line of fixed height, with or without the playback mark: the mark and its text are out of flow, so a
            row is the same height in every state and the rows below never shift.
          */}
          <Box component="span" data-incident-time sx={{ flex: "none", position: "relative", height: ROW_TITLE_LINE_HEIGHT, lineHeight: ROW_TITLE_LINE_HEIGHT, whiteSpace: "nowrap" }}>
            {playing && (
              <>
                <Box
                  component="span"
                  aria-hidden
                  data-playback-position
                  sx={{ position: "absolute", top: "7.5px", right: "calc(100% + 3px)", width: "5px", height: "5px", borderRadius: "50%", backgroundColor: REWIND_COLORS.textPrimary }}
                />
                <Box component="span" sx={visuallyHidden}>
                  {" (playback position)"}
                </Box>
              </>
            )}
            <Box component="span" sx={{ fontFamily: REWIND_FONTS.mono, fontSize: 12, color: selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textSoft }}>
              {splitErrorTime(time).join("")}
            </Box>
          </Box>
        </Box>
        <Box component="span" sx={{ fontSize: 12.5, lineHeight: "18px", color: REWIND_COLORS.textSecondary }}>
          {types}
        </Box>
      </ButtonBase>
    </Box>
  );
});

/** A row's place on screen: the error it stands for and its distance from the top of the list's viewport. */
interface Anchor {
  errorIndex: number;
  offset: number;
}

/**
 * One row per incident, style B: a left bar in the lead type's colour and neutral text (README §4.1).
 *
 * The list scrolls on its own only after an explicit navigation (`revealToken`), never because of playback
 * or Follow. It keeps its position through hiding/showing the inspector and through a regrouping.
 */
export function IncidentsList() {
  const { errors, incidents, selectedIndex, selectIncident, causes, displayMode, revealToken, listScrollTop } = useErrorNavigation();
  const { baseRate } = useGameClockControls();
  // Re-rendered with the provider whenever a replay loads or closes.
  const hasReplay = Boolean(useAnalysisApp().gameSimulator.getPrimaryReplay());
  // Changes when playback reaches another incident, not on every clock tick.
  const playingIncident = usePlayheadIncidentIndex();
  const selectedIncident = selectedIndex >= 0 ? incidentIndexOf(incidents, selectedIndex) : -1;
  const summaries = useMemo(() => {
    const labelOf = memberLabeller(errors, causes, displayMode);
    return incidents.map((incident) => {
      const chain = labelOf(incident.leadIndex).chain;
      return { ...summarizeIncident(incident, labelOf), chainNote: chain && chainMessage(chain.startMs, chain.cause, baseRate) };
    });
  }, [incidents, errors, causes, displayMode, baseRate]);
  // A list click inspects the incident and leaves the list where it is.
  const onSelect = useCallback((incidentIndex: number) => selectIncident(incidentIndex, { reveal: false }), [selectIncident]);
  const goToTime = useCallback(
    (displayedMs: number) => {
      // The field is in displayed playback time; errors are in map time.
      const incidentIndex = nearestIncidentIndex(incidents, errors, displayedMs * baseRate);
      if (incidentIndex < 0) return false;
      selectIncident(incidentIndex);
      return true;
    },
    [incidents, errors, baseRate, selectIncident],
  );

  const list = useRef<HTMLUListElement | null>(null);
  const selectedRow = useRef<HTMLButtonElement | null>(null);

  // Explicit navigation (arrows, density pick, time entry, member pick) brings the inspected row into view.
  const revealed = useRef(revealToken);
  useEffect(() => {
    if (revealed.current === revealToken) return;
    revealed.current = revealToken;
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [revealToken]);

  /** The inspected row when it is in view, else the first row in view. */
  const measureAnchor = useCallback((): Anchor | undefined => {
    const scroller = list.current;
    if (!scroller || incidents.length === 0) return undefined;
    const view = scroller.getBoundingClientRect();
    const inView = (rect: DOMRect) => rect.bottom > view.top && rect.top < view.bottom;
    const inspected = selectedIncident >= 0 ? scroller.children[selectedIncident] : undefined;
    if (inspected) {
      const rect = inspected.getBoundingClientRect();
      if (inView(rect)) return { errorIndex: selectedIndex, offset: rect.top - view.top };
    }
    for (let index = 0; index < incidents.length; index++) {
      const row = scroller.children[index];
      if (!row) break;
      const rect = row.getBoundingClientRect();
      if (inView(rect)) return { errorIndex: incidents[index].leadIndex, offset: rect.top - view.top };
    }
    return undefined;
  }, [incidents, selectedIncident, selectedIndex]);

  // What was on screen before this render, so a regrouping can put it back.
  const laidOut = useRef<{ errors: ReplayError[]; incidents: Incident[]; anchor?: Anchor } | undefined>(undefined);
  useLayoutEffect(() => {
    const scroller = list.current;
    if (!scroller) return;
    const before = laidOut.current;
    if (!before) {
      // Shown (again): back to where the list was. The provider outlives the inspector.
      scroller.scrollTop = listScrollTop.current;
    } else if (before.errors !== errors) {
      // Another replay, profile or event stream is another list.
      scroller.scrollTop = 0;
      listScrollTop.current = 0;
    } else if (before.incidents !== incidents && before.anchor) {
      // The same errors, grouped anew (the analysis arrived): keep the anchored row where it was.
      const row = scroller.children[incidentIndexOf(incidents, before.anchor.errorIndex)];
      if (row) {
        const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const shift = offset - before.anchor.offset;
        if (shift !== 0) {
          scroller.scrollTop = Math.max(0, scroller.scrollTop + shift);
          listScrollTop.current = scroller.scrollTop;
        }
      }
    }
    laidOut.current = { errors, incidents, anchor: measureAnchor() };
  });
  const onScroll = () => {
    if (!list.current) return;
    listScrollTop.current = list.current.scrollTop;
    if (laidOut.current) laidOut.current.anchor = measureAnchor();
  };

  return (
    <Box component="section" aria-label="Incidents" sx={{ flex: 1, minHeight: INCIDENT_LIST_MIN_HEIGHT, display: "flex", flexDirection: "column" }}>
      <Box sx={{ p: "10px 18px 6px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <Box component="span" sx={{ display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 }}>
          <Box component="span" sx={{ flex: "none", fontWeight: 600, fontSize: 13.5 }}>
            Incidents
          </Box>
          {incidents.length > 0 && (
            <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontSize: 12, color: REWIND_COLORS.textTertiary, whiteSpace: "nowrap" }}>
              {incidents.length}
            </Box>
          )}
        </Box>
        {incidents.length > 0 && <GoToTime onGo={goToTime} />}
      </Box>
      <Box
        component="ul"
        ref={list}
        aria-label="Incidents"
        onScroll={onScroll}
        onKeyDown={stopKey}
        sx={{ listStyle: "none", m: 0, p: 0, overflowY: "auto", overflowX: "hidden", flex: 1, minHeight: 0, ...thinScrollbar }}
      >
        {incidents.length === 0 && (
          <Box component="li" sx={{ p: "10px 18px", fontSize: 13, color: REWIND_COLORS.textTertiary }}>
            {hasReplay ? "No errors" : "—"}
          </Box>
        )}
        {incidents.map((incident, index) => (
          <IncidentRow
            key={incident.id}
            index={index}
            title={summaries[index].causeChain}
            types={summaries[index].typeChain}
            chainNote={summaries[index].chainNote}
            leadType={errors[incident.leadIndex].type}
            time={errors[incident.leadIndex].time / baseRate}
            selected={index === selectedIncident}
            playing={index === playingIncident}
            rowRef={index === selectedIncident ? selectedRow : undefined}
            onSelect={onSelect}
          />
        ))}
      </Box>
    </Box>
  );
}
