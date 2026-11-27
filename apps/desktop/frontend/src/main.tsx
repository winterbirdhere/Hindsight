import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { RewindApp } from "./app/RewindApp";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { HashRouter } from "react-router-dom";
import { rewindTheme } from "./app/styles/theme";
import { TheaterProvider } from "./app/providers/TheaterProvider";
import { createRewindTheater } from "./app/services/common/CommonManagers";
import { frontendAPI } from "./app/api";
import log from "electron-log";
import { join } from "path";
import "@fontsource/geist/300.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import { ensureRewindFonts } from "./app/styles/fonts";
import { configureMissAnalysisWorker } from "./app/services/analysis/miss-explanation/MissAnalysisClient";
import { createMissAnalysisWorker } from "./app/services/analysis/miss-explanation/miss-analysis-browser";
import { configureLibraryReplayWorker } from "./app/services/library/library-replay-worker";
import { createLibraryReplayWorker } from "./app/services/library/library-replay-browser";
import { configureLibraryAnalysisWorker } from "./app/services/library/library-analysis-client";
import { createLibraryAnalysisWorker } from "./app/services/library/library-analysis-browser";

(async function () {
  // Recommended way to use electron-log whenever we write console.log
  Object.assign(console, log.functions);

  const [appVersion, appPlatform, appResourcesPath] = await Promise.all([
    frontendAPI.getAppVersion(),
    frontendAPI.getPlatform(),
    frontendAPI.getPath("appResources"),
  ]);
  const rewindSkinsFolder = join(appResourcesPath, "Skins");

  console.log(`Booting Hindsight application with ${JSON.stringify({ appVersion, appPlatform, rewindSkinsFolder })}`);

  configureMissAnalysisWorker(createMissAnalysisWorker);
  configureLibraryReplayWorker(createLibraryReplayWorker);
  configureLibraryAnalysisWorker(createLibraryAnalysisWorker);
  const theater = createRewindTheater({
    appVersion,
    appPlatform,
    rewindSkinsFolder,
  });

  // Pixi key caps and exported side panels rasterise text; they must never use a fallback face.
  if (!(await ensureRewindFonts().catch(() => false))) console.warn("Hindsight interface fonts did not load");

  const container = document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  root.render(
    <StrictMode>
      {/* Using `HashRouter` because Electron loads the app from a local file. */}
      <HashRouter>
        <ThemeProvider theme={rewindTheme}>
          <CssBaseline />
          <TheaterProvider theater={theater}>
            <RewindApp />
          </TheaterProvider>
        </ThemeProvider>
      </HashRouter>
    </StrictMode>,
  );
})();
