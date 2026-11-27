import { runMissAnalysis, type MissAnalysisInput, type MissAnalysisPhase } from "./MissAnalysisRunner";
import {
  encodeMissAnalysisInput,
  decodeMissAnalysisSession,
  type MissAnalysisWireInput,
  type MissAnalysisWireSession,
} from "./MissAnalysisWire";
import type { MissExplanationSessionState } from "./MissExplanationSession";
import type { TraceRunIdentity } from "@osujs/core";

export interface MissAnalysisRequest {
  version: 1;
  requestId: number;
  input: MissAnalysisWireInput;
}
export type MissAnalysisResponse = { version: 1; requestId: number } & (
  | { kind: "progress"; phase: MissAnalysisPhase }
  | { kind: "result"; session: MissAnalysisWireSession }
  | { kind: "error"; message: string }
);
let workerFactory: (() => Worker) | undefined;
let nextRequest = 0;

function validSession(data: MissAnalysisWireSession, identity: TraceRunIdentity): boolean {
  if (!data || !["empty", "not-captured", "ready", "partial", "unsupported", "error"].includes(data.status))
    return false;
  if (
    data.status !== "ready" &&
    data.status !== "empty" &&
    (!("reasons" in data) ||
      !Array.isArray(data.reasons) ||
      !data.reasons.every((reason) => typeof reason === "string"))
  )
    return false;
  if (data.status !== "ready" && data.status !== "partial") return true;
  const sameIdentity = (other: TraceRunIdentity) =>
    other &&
    Object.keys(identity).length === Object.keys(other).length &&
    (Object.keys(identity) as Array<keyof TraceRunIdentity>).every((key) => identity[key] === other[key]);
  if (!sameIdentity(data.identity) || !sameIdentity(data.trace?.identity) || !Array.isArray(data.explanationEntries))
    return false;
  const keys = new Set<string>();
  for (const entry of data.explanationEntries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !entry[1] ||
      entry[0] !== entry[1].targetId ||
      !sameIdentity(entry[1].identity) ||
      keys.has(entry[0])
    )
      return false;
    keys.add(entry[0]);
  }
  return true;
}

/** The application installs a browser factory; headless/CLI callers share the inline runner. */
export function configureMissAnalysisWorker(factory: (() => Worker) | undefined): void {
  workerFactory = factory;
}

export function startMissAnalysis(
  input: MissAnalysisInput,
  checkpoint: () => Promise<void>,
  progress: (phase: MissAnalysisPhase) => void,
): { promise: Promise<MissExplanationSessionState>; cancel(): void } {
  if (!workerFactory) return { promise: runMissAnalysis(input, checkpoint, progress), cancel: () => undefined };
  const requestId = ++nextRequest;
  let active = true,
    receiving = false,
    worker: Worker | undefined;
  let rejectJob!: (reason: Error) => void;
  const stopWorker = () => {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    worker = undefined;
  };
  const fail = (error: unknown) => {
    if (!active) return;
    active = false;
    stopWorker();
    rejectJob(error instanceof Error ? error : new Error(String(error)));
  };
  const promise = new Promise<MissExplanationSessionState>((resolve, reject) => {
    rejectJob = reject;
    try {
      worker = workerFactory!();
      worker.onerror = (event) => {
        event.preventDefault();
        fail(new Error(event.message || "Miss-analysis worker failed"));
      };
      worker.onmessageerror = () => fail(new Error("Could not receive miss-analysis worker data"));
      worker.onmessage = async (event: MessageEvent<MissAnalysisResponse>) => {
        if (!active || receiving) return;
        const message = event.data;
        if (message?.requestId !== requestId) return;
        try {
          if (message.version !== 1) throw new Error("Invalid miss-analysis worker response");
          if (message.kind === "progress") {
            if (!["preparing", "capturing", "analysing", "finalizing"].includes(message.phase))
              throw new Error("Invalid miss-analysis worker progress");
            progress(message.phase);
          } else if (message.kind === "error") {
            fail(new Error(message.message));
          } else if (message.kind === "result") {
            const data = message.session;
            if (!validSession(data, input.identity)) throw new Error("Invalid miss-analysis worker session");
            receiving = true;
            stopWorker();
            const session = await decodeMissAnalysisSession(data, async () => {
              if (!active) throw new Error("Miss analysis cancelled");
              await checkpoint();
              if (!active) throw new Error("Miss analysis cancelled");
            });
            if (active) {
              active = false;
              resolve(session);
            }
          } else throw new Error("Invalid miss-analysis worker response");
        } catch (error) {
          fail(error);
        }
      };
      const request: MissAnalysisRequest = { version: 1, requestId, input: encodeMissAnalysisInput(input) };
      worker.postMessage(request);
    } catch (error) {
      fail(error);
    }
  });
  return { promise, cancel: () => fail(new Error("Miss analysis cancelled")) };
}
