import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import { useObservable } from "rxjs-hooks";
import type { ComponentMechanism } from "../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { useGameClockControls } from "./game-clock";
import { summarizeReplayEvents, type ReplayError } from "../services/analysis/replay-events";
import type { ReplayDisplaySettings } from "../services/analysis/replay-display-settings";
import { selectedErrorCauses } from "../components/analyzer/error-cause";
import { groupIncidents, incidentIndexOf, type Incident } from "../services/analysis/incidents";
import {
  incidentIndexAtOrBefore,
  replayEndTime,
  replayStartTime,
  type ReplaySpeed,
} from "../services/analysis/incident-summary";
import { useInterval } from "./interval";
import { createErrorAnalysisLookups } from "../services/analysis/error-analysis-lookups";
import { useReplayLoadState } from "./replay-load-state";

/**
 * List/inspection/cause state. It deliberately excludes the playback clock, so the incident block
 * and the incident list do not re-render on every clock tick.
 *
 * Inspection is separate from playback (spec §5.9 A): the inspected error stays put while the replay
 * plays and when the user seeks. It changes only by an explicit selection, or by incident while
 * `following` is on (it is on from the start).
 */
export interface ErrorNavigationState {
  errors: ReplayError[];
  /** The inspected error index; -1 when nothing is inspected. A seek does not clear it. */
  selectedIndex: number;
  /** Manual: inspect this error, turn Follow off, pause, seek to the error and request a reveal. */
  selectError(index: number): void;
  /**
   * The same for an incident's lead error. List clicks pass `reveal: false`, so the list stays where it is. The
   * Previous / Next buttons pass `keepFollowing: true`: the step leaves Follow as it was.
   */
  selectIncident(incidentIndex: number, options?: { reveal?: boolean; keepFollowing?: boolean }): void;
  /** The inspection follows playback by incident. It never seeks, pauses or reveals. */
  following: boolean;
  setFollowing(on: boolean): void;
  /** Ids of the incidents whose members are shown. */
  expanded: ReadonlySet<string>;
  toggleExpanded(incidentId: string): void;
  /**
   * Plays the inspected incident once at `speed`: from 1.5 s of real time before it to 1.2 s after its last error.
   * Then playback stops, the viewer's own speed comes back and the playhead returns to the inspected error. A pause
   * or a seek on the way ends it early and gives the speed back where the playhead is. The inspection is kept.
   */
  replaySelection(speed: ReplaySpeed): void;
  /** The speed of the incident replay that is playing; undefined while none is. */
  replayingSpeed?: ReplaySpeed;
  /** Increments on an explicit navigation; the list scrolls the inspected row into view when it changes. */
  revealToken: number;
  /** The list keeps its scroll position here, so it survives hiding and showing the inspector. */
  listScrollTop: { current: number };
  causes: ReadonlyMap<string, readonly ComponentMechanism[]>;
  incidents: Incident[];
  analysisStatus?: string;
  displayMode: ReplayDisplaySettings["errorCauseDisplay"];
  /** The ruleset the errors, causes and incidents were computed for. */
  ruleset: ReplayAnalysisRuleset;
}

const ErrorNavigationContext = createContext<ErrorNavigationState | undefined>(undefined);

/** Playhead-driven state is sampled at this rate; a sample that changes nothing costs no render. */
const PLAYHEAD_SAMPLE_MS = 1000 / 15;
const NOTHING_EXPANDED: ReadonlySet<string> = new Set();

/** The inspection and what it belongs to: one replay, one ruleset, one event stream, one grouping. */
interface Inspection {
  events: ReplayAnalysisEvent[];
  ruleset: ReplayAnalysisRuleset;
  replay: unknown;
  incidents: Incident[];
  index: number;
  following: boolean;
  expanded: ReadonlySet<string>;
  revealToken: number;
}

/**
 * The lead error of the incident the playhead has most recently reached; -1 with no errors, and -1 before the
 * first one is reached, so a fresh replay (Follow is on from the start) shows the idle inspector at time 0.
 */
function followedLead(incidents: readonly Incident[], errors: readonly ReplayError[], timeMs: number): number {
  if (!errors.some((error) => error.time <= timeMs + 1)) return -1;
  const incident = incidents[incidentIndexAtOrBefore(incidents, errors, timeMs)];
  return incident ? incident.leadIndex : -1;
}

