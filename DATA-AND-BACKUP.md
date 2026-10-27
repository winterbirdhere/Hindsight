# Data locations and backups

The packaged Hindsight default profile is **`%APPDATA%\Hindsight`**. Ordinary source development retains the legacy **`%APPDATA%\rewind`** profile. An explicit custom or trial profile can use a different location. These profiles remain separate; Hindsight does not automatically merge or migrate them. Moving the application folder does not move a profile stored under AppData.

The profile contains application preferences and browser storage, window state, the replay-library database, collections/review metadata, caches and app-owned imported replay files. Copying only a database file does not back up all of this data.

By default, the packaged app keeps its application data (`userData`) and browser/session data (`sessionData`) in the same profile folder. Custom or trial setups can configure them separately. When they are separate, back up **both complete directories**; the application-data directory alone may omit browser preferences and session storage. Keep a record of both configured locations.

## Before using a preview

1. Close Hindsight normally and wait for it to exit completely.
2. Copy the **entire profile directory** to a separate backup location. If `sessionData` is configured separately from `userData`, copy that entire directory too. Preserve all subdirectories, including browser storage and the library/import data.
3. Keep an independent backup of your original osu! data, replays, beatmaps, audio and skins. External source files are not included merely because the library indexes them.

Keep the original backup until the preview and its data are working. Do not copy or restore an active profile: database sidecars and browser storage can be inconsistent while the app is running.

## Restoring

Close Hindsight completely. Preserve the current profile separately before restoring a complete backup to the same profile location. For a split setup, preserve and restore both `userData` and `sessionData` to their respective configured locations. Restore with the application version used for that backup where possible; cross-version downgrade compatibility is not established.

Reindexing or rebuilding can recover some derived information from available source files. It is not a substitute for a full backup: collections, review metadata, preferences and imported files may have no recoverable external source. Do not delete a profile or original osu! data as a troubleshooting shortcut.

Profiles and diagnostics may contain player names, personal filesystem paths and replay history. Review them before sharing and follow [bug-report guidance](BUG-REPORTING.md).
