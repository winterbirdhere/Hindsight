/** Recorded metadata only. No source kind, scoring profile, mods, grade or simulation
 * is evidence of the client that recorded a play or its recorded pass/fail outcome.
 * osu.Game's LegacyScoreDecoder sets IsLegacyScore from FIRST_LAZER_VERSION (30000000).
 * ScoreInfo.Passed is [Ignored] with a true constructor default, so Realm cannot supply it.
 */
export const LIBRARY_RECORDED_EVIDENCE_VERSION = "recorded-evidence-v1";

const json = (metadata: string, path: string) => `json_extract(${metadata},'$.${path}')`;
const integer = (metadata: string, path: string) => `json_type(${metadata},'$.${path}')='integer'`;
function evidenceRows(replayId: string, metadata: string): string {
  // Keep historical recorded evidence across source disable/removal. Locations hold all
  // duplicate observations; the selected summary alone must not conceal a contradiction.
  return `SELECT ${metadata} AS recorded_metadata UNION ALL SELECT l.metadata FROM locations l WHERE l.replay_id=${replayId}`;
}

/** True only when a recorded ruleset ID is a known nonstandard mode. Missing mode
 * stays visible and is never silently asserted to be standard. */
export function libraryKnownNonstandardSql(replayId: string, metadata: string): string {
  const paths = ["header.mode", "savedScore.header.mode", "nativeScore.ruleset"];
  return `EXISTS(SELECT 1 FROM (${evidenceRows(replayId, metadata)}) WHERE ${paths.map(path =>
    `(${integer("recorded_metadata", path)} AND ${json("recorded_metadata", path)}>0)`).join(" OR ")})`;
}

/** Independent evidence is merged, never preferentially chosen. An explicit conflict
 * gives Unknown; absence does not erase another bound observation. The OSR version
 * identifies recording format even for old lazer files without a native trailer. */
export function libraryRecordingClientSql(replayId: string, metadata: string): string {
  const m = "recorded_metadata";
  const versions = ["header.version", "savedScore.header.version"];
  const version = (lazer: boolean) => versions.map(path => `(${integer(m, path)} AND ${json(m, path)}${lazer ? ">=30000000" : " BETWEEN 1 AND 29999999"})`).join(" OR ");
  const stable = `(${version(false)} OR json_type(${m},'$.nativeScore.isLegacyScore')='true')`;
  const lazer = `(${version(true)} OR json_type(${m},'$.nativeScore.isLegacyScore')='false')`;
  const inconsistentHeader = `(${integer(m, "header.version")} AND ((
    ${json(m, "header.version")} BETWEEN 1 AND 29999999 AND (${json(m, "header.sourceFormat")}='lazer' OR json_type(${m},'$.header.nativeScoreInfo')='true'))
    OR (${json(m, "header.version")}>=30000000 AND ${json(m, "header.sourceFormat")}='stable')
    OR (${json(m, "header.version")}>=30000001 AND json_type(${m},'$.header.nativeScoreInfo')='false')))`;
  return `(SELECT CASE WHEN max(CASE WHEN ${inconsistentHeader} THEN 1 ELSE 0 END)=1 THEN 'unknown'
    WHEN max(CASE WHEN ${stable} THEN 1 ELSE 0 END)=1 AND max(CASE WHEN ${lazer} THEN 1 ELSE 0 END)=0 THEN 'stable'
    WHEN max(CASE WHEN ${lazer} THEN 1 ELSE 0 END)=1 AND max(CASE WHEN ${stable} THEN 1 ELSE 0 END)=0 THEN 'lazer' ELSE 'unknown' END
    FROM (${evidenceRows(replayId, metadata)}))`;
}

/** Only explicitly recorded outcome metrics qualify. Existing coverage-derived
 * numerical results remain available to their consumers but cannot become Result. */
export function libraryRecordedCompletionSql(...payloads: string[]): string {
  const rows = payloads.map(payload => `SELECT CASE WHEN json_extract(${payload},'$.provenance.completionEvidence')='recorded-outcome-v1'
    AND json_extract(${payload},'$.fields.completion.state')='known'
    AND json_extract(${payload},'$.fields.completion.value') IN ('passed','failed')
    THEN json_extract(${payload},'$.fields.completion.value') END AS outcome`).join(" UNION ALL ");
  return `(SELECT CASE WHEN count(DISTINCT outcome)=1 THEN max(outcome) END FROM (${rows}))`;
}
