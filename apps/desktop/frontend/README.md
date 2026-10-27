# Desktop frontend

React and MUI provide the application controls; Pixi renders the replay playfield. Services expose playback and analysis state through RxJS observables. React context provides shared services and settings-dialog state.

Replay tools live in the existing toolbar's **More** menu. **A/B loop…** sets exact range endpoints and an optional lead-in; Shift-dragging the original timeline selects a range, and its handles adjust the endpoints. **Export clip…** provides its own range fields, composition preview, 720p/1080p output, 30/60 FPS targets and the current audio mix. Export records in real time. Both tools preserve the original toolbar height and playfield size.

From the repository root, run `npm run desktop-frontend:dev` for the development renderer. `npm run storybook` starts the component-story development server; `npm run build-storybook` builds those stories. See [CONTRIBUTION.md](../../../CONTRIBUTION.md) for the complete Electron setup and verification commands.

Storybook's static build is verified, but its inherited 6.5 renderer/manager remain incompatible with React 19 at runtime. Interactive stories need a coordinated Storybook upgrade; use the desktop Jest/component checks in the meantime.

`node tools/verify-clip-renderer.cjs <output-directory>` checks real slider textures and the clip compositor in an isolated hidden Electron fixture. Add `--cadence` to check actual encoded frame cadence against the old scheduler. The cadence check also requires `ffprobe` on PATH. These fixtures use the installed or locally cached Electron runtime and never launch Rewind or download dependencies.
