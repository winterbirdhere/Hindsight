import { errorIndexAtOrBefore, incidentIndexOf, type Incident } from "./incidents";
import type { ReplayError } from "./replay-events";

/** What the UI knows about one member: its cause labels joined with " · " (undefined when none) and its type label. */
export interface MemberLabel {
  cause?: string;
  type: string;
  /** Set when the cause is an earlier mistake's (a chained miss or slider break): its map time and own cause. */
  chain?: { startMs: number; cause?: readonly string[] };
}

/** Consecutive members with the same chain label and the same type. */
export interface MemberRun {
  label: string;
  type: string;
  errorIndices: number[];
}

export interface IncidentSummary {
  causeChain: string;
  typeChain: string;
  /** The lead error index (`incident.leadIndex`). */
  lead: number;
  /** Runs over the members after the lead. */
  followers: MemberRun[];
}

const CHAIN_SEPARATOR = " → ";

export function formatRun(label: string, count: number): string {
  return count > 1 ? `${label} ×${count}` : label;
}

function chain(labels: readonly string[]): string {
  const parts: string[] = [];
  let index = 0;
  while (index < labels.length) {
    let end = index + 1;
    while (end < labels.length && labels[end] === labels[index]) end++;
    parts.push(formatRun(labels[index], end - index));
    index = end;
  }
  return parts.join(CHAIN_SEPARATOR);
}

/** Compresses an incident into a cause chain, a type chain and follower runs. Counts are errors. */
export function summarizeIncident(incident: Incident, labelOf: (errorIndex: number) => MemberLabel): IncidentSummary {
  const members = incident.errorIndices.map((errorIndex) => {
    const { cause, type } = labelOf(errorIndex);
    return { errorIndex, label: cause ?? type, type };
  });
  const followers: MemberRun[] = [];
  for (const member of members) {
    if (member.errorIndex === incident.leadIndex) continue;
    const last = followers[followers.length - 1];
    if (last && last.label === member.label && last.type === member.type) last.errorIndices.push(member.errorIndex);
    else followers.push({ label: member.label, type: member.type, errorIndices: [member.errorIndex] });
  }
  return {
    causeChain: chain(members.map((member) => member.label)),
    typeChain: chain(members.map((member) => member.type)),
    lead: incident.leadIndex,
    followers,
  };
}

// After a colon the seconds have two digits: "2:5" is unfinished typing, not 2:05.
const CLOCK_ENTRY = /^(\d+):(\d{2})(?:\.(\d{1,3}))?$/;
const SECONDS_ENTRY = /^(\d+)(?:\.(\d{1,3}))?$/;

const fractionToMs = (fraction: string | undefined): number => (fraction ? Number(fraction.padEnd(3, "0")) : 0);

/** Displayed playback time in ms from "m:ss", "m:ss.mmm", "s" or "s.mmm"; undefined for anything else. */
export function parseTimeEntry(text: string): number | undefined {
  const trimmed = text.trim();
  const clock = CLOCK_ENTRY.exec(trimmed);
  if (clock) {
    const seconds = Number(clock[2]);
    if (seconds >= 60) return undefined;
    return (Number(clock[1]) * 60 + seconds) * 1000 + fractionToMs(clock[3]);
  }
  const plain = SECONDS_ENTRY.exec(trimmed);
  if (plain) return Number(plain[1]) * 1000 + fractionToMs(plain[2]);
  return undefined;
}

type FindFrom = { incidentIndex: number } | { timeMs: number };

/** Nearest incident by the time of its closest member; a tie goes to the earlier incident. -1 when empty. */
export function nearestIncidentIndex(
  incidents: readonly Incident[],
  errors: readonly ReplayError[],
  timeMs: number,
): number {
  let best = -1;
  let bestDistance = Infinity;
  incidents.forEach((incident, index) => {
    for (const errorIndex of incident.errorIndices) {
      const error = errors[errorIndex];
      if (!error) continue;
      const distance = Math.abs(error.time - timeMs);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
  });
  return best;
}

/** The incident containing the error the playhead has most recently reached; -1 when there are no errors. */
export function incidentIndexAtOrBefore(
  incidents: readonly Incident[],
  errors: readonly ReplayError[],
  timeMs: number,
): number {
  const errorIndex = errorIndexAtOrBefore(errors, timeMs);
  return errorIndex < 0 ? -1 : incidentIndexOf(incidents, errorIndex);
}

const leadTime = (incident: Incident, errors: readonly ReplayError[]): number | undefined =>
  errors[incident.leadIndex]?.time;

export function nextIncidentIndex(
  incidents: readonly Incident[],
  errors: readonly ReplayError[],
  from: FindFrom,
): number {
  if ("incidentIndex" in from) {
    const next = from.incidentIndex + 1;
    return next >= 0 && next < incidents.length ? next : -1;
  }
  return incidents.findIndex((incident) => {
    const time = leadTime(incident, errors);
    return time !== undefined && time > from.timeMs + 1;
  });
}

export function previousIncidentIndex(
  incidents: readonly Incident[],
  errors: readonly ReplayError[],
  from: FindFrom,
): number {
  if ("incidentIndex" in from) {
    const previous = from.incidentIndex - 1;
    return previous >= 0 && previous < incidents.length ? previous : -1;
  }
  for (let index = incidents.length - 1; index >= 0; index--) {
    const time = leadTime(incidents[index], errors);
    if (time !== undefined && time < from.timeMs - 1) return index;
  }
  return -1;
}

/** Every replay starts this long (real time) before the error, whatever the speed. */
export const REPLAY_LEAD_IN_REAL_MS = 1500;
/**
 * An incident replay stops this long (real time) after the incident's last error: past its judgement and the
 * 0.9 s its outline stays.
 */
export const REPLAY_TAIL_REAL_MS = 1200;
/** The speeds the incident block can replay at. */
export const REPLAY_SPEEDS = [0.25, 0.5, 1] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * Where a replay at `speed` starts: the lead-in is 1.5 s of real time, so it spans `1500 × speed × baseRate` ms
 * of map time (a quarter of the 1× lead-in at 0.25×).
 */
export function replayStartTime(errorTimeMs: number, baseRate: number, speed: number): number {
  return Math.max(0, errorTimeMs - REPLAY_LEAD_IN_REAL_MS * speed * baseRate);
}

/** Where a replay at `speed` stops: 1.2 s of real time after the last error it plays. */
export function replayEndTime(lastErrorTimeMs: number, baseRate: number, speed: number): number {
  return lastErrorTimeMs + REPLAY_TAIL_REAL_MS * speed * baseRate;
}