/**
 * The same errors, grouped anew (the analysis arrived). The inspected error index is untouched; expansion
 * survives for incidents that still exist. If the inspected error is now a hidden member of a longer
 * incident, that incident opens, so the inspected error stays on screen.
 */
function regroup(current: Inspection, incidents: Incident[], followed: number): Inspection {
  const ids = new Set(incidents.map((incident) => incident.id));
  const expanded = new Set([...current.expanded].filter((id) => ids.has(id)));
  const index = current.following ? followed : current.index;
  const incident = current.following ? undefined : incidents[incidentIndexOf(incidents, index)];
  if (incident && incident.leadIndex !== index && incident.errorIndices.length > 2) expanded.add(incident.id);
  return { ...current, incidents, index, expanded: expanded.size ? expanded : NOTHING_EXPANDED };
}

export function ErrorNavigationProvider({ children }: { children: ReactNode }) {
  const analyzer = useAnalysisApp();
  const { gameSimulator, gameClock } = analyzer;
  const displaySettings = useObservable(
    () => analyzer.replayDisplaySettingsStore.settings$,
    analyzer.replayDisplaySettingsStore.settings,
  );
  const replayEvents = useObservable(() => gameSimulator.replayEvents$, []);
  const rulesetFocus = useObservable(() => gameSimulator.rulesetFocus$, "stable");
  const replay = gameSimulator.getPrimaryReplay();
  const { seekTo, pause, start, baseRate, setSpeed } = useGameClockControls();
  const missSession = useObservable(() => gameSimulator.missExplanations$, gameSimulator.missExplanations$.value);
  const progress = useObservable(() => gameSimulator.missAnalysisProgress$, gameSimulator.missAnalysisProgress$.value);
  const loadState = useReplayLoadState();
  const { errors } = useMemo(() => summarizeReplayEvents(replayEvents, rulesetFocus), [replayEvents, rulesetFocus]);

  // M61: start the existing miss-explanation session automatically; failures are terminal for this load.
  useEffect(() => {
    if (
      loadState.phase === "ready" &&
      gameSimulator.hasReplayForMissAnalysis() &&
      gameSimulator.missExplanations$.value.status === "not-captured"
    ) {
      void gameSimulator.analyzeMisses();
    }
  }, [gameSimulator, replay, rulesetFocus, missSession.status, loadState.phase]);

  // One pass per session change; never per clock tick (review focus 4).
  const lookups = useMemo(
    () => createErrorAnalysisLookups(replayEvents, rulesetFocus, missSession),
    [replayEvents, rulesetFocus, missSession],
  );
  const causes = useMemo(
    () =>
      new Map(
        errors.map((error) => [error.id, selectedErrorCauses(error, replayEvents, rulesetFocus, missSession, lookups)]),
      ),
    [errors, replayEvents, rulesetFocus, missSession, lookups],
  );
  // Simulator notelock links exist before (and without) the analysis; a ready analysis can add proven ones.
  const incidents = useMemo(
    () => groupIncidents(errors, replayEvents, rulesetFocus, missSession, lookups),
    [errors, replayEvents, rulesetFocus, missSession, lookups],
  );

  const [stored, setInspection] = useState<Inspection>(() => ({
    events: replayEvents,
    ruleset: rulesetFocus,
    replay,
    incidents,
    index: -1,
    following: true,
    expanded: NOTHING_EXPANDED,
    revealToken: 0,
  }));
  // Derived while rendering, so no render ever pairs an old index with a new error list.
  let inspection = stored;
  if (stored.events !== replayEvents || stored.ruleset !== rulesetFocus || stored.replay !== replay) {
    // The inspection belongs to one replay/profile/event stream. A seek is not in this list.
    inspection = {
      ...stored,
      events: replayEvents,
      ruleset: rulesetFocus,
      replay,
      incidents,
      index: stored.following ? followedLead(incidents, errors, gameClock.timeElapsedInMs) : -1,
      expanded: NOTHING_EXPANDED,
    };
    setInspection(inspection);
  } else if (stored.incidents !== incidents) {
    inspection = regroup(stored, incidents, followedLead(incidents, errors, gameClock.timeElapsedInMs));
    setInspection(inspection);
  }
  const { index: selectedIndex, following, expanded, revealToken } = inspection;

  const listScrollTop = useRef(0);
  // Another replay/profile/event stream is another list: it starts at the top, also when it is shown later.
  useEffect(() => {
    listScrollTop.current = 0;
  }, [replayEvents, rulesetFocus, replay]);

  const inspect = useCallback(
    (index: number, reveal: boolean, keepFollowing = false) => {
      if (index < 0 || index >= errors.length) return;
      setInspection((current) => ({
        ...current,
        index,
        // With Follow on, the seek below puts the playhead at this incident's lead, where the sampler agrees.
        following: keepFollowing ? current.following : false,
        revealToken: current.revealToken + (reveal ? 1 : 0),
      }));
      pause();
      seekTo(errors[index].time);
    },
    [errors, pause, seekTo],
  );
  const selectError = useCallback((index: number) => inspect(index, true), [inspect]);
  const selectIncident = useCallback(
    (incidentIndex: number, options?: { reveal?: boolean; keepFollowing?: boolean }) => {
      const incident = incidents[incidentIndex];
      if (incident) inspect(incident.leadIndex, options?.reveal !== false, options?.keepFollowing === true);
    },
    [incidents, inspect],
  );

  const setFollowing = useCallback(
    (on: boolean) => {
      // Turning Follow on applies it at once; turning it off leaves the last followed incident inspected.
      const lead = on ? followedLead(incidents, errors, gameClock.timeElapsedInMs) : -1;
      setInspection((current) => {
        if (on)
          return current.following && current.index === lead ? current : { ...current, following: true, index: lead };
        return current.following ? { ...current, following: false } : current;
      });
    },
    [incidents, errors, gameClock],
  );
  // Follow tracks the incident at the playhead. It only sets state when that incident changes, and it never
  // seeks, pauses or asks the list to scroll.
  useInterval(
    () => {
      const lead = followedLead(incidents, errors, gameClock.timeElapsedInMs);
      setInspection((current) =>
        current.following && current.incidents === incidents && current.index !== lead
          ? { ...current, index: lead }
          : current,
      );
    },
    following ? PLAYHEAD_SAMPLE_MS : null,
  );

  const toggleExpanded = useCallback((incidentId: string) => {
    setInspection((current) => {
      const next = new Set(current.expanded);
      if (!next.delete(incidentId)) next.add(incidentId);
      return { ...current, expanded: next };
    });
  }, []);

  // An incident replay borrows the transport: what the viewer had, and where the replay ends and returns to.
  const replay$ = useRef<
    { viewerSpeed: number; viewerBoundary: number | undefined; endMs: number; returnMs: number } | undefined
  >(undefined);
  const [replayingSpeed, setReplayingSpeed] = useState<ReplaySpeed | undefined>(undefined);
  const finishing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Gives the viewer's speed and boundary back; a replay that ran to its end also returns to the inspected error. */
  const endReplay = useCallback(
    (ranToEnd: boolean) => {
      const session = replay$.current;
      if (!session) return;
      replay$.current = undefined;
      setReplayingSpeed(undefined);
      setSpeed(session.viewerSpeed);
      gameClock.setPlaybackBoundary(session.viewerBoundary);
      if (ranToEnd) seekTo(session.returnMs);
    },
    [gameClock, setSpeed, seekTo],
  );

  useEffect(() => {
    const stopped = gameClock.isPlaying$.subscribe((playing) => {
      const session = replay$.current;
      if (playing || !session) return;
      const ranToEnd = gameClock.timeElapsedInMs >= session.endMs - 1;
      // The clock stops itself inside its own tick and then pins the playhead to the boundary; restoring in the
      // same call would have that overwrite the return seek.
      clearTimeout(finishing.current);
      finishing.current = setTimeout(() => endReplay(ranToEnd), 0);
    });
    // The replay's own seek happens before the session exists, so any seek seen here is someone else's.
    const sought = gameClock.seeked$.subscribe(() => endReplay(false));
    return () => {
      stopped.unsubscribe();
      sought.unsubscribe();
      clearTimeout(finishing.current);
      endReplay(false);
    };
  }, [gameClock, endReplay]);

  const replaySelection = useCallback(
    (speed: ReplaySpeed) => {
      const selected = errors[selectedIndex];
      if (!selected) return;
      // The lead stands for its incident: replay from its first error to its last. A member replays itself.
      const incident = incidents[incidentIndexOf(incidents, selectedIndex)];
      const whole = incident && incident.leadIndex === selectedIndex ? incident.errorIndices : [selectedIndex];
      const first = errors[whole[0]] ?? selected;
      const last = errors[whole[whole.length - 1]] ?? selected;
      // The lead-in starts before the inspected incident; Follow would switch to whatever the playhead is at.
      setInspection((current) => (current.following ? { ...current, following: false } : current));
      // A replay started over another one hands back the first one's loan, so the viewer's speed is never lost.
      clearTimeout(finishing.current);
      endReplay(false);
      // The viewer's own speed, not one that is only held with a key just now.
      const viewerSpeed = gameClock.viewerSpeed ?? gameClock.speed;
      const viewerBoundary = gameClock.playbackBoundaryInMs;
      // The lead-in is 1.5 s of real time at the chosen speed; the speed is the replay's, not the viewer's.
      setSpeed(speed);
      seekTo(replayStartTime(first.time, baseRate, speed));
      const endMs = replayEndTime(last.time, baseRate, speed);
      gameClock.setPlaybackBoundary(endMs);
      start();
      replay$.current = {
        viewerSpeed,
        viewerBoundary,
        // The clock clamps a boundary to the replay's length.
        endMs: gameClock.playbackBoundaryInMs ?? endMs,
        returnMs: selected.time,
      };
      setReplayingSpeed(speed);
    },
    [errors, incidents, selectedIndex, baseRate, gameClock, setSpeed, seekTo, start, endReplay],
  );

  const analysisStatus = !gameSimulator.hasReplayForMissAnalysis()
    ? undefined
    : missSession.status === "building"
    ? progress === "preparing"
      ? "Preparing error analysis…"
      : progress === "capturing"
      ? "Reading replay events…"
      : progress === "finalizing"
      ? "Finishing error analysis…"
      : "Analyzing errors…"
    : missSession.status === "error" || missSession.status === "unsupported"
    ? "Error analysis unavailable."
    : undefined;

  const displayMode = displaySettings.errorCauseDisplay;
  const value = useMemo<ErrorNavigationState>(
    () => ({
      errors,
      selectedIndex,
      selectError,
      selectIncident,
      following,
      setFollowing,
      expanded,
      toggleExpanded,
      replaySelection,
      replayingSpeed,
      revealToken,
      listScrollTop,
      causes,
      incidents,
      analysisStatus,
      displayMode,
      ruleset: rulesetFocus,
    }),
    [
      errors,
      selectedIndex,
      selectError,
      selectIncident,
      following,
      setFollowing,
      expanded,
      toggleExpanded,
      replaySelection,
      replayingSpeed,
      revealToken,
      causes,
      incidents,
      analysisStatus,
      displayMode,
      rulesetFocus,
    ],
  );
  return <ErrorNavigationContext.Provider value={value}>{children}</ErrorNavigationContext.Provider>;
}

