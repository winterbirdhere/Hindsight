import { ReplayTrace, ReplayTraceRecord } from "../src/gameplay/trace/ReplayTrace";
import { traceBeatmap } from "./ReplayTraceFixtures";
export const evidenceMap = () => traceBeatmap("300,192,1000,1,0\n100,192,1050,1,0");
export function evidenceTrace(
  records: object[],
  profile = "stable",
  overrides: Partial<ReplayTrace> = {},
): ReplayTrace {
  return {
    identity: {
      schemaVersion: 1,
      replayContentSha256: null,
      beatmapContentSha256: null,
      beatmapMd5: null,
      generationKey: "evidence-test",
      recordingClient: "synthetic",
      analysisProfileId: profile,
      analysisProfileFingerprint: "fixture",
      parserVersion: "fixture",
      inputPreparationVersion: "fixture",
    },
    domain: {
      endTimeMs: 1300,
      endpointBasis: "recorded-end",
      synthesizedEndpoint: false,
      sourceCoverageLimits: [],
      initialActionsKnown: true,
    },
    records: records.map((r, sequence) => ({ id: `r${sequence}`, sequence, ...r })) as ReplayTraceRecord[],
    coverage: { input: "complete", geometry: "partial", routing: "complete", lifecycle: "complete" },
    complete: true,
    failures: [],
    limits: { maxRecords: 200000, maxExportBytes: 67108864 },
    ...overrides,
  };
}
export const activation = (timeMs = 400) => ({
  kind: "lifecycle",
  phase: "lifecycle",
  timeMs,
  componentId: "0",
  component: "circle",
  transition: "activated",
});
export const input = (
  timeMs: number,
  x: number,
  actions: number[] = [],
  freshActions: number[] = actions,
  parsedFrameIndex = 0,
  extra: object = {},
) => ({
  kind: "input",
  phase: "input",
  timeMs,
  position: { x, y: 192 },
  previousActions: [],
  actions,
  freshActions,
  source: { origin: "parsed", parsedFrameIndex },
  groupMemberIndex: 0,
  ...extra,
});
export const expiry = (timeMs = 1111, extra: object = {}) => ({
  kind: "resolution",
  phase: "resolution",
  timeMs,
  componentId: "0",
  component: "circle",
  result: "MISS",
  mechanism: "automatic-expiry",
  previousUnresolved: true,
  ...extra,
});
