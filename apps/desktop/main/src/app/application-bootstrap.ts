import { app } from "electron";
import { mkdirSync } from "fs";
import { preserveDevelopmentProfile } from "./application-profile";

// Must execute before electron-log captures paths and before application services
// or the single-instance lock access persistent storage.
preserveDevelopmentProfile(app, (directory) => {
  mkdirSync(directory, { recursive: true });
});