export function useErrorNavigation(): ErrorNavigationState {
  const value = useContext(ErrorNavigationContext);
  if (!value) throw new Error("useErrorNavigation must be used inside ErrorNavigationProvider");
  return value;
}

/** The incident playback has most recently reached; -1 before the first error and with no errors. */
function reachedIncident(incidents: readonly Incident[], errors: readonly ReplayError[], timeMs: number): number {
  // `incidentIndexAtOrBefore` answers with the first incident before any error is reached; playback is not there yet.
  return errors.length > 0 && errors[0].time <= timeMs + 1 ? incidentIndexAtOrBefore(incidents, errors, timeMs) : -1;
}

/**
 * The incident playback has most recently reached (-1 before the first error is reached and with no errors).
 * The caller re-renders only when that incident changes, not on every clock tick.
 */
export function usePlayheadIncidentIndex(): number {
  const { errors, incidents } = useErrorNavigation();
  const { gameClock } = useAnalysisApp();
  const [playhead, setPlayhead] = useState(() => ({
    incidents,
    index: reachedIncident(incidents, errors, gameClock.timeElapsedInMs),
  }));
  let index = playhead.index;
  if (playhead.incidents !== incidents) {
    // A new grouping: derive at once instead of showing a stale index until the next sample.
    index = reachedIncident(incidents, errors, gameClock.timeElapsedInMs);
    setPlayhead({ incidents, index });
  }
  useInterval(() => {
    const next = reachedIncident(incidents, errors, gameClock.timeElapsedInMs);
    // Returning the same object makes React skip the render.
    setPlayhead((current) =>
      current.incidents === incidents && current.index === next ? current : { incidents, index: next },
    );
  }, PLAYHEAD_SAMPLE_MS);
  return index;
}
