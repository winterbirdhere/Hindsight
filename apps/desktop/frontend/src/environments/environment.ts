// This file can be replaced during build by using the `fileReplacements` array.
// When building for production, this file is replaced with `environment.prod.ts`.

export const environment = {
  production: false,
  // Open replays through the app by default; opt in to a local debug replay explicitly.
  debugAnalyzer: null as { replayPath: string } | null,
};
