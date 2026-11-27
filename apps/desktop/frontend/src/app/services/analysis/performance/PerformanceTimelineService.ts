import { injectable } from "inversify";
import { ipcRenderer } from "electron";
import {
  PERFORMANCE_CALCULATE_CHANNEL,
  PERFORMANCE_CANCEL_CHANNEL,
  PERFORMANCE_ENGINE_VERSION,
  PerformancePoint,
  PerformanceResponse,
  PerformanceTimeline,
  performanceAt,
  starRatingAt,
} from "@rewind/osu-performance/protocol";
import type { PerformanceMode, ReplayPerformanceInput } from "@rewind/osu-performance/types";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import { BehaviorSubject, Subscription } from "rxjs";
import { decomposeStarRating, type AdditiveSrBreakdown } from "./sr-breakdown";
import type { CurrentReplayCaptureContext, CurrentReplayPerformanceEndpoint, CurrentReplayPerformanceSnapshot } from "../../library/library-current-replay";
import { LIBRARY_PERFORMANCE_INPUT_VERSION, LIBRARY_RECONSTRUCTED_FC_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../../../shared/library-analysis";

function libraryEndpoint(timeline: PerformanceTimeline): CurrentReplayPerformanceEndpoint {
  const point = timeline.points[timeline.points.length - 1];
  return { mode: timeline.mode, objectCount: timeline.objectCount, endpointVerified: timeline.endpointVerified,
    pointCount: timeline.points.length, ...(point ? { lastPoint: { time: point.time, pp: point.pp, sr: point.sr } } : {}) };
}

export interface LivePerformance {
  point?: PerformancePoint;
  description: string;
}

export interface FullMapPerformance {
  status: "loading" | "ready" | "unavailable";
  pp?: number;
  /** The highest PP the replay reached on the way; the final PP can be lower after a late miss. */
  peakPp?: number;
  /** What the engine gives the same play as a full combo (every miss a 300); absent until it has answered. */
  fullComboPp?: number;
  /** The official pp algorithm's effective miss count for this play; absent unless the engine sent a valid one. */
  effectiveMissCount?: number;
  sr?: number;
  breakdown?: AdditiveSrBreakdown;
  description: string;
}

@injectable()
export class PerformanceTimelineService {
  public readonly changed$ = new BehaviorSubject(0);
  private generation = 0;
  private timelines: PerformanceTimeline[] = [];
  private inputs: readonly ReplayPerformanceInput[] = [];
  private error?: string;
  private loading = false;
  private fullComboPp = new Map<PerformanceMode, number>();
  private libraryContext?: CurrentReplayCaptureContext;
  private libraryTimelines = new Map<PerformanceMode, CurrentReplayPerformanceEndpoint>();
  private libraryFcTimelines = new Map<PerformanceMode, CurrentReplayPerformanceEndpoint>();
  private librarySummaries = new Map<PerformanceMode, FullMapPerformance>();

  clear(): void {
    this.generation++;
    this.timelines = [];
    this.inputs = [];
    this.error = undefined;
    this.loading = false;
    this.fullComboPp = new Map();
    this.libraryContext = undefined;
    this.libraryTimelines.clear();
    this.libraryFcTimelines.clear();
    this.librarySummaries.clear();
    ipcRenderer.send(PERFORMANCE_CANCEL_CHANNEL);
    this.changed$.next(this.changed$.value + 1);
  }

  async load(beatmap: string, inputs: readonly ReplayPerformanceInput[], libraryContext?: CurrentReplayCaptureContext): Promise<void> {
    this.clear();
    const generation = this.generation;
    this.inputs = inputs;
    if (libraryContext && inputs.includes(libraryContext.performanceInput) && libraryContext.performanceInput.mode === libraryContext.binding.mode)
      this.libraryContext = libraryContext;
    this.loading = true;
    this.changed$.next(this.changed$.value + 1);
    try {
      const response: PerformanceResponse = await ipcRenderer.invoke(PERFORMANCE_CALCULATE_CHANNEL, {
        beatmap,
        calculations: inputs.map(({ mode, mods, states }) => ({ mode, mods, states })),
      });
      if (generation !== this.generation) return;
      if (!response.ok || response.engineVersion !== PERFORMANCE_ENGINE_VERSION || !response.timelines) {
        this.error = response.error ?? "Performance engine is unavailable";
        return;
      }
      this.timelines = response.timelines;
      if (this.libraryContext) for (const timeline of response.timelines) {
        if (!timeline.error) this.libraryTimelines.set(timeline.mode, libraryEndpoint(timeline));
      }
      // An extra, asked afterwards: the replay's own values never wait for it.
      void this.loadFullCombo(generation, beatmap, inputs);
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.changed$.next(this.changed$.value + 1);
      }
    }
  }

  /** "PP if FC": one more calculation per mode, of the full-combo state alone. Optional; a failure leaves it absent. */
  private async loadFullCombo(generation: number, beatmap: string, inputs: readonly ReplayPerformanceInput[]): Promise<void> {
    const calculations = inputs.flatMap(({ mode, mods, fullComboState }) => (fullComboState ? [{ mode, mods, states: [fullComboState] }] : []));
    if (calculations.length === 0) return;
    try {
      const response: PerformanceResponse = await ipcRenderer.invoke(PERFORMANCE_CALCULATE_CHANNEL, { beatmap, calculations });
      if (generation !== this.generation) return;
      if (!response.ok || response.engineVersion !== PERFORMANCE_ENGINE_VERSION || !response.timelines) return;
      for (const timeline of response.timelines) {
        const pp = timeline.points[timeline.points.length - 1]?.pp;
        if (!timeline.error && pp !== undefined && Number.isFinite(pp) && pp >= 0) {
          this.fullComboPp.set(timeline.mode, pp);
          if (this.libraryContext) this.libraryFcTimelines.set(timeline.mode, libraryEndpoint(timeline));
        }
      }
      this.changed$.next(this.changed$.value + 1);
    } catch {
      // Nothing to show for it; the replay's own values stand.
    }
  }

  /** Snapshot only already accepted values for the exact viewer admission token. FC remains
   * independently optional; calling this never waits, subscribes or invokes the engine. */
  captureLibraryPerformance(context: CurrentReplayCaptureContext): CurrentReplayPerformanceSnapshot | undefined {
    if (this.loading || this.libraryContext !== context || !this.inputs.includes(context.performanceInput)) return undefined;
    const mode = context.binding.mode;
    const timeline = this.libraryTimelines.get(mode);
    if (!timeline || timeline.pointCount > 100001 || context.performanceInput.states.length > 100001) return undefined;
    const fullMap = this.librarySummaries.get(mode) ?? this.fullMapForInput(context.performanceInput);
    if (fullMap.status !== "ready") return undefined;
    this.librarySummaries.set(mode, fullMap);
    const clone = (endpoint: CurrentReplayPerformanceEndpoint) => ({ ...endpoint,
      ...(endpoint.lastPoint ? { lastPoint: { ...endpoint.lastPoint } } : {}) });
    const fc = this.libraryFcTimelines.get(mode);
    return { engineVersion: PERFORMANCE_ENGINE_VERSION, inputVersion: LIBRARY_PERFORMANCE_INPUT_VERSION,
      timelineVersion: LIBRARY_TIMELINE_PROJECTION_VERSION, fcVersion: LIBRARY_RECONSTRUCTED_FC_VERSION,
      input: context.performanceInput, fullMap: { status: "ready", pp: fullMap.pp, peakPp: fullMap.peakPp,
        fullComboPp: this.fullComboPp.get(mode), sr: fullMap.sr, description: fullMap.description },
      timeline: clone(timeline), ...(fc ? { fcTimeline: clone(fc) } : {}) };
  }

  /** Wait for this replay's optional counters without delaying interactive playback. */
  waitForSettled(signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const subscription = new Subscription();
      const finish = (error?: Error) => {
        subscription.unsubscribe();
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("Clip export cancelled"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      subscription.add(
        this.changed$.subscribe(() => {
          if (generation !== this.generation) finish(new Error("Replay performance preparation changed"));
          else if (!this.loading) finish();
        }),
      );
    });
  }

  fullMap(ruleset: ReplayAnalysisRuleset): FullMapPerformance {
    const input = this.inputs.find((entry) =>
      ruleset === "stable" ? entry.mode === "stable" : entry.mode !== "stable",
    );
    return this.fullMapForInput(input);
  }

  private fullMapForInput(input: ReplayPerformanceInput | undefined): FullMapPerformance {
    if (this.loading) return { status: "loading", description: "Calculating replay performance…" };
    const timeline = this.timelines.find((entry) => entry.mode === input?.mode);
    if (!timeline || timeline.error) {
      return {
        status: "unavailable",
        description: timeline?.error ?? this.error ?? "Performance values are unavailable for this replay mode",
      };
    }
    const raw = timeline.fullDifficulty;
    const validDifficulty =
      raw &&
      [raw.total, raw.aim, raw.speed, raw.reading, raw.flashlight, raw.sliderFactor].every(
        (value) => Number.isFinite(value) && value >= 0,
      );
    const breakdown = validDifficulty ? decomposeStarRating(raw) : undefined;
    const pp = timeline.points.length ? timeline.points[timeline.points.length - 1].pp : 0;
    const sr = raw?.total ?? timeline.final?.sr ?? timeline.difficultyPoints[timeline.difficultyPoints.length - 1]?.sr;
    if (!Number.isFinite(pp) || pp < 0 || sr === undefined || !Number.isFinite(sr) || sr < 0) {
      return { status: "unavailable", description: "Performance values are unavailable for this replay mode" };
    }
    const mode =
      timeline.mode === "stable" ? "Stable" : timeline.mode === "lazer-classic" ? "Lazer + Classic" : "Lazer";
    const peakPp = timeline.points.reduce((peak, point) => (Number.isFinite(point.pp) && point.pp > peak ? point.pp : peak), pp);
    const fullComboPp = this.fullComboPp.get(timeline.mode);
    const effectiveMissCount: unknown = timeline.effectiveMissCount;
    return {
      status: "ready",
      pp,
      peakPp,
      ...(fullComboPp !== undefined ? { fullComboPp } : {}),
      ...(typeof effectiveMissCount === "number" && Number.isFinite(effectiveMissCount) && effectiveMissCount >= 0
        ? { effectiveMissCount }
        : {}),
      sr,
      breakdown,
      description: [
        `${mode}: PP is the last achieved replay value; SR covers the full map with the replay's mods.`,
        "PP uses osu!'s standard calculation. Relax uses the same calculation without RX.",
        ...(input?.limitations ?? []),
      ].join(" "),
    };
  }

  at(ruleset: ReplayAnalysisRuleset, time: number): LivePerformance {
    if (this.loading) return { description: "Calculating replay performance…" };
    const input = this.inputs.find((entry) =>
      ruleset === "stable" ? entry.mode === "stable" : entry.mode !== "stable",
    );
    const timeline = this.timelines.find((entry) => entry.mode === input?.mode);
    if (!timeline) return { description: this.error ?? "Performance values are unavailable for this replay mode" };
    if (timeline.error) return { description: timeline.error };
    const mode =
      timeline.mode === "stable" ? "Stable" : timeline.mode === "lazer-classic" ? "Lazer + Classic" : "Lazer";
    const performance = performanceAt(timeline.points, time);
    const difficulty = starRatingAt(timeline.difficultyPoints, time);
    return {
      point: { time: Math.max(performance.time, difficulty.time), pp: performance.pp, sr: difficulty.sr },
      description: [
        `${mode}: PP reflects completed replay judgements and retains its last achieved value after the replay ends. SR follows completed beatmap objects through the end of the map.`,
        "PP uses osu!'s standard calculation. Relax uses the same calculation without RX.",
        ...(input?.limitations ?? []),
      ].join(" "),
    };
  }
}
