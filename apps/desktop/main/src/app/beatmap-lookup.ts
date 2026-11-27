import { ClientRequest, IncomingMessage } from "http";
import { get } from "https";
import { BeatmapLookupResult } from "../../../shared/beatmap-lookup";

const LOOKUP_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
}

/** Keep network access in the main process: renderer fetches depend on the provider's CORS policy. */
export function lookupBeatmap(checksum: unknown, appVersion: string): Promise<BeatmapLookupResult> {
  if (typeof checksum !== "string" || !/^[a-f0-9]{32}$/i.test(checksum.trim())) {
    return Promise.resolve({ status: "NOT_FOUND" });
  }
  const normalizedChecksum = checksum.trim().toLowerCase();

  return new Promise((resolve) => {
    let settled = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;

    const finish = (result: BeatmapLookupResult, stopRequest = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopRequest) {
        response?.destroy();
        request?.destroy();
      }
      resolve(result);
    };
    const unavailable = (reason: string) => {
      if (settled) return;
      // Do not log the URL, checksum, response body, or arbitrary remote error text.
      console.warn(`Beatmap lookup unavailable: ${reason}`);
      finish({ status: "UNAVAILABLE" }, true);
    };
    // An absolute deadline also bounds DNS/TLS setup and a response body that stops arriving.
    const timer = setTimeout(() => unavailable("request timed out after 5 seconds"), LOOKUP_TIMEOUT_MS);

    try {
      request = get(
        `https://osu.direct/api/v2/md5/${normalizedChecksum}`,
        { headers: { "User-Agent": `Hindsight/${appVersion}`, Accept: "application/json" } },
        (incoming) => {
          response = incoming;
          incoming.once("error", (error) => unavailable(`response error${errorCode(error)}`));
          incoming.once("aborted", () => unavailable("response aborted"));
          if (settled) {
            incoming.destroy();
            return;
          }
          if (incoming.statusCode === 404) {
            finish({ status: "NOT_FOUND" }, true);
            return;
          }
          if (incoming.statusCode !== 200) {
            unavailable(`HTTP ${incoming.statusCode ?? "unknown"}`);
            return;
          }

          const chunks: Buffer[] = [];
          let responseBytes = 0;
          incoming.on("data", (chunk: Buffer) => {
            if (settled) return;
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              unavailable("response exceeded size limit");
              return;
            }
            chunks.push(chunk);
          });
          incoming.once("end", () => {
            if (settled) return;
            let payload: unknown;
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              unavailable("invalid JSON response");
              return;
            }
            if (typeof payload !== "object" || payload === null) {
              unavailable("invalid beatmap response");
              return;
            }
            const { id, beatmapset_id: setId, checksum: returnedChecksum } = payload as Record<string, unknown>;
            if (
              typeof id !== "number" ||
              !Number.isSafeInteger(id) ||
              id <= 0 ||
              typeof setId !== "number" ||
              !Number.isSafeInteger(setId) ||
              setId <= 0
            ) {
              unavailable("invalid beatmap identifiers");
              return;
            }
            if (typeof returnedChecksum !== "string" || returnedChecksum.toLowerCase() !== normalizedChecksum) {
              unavailable("response checksum did not match");
              return;
            }
            finish({ status: "FOUND", beatmap: { beatmapId: id, beatmapsetId: setId } });
          });
        },
      );
      request.once("error", (error) => unavailable(`network error${errorCode(error)}`));
    } catch (error) {
      unavailable(`request could not start${errorCode(error)}`);
    }
  });
}
