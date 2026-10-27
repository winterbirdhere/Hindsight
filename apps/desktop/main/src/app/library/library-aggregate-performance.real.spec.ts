import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, sep, dirname, join } from "path";
import type { PerformanceMode } from "@rewind/osu-performance/types";
import { buildAggregatePerformanceRequest, readAggregatePerformanceResult, AggregatePerformanceInput } from "./library-aggregate-performance";

const reportPath = process.env.HINDSIGHT_LIBRARY_AGGREGATE_NATIVE_REPORT;
const real = reportPath ? describe : describe.skip;
real("existing isolated native engine aggregate protocol", () => {
  it("calculates Stable/native/Classic aggregates with no replay simulation and rejects a wrong native component capacity", () => {
    const report = JSON.parse(readFileSync(reportPath as string, "utf8")) as { ok: boolean; executable: string; implementation: { path: string; sha256: string }[] };
    const output = resolve(process.env.HINDSIGHT_LIBRARY_AGGREGATE_OUTPUT ?? "");
    const root = resolve(__dirname, "../../../../../..");
    if (!output.startsWith(join(root, "qa", "replay-library") + sep) || existsSync(output)) throw new Error("Use a fresh owned QA report");
    if (!report.ok || !report.executable.startsWith(join(root, "qa", "replay-library") + sep) || !report.implementation.length)
      throw new Error("Expected verified isolated native implementation");
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const verify = () => { for (const file of report.implementation) expect(hash(file.path)).toBe(file.sha256); };
    verify();
    const evidence: { mode: string; rejected?: boolean; response: unknown; metric: unknown }[] = [];
    const text = "osu file format v14\n[General]\nMode:0\n[Metadata]\nTitle:Aggregate fixture\nArtist:Fixture\nCreator:Fixture\nVersion:Three circles\n[Difficulty]\nCircleSize:4\nOverallDifficulty:6\nApproachRate:7\nHPDrainRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,2,1,50,1,0\n[HitObjects]\n64,64,1000,1,0,0:0:0:0:\n256,192,1500,1,0,0:0:0:0:\n448,320,2000,1,0,0:0:0:0:\n";
    const statistics = { great: 2, ok: 1, meh: 0, miss: 0, large_tick_hit: 0, large_tick_miss: 0,
      small_tick_hit: 0, small_tick_miss: 0, slider_tail_hit: 0, slider_tail_miss: 0 };
    try {
      for (const mode of ["stable", "lazer", "lazer-classic"] as PerformanceMode[]) {
        const input: AggregatePerformanceInput = { map: { text, sha256: createHash("sha256").update(text).digest("hex"), ruleset: 0, objectCount: 3, aggregateTimeMs: 2000 },
          score: mode === "stable" ? { mode, basic: [2, 1, 0, 0], maxCombo: 3, evidenceKey: "fixture-v1" }
            : { mode, statistics, maxCombo: 3, componentsQualified: true, evidenceKey: "fixture-v1" },
          mods: mode === "lazer-classic" ? [{ acronym: "CL" }] : [], profileKey: "fixture-" + mode };
        const built = buildAggregatePerformanceRequest(input);
        if (built.state !== "ready") throw new Error(built.reason);
        const execute = () => {
          const child = spawnSync(report.executable, [], { cwd: dirname(output), input: JSON.stringify(built.request) + "\n", encoding: "utf8",
            windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
          expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.signal).toBeNull();
          return JSON.parse(child.stdout.trim()) as unknown;
        };
        const response = execute(); const metric = readAggregatePerformanceResult(response, { mode, time: 2000, objectCount: 3 });
        evidence.push({ mode, response, metric }); expect(metric.state).toBe("known");
        if (mode === "lazer") {
          built.request.calculations[0].states[0].statistics.slider_tail_hit = 1;
          const response = execute(); const metric = readAggregatePerformanceResult(response, { mode, time: 2000, objectCount: 3 });
          evidence.push({ mode, rejected: true, response, metric }); expect(metric.state).toBe("unknown");
        }
      }
    } finally {
      verify(); writeFileSync(output, JSON.stringify({ checks: evidence, helperUnchanged: true, executable: report.executable,
        scope: "Existing native aggregate protocol; synthetic exact map, no replay frames/simulation/classifier or GUI", utc: new Date().toISOString() }, null, 2));
    }
  }, 90000);
});
