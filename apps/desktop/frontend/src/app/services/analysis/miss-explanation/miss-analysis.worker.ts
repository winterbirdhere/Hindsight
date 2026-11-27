import type { MissAnalysisRequest, MissAnalysisResponse } from "./MissAnalysisClient";
import { runMissAnalysis } from "./MissAnalysisRunner";
import { decodeMissAnalysisInput, encodeMissAnalysisSession } from "./MissAnalysisWire";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<MissAnalysisRequest>) => void;
  postMessage(message: MissAnalysisResponse): void;
};
let started = false;
scope.onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  const { requestId } = data;
  try {
    if (data.version !== 1) throw new Error("Invalid miss-analysis request");
    // This dedicated worker is terminated by the owner on cancellation. It
    // needs no renderer scheduling delays, but keeps the same ordered runner.
    const session = await runMissAnalysis(
      decodeMissAnalysisInput(data.input),
      async () => undefined,
      (phase) => scope.postMessage({ version: 1, requestId, kind: "progress", phase }),
    );
    scope.postMessage({ version: 1, requestId, kind: "result", session: encodeMissAnalysisSession(session) });
  } catch (error) {
    scope.postMessage({ version: 1, requestId, kind: "error", message: String(error) });
  }
};
