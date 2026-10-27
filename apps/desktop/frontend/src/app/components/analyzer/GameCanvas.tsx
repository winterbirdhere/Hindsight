import React, { useEffect, useRef } from "react";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { Box } from "@mui/material";
import { REWIND_COLORS } from "../../styles/tokens";
import { useReplayLoadState } from "../../hooks/replay-load-state";
import { StageEmpty, StageError, StageLoading } from "./StageStates";

export const GameCanvas = () => {
  const canvasContainer = useRef<HTMLDivElement | null>(null);
  const analysisApp = useAnalysisApp();
  const loadState = useReplayLoadState();

  useEffect(() => {
    const container = canvasContainer.current;
    if (!container) return;

    // Pixi destroys the canvas's WebGL context on cleanup. StrictMode reruns
    // this effect, so the next renderer needs a fresh canvas as well.
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
    container.appendChild(canvas);
    console.log("Initializing renderer to the canvas");
    analysisApp.onEnter(canvas);

    return () => {
      analysisApp.onHide();
      canvas.remove();
    };
  }, [analysisApp]);

  return (
    <Box
      // The wheel steps the playhead over the stage (see `usePlaybackWheel`).
      data-playback-wheel
      sx={{
        overflow: "hidden",
        position: "relative",
        height: "100%",
        backgroundColor: REWIND_COLORS.stage,
      }}
    >
      <div ref={canvasContainer} style={{ width: "100%", height: "100%" }} />
      {/* Inner vignette softens the art's edges against the inspector and the dock (spec §2.1); live view only. */}
      <Box
        aria-hidden
        data-testid="stage-vignette"
        sx={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
          boxShadow: "inset 0 0 60px rgba(0,0,0,0.55)",
        }}
      />
      {/* Overlay: the empty, loading and failed states of the stage (cards 7d / 7e / 7f). */}
      {loadState.phase !== "ready" && (
        <Box
          data-testid="stage-overlay"
          sx={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            zIndex: 2,
            lineHeight: 1.4,
            backgroundColor: REWIND_COLORS.stage,
          }}
        >
          {loadState.phase === "idle" && <StageEmpty />}
          {loadState.phase === "loading" && <StageLoading state={loadState} />}
          {loadState.phase === "failed" && <StageError state={loadState} />}
        </Box>
      )}
    </Box>
  );
};
