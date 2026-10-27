import type { DatabaseSync } from "node:sqlite";
import { LIBRARY_RESOURCE_CHANGE_IDS, libraryResourceReplayId } from "../../../../shared/library-resource-changes";
import type { LibraryResourceChanges } from "../../../../shared/library-resource-changes";

const RETAINED_REVISIONS = 1024;
const counter = (value: unknown): value is string => typeof value === "string" && value.length <= 19 && !/[^0-9]/.test(value) && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807");

/** Every indexed resource counter increment and its bounded scope share the originating transaction. */
export class LibraryResourceChangesJournal {
  static migrate(db: DatabaseSync): void {
    db.exec(`CREATE TABLE resource_changes(
      revision INTEGER PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('all','replays')),
      replay_ids TEXT NOT NULL CHECK(json_valid(replay_ids) AND json_type(replay_ids)='array'
        AND json_array_length(replay_ids)<=4 AND length(CAST(replay_ids AS BLOB))<=4096));`);
    const trigger = (name: string, event: string, table: string, when = "", ids = "json_array()") => {
      const scoped = ids !== "json_array()";
      // Filter null merge destinations; reject any invalid identity rather than omit it.
      const valid = `NOT EXISTS(SELECT 1 FROM json_each(${ids}) WHERE value IS NOT NULL AND
        (type<>'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-zA-Z0-9_.:+-]*'))`;
      const scope = scoped ? `CASE WHEN ${valid} THEN 'replays' ELSE 'all' END` : "'all'";
      const replayIds = scoped ? `CASE WHEN ${valid} THEN (SELECT json_group_array(value) FROM json_each(${ids}) WHERE value IS NOT NULL) ELSE '[]' END` : "'[]'";
      db.exec(`DROP TRIGGER query_resource_${name};
        CREATE TRIGGER query_resource_${name} AFTER ${event} ON ${table} ${when} BEGIN
        UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1;
        INSERT INTO resource_changes(revision,scope,replay_ids)
          SELECT resource_revision,${scope},${replayIds} FROM query_projection_state WHERE id=1;
        DELETE FROM resource_changes WHERE revision<=(SELECT resource_revision-${RETAINED_REVISIONS} FROM query_projection_state WHERE id=1);
        END;`);
    };
    for (const event of ["INSERT", "DELETE", "UPDATE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      trigger(`locations_${event.toLowerCase()}`, event, "locations", event === "UPDATE" ?
        "WHEN OLD.source_id IS NOT NEW.source_id OR OLD.source_key IS NOT NEW.source_key OR OLD.replay_id IS NOT NEW.replay_id OR OLD.locator IS NOT NEW.locator OR OLD.sha256 IS NOT NEW.sha256 OR OLD.metadata IS NOT NEW.metadata OR OLD.available IS NOT NEW.available" : "",
      event === "UPDATE" ? "json_array(OLD.replay_id,NEW.replay_id)" : `json_array(${row}.replay_id)`);
      trigger(`map_scans_${event.toLowerCase()}`, event === "UPDATE" ? "UPDATE OF current_generation" : event, "map_scans", event === "UPDATE" ?
        "WHEN OLD.current_generation IS NOT NEW.current_generation" : `WHEN ${row}.current_generation IS NOT NULL`);
      trigger(`maps_${event.toLowerCase()}`, event, "maps", `WHEN EXISTS(SELECT 1 FROM map_scans WHERE source_id=${row}.source_id AND current_generation=${row}.generation)${event === "UPDATE" ?
        " AND (OLD.md5 IS NOT NEW.md5 OR OLD.locator IS NOT NEW.locator OR OLD.state IS NOT NEW.state OR OLD.metadata IS NOT NEW.metadata)" : ""}`);
    }
    trigger("sources_update", "UPDATE OF enabled,configured,config_revision", "sources", "WHEN OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured OR OLD.config_revision IS NOT NEW.config_revision");
    trigger("sources_delete", "DELETE", "sources");
    trigger("replays_update", "UPDATE OF metadata,merged_into", "replays", "WHEN OLD.metadata IS NOT NEW.metadata OR OLD.merged_into IS NOT NEW.merged_into",
      "json_array(OLD.id,NEW.id,OLD.merged_into,NEW.merged_into)");
    db.exec("PRAGMA user_version=27");
  }

  constructor(private readonly db: DatabaseSync) {}
  currentChangesSince(since?: string): LibraryResourceChanges {
    // SAVEPOINT also supports callers already inside a store transaction. No asynchronous work occurs.
    this.db.exec("SAVEPOINT resource_changes_read");
    try {
      const to = String(this.db.prepare("SELECT CAST(resource_revision AS TEXT) AS revision FROM query_projection_state WHERE id=1").get()?.revision ?? "");
      const from = since ?? to, all: LibraryResourceChanges = { from, to, scope: "all" };
      if (!counter(to) || !counter(since) || BigInt(since) > BigInt(to) || BigInt(to) - BigInt(since) > BigInt(RETAINED_REVISIONS)) return all;
      if (since === to) return { from, to, scope: "replays", replayIds: [] };
      const rows = this.db.prepare("SELECT CAST(revision AS TEXT) AS revision,scope,replay_ids FROM resource_changes WHERE revision>? AND revision<=? ORDER BY resource_changes.revision LIMIT ?")
        .all(since, to, RETAINED_REVISIONS);
      if (rows.length !== Number(BigInt(to) - BigInt(since))) return all;
      const ids = new Set<string>(); let expected = BigInt(since);
      for (const row of rows) {
        if (String(row.revision) !== String(++expected) || row.scope !== "replays") return all;
        let parsed: unknown;
        try { parsed = JSON.parse(String(row.replay_ids)); } catch { return all; }
        if (!Array.isArray(parsed) || !parsed.length || parsed.length > 4 || !parsed.every(libraryResourceReplayId)) return all;
        for (const id of parsed) ids.add(id);
        if (ids.size > LIBRARY_RESOURCE_CHANGE_IDS) return all;
      }
      return { from, to, scope: "replays", replayIds: [...ids].sort() };
    } finally { this.db.exec("RELEASE resource_changes_read"); }
  }
}
