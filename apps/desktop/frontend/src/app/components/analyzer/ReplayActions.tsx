import {
  Box,
  Button,
  Divider,
  Alert,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  Tooltip,
} from "@mui/material";
import {
  Add,
  AutoAwesome,
  BarChart,
  Clear,
  Close,
  CompareArrows,
  Help,
  IosShare,
} from "@mui/icons-material";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useObservable } from "rxjs-hooks";
import { HelpModalDialog } from "./HelpModal";
import { FullMapAnalysisDialog } from "./FullMapAnalysisDialog";
import { ReplayComparisonDialog } from "./ReplayComparisonDialog";
import { centerUp, DockButtonLabel, dockIconButton, dockTextButton, useDockLabelsHidden } from "./DockIconButtons";
import { MoreIcon } from "./icons";
import { useScreenshot } from "../../hooks/screenshot";
import { useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { preventPointerFocus } from "../../utils/focus";
import { REWIND_COLORS } from "../../styles/tokens";
import { analyzeFullMap } from "../../services/analysis/full-map-analysis";
import { buildFullMapAnalysisViewModel } from "../../services/analysis/full-map-analysis-view-model";
import type { ReplayComparisonState } from "../../services/common/game/GameSimulator";
import { isHitCircle, isSlider, type ReplayAnalysisRuleset } from "@osujs/core";
import { frontendAPI } from "../../api";
import { collectReplayAimEvidence } from "../../services/analysis/aim-consistency";
import { collectFullMapAimScatter } from "../../services/analysis/full-map-aim-scatter";
import { summarizeReplayEvents } from "../../services/analysis/replay-events";
import { summarizeErrorCauses } from "./full-map-error-causes";
import { isLazerReplay } from "../../model/OsuReplay";
import { MIN_CLIP_DURATION_MS } from "../../services/manager/clip-export-types";
import { LibraryViewerNavigation, useLibraryUi } from "../replay-library-host";
import { of } from "rxjs";

/** Applied to an action that is off only because no replay is ready; Settings and ⋮ never get it. */
const noReplayDim = { opacity: 0.38, "&.Mui-disabled": { color: REWIND_COLORS.textBright } } as const;

/** The ⋮ menu's icons are 18 px, the size of the dock's text-button icons plus two. */
const menuIconSx = { "& .MuiListItemIcon-root .MuiSvgIcon-root": { fontSize: 18 } } as const;

/** `replayReady` defaults to true: a caller that does not track the load state keeps today's behaviour. */
export function ReplayActions({ settings, replayReady = true }: { settings?: ReactNode; replayReady?: boolean } = {}) {
  const libraryUi=useLibraryUi();
  const fullMapRequest=useObservable(()=>libraryUi?.fullMapRequest$??of(0),0);
  const stableSettingsRequest=useObservable(()=>libraryUi?.stableSettingsRequest$??of(0),0);
  const handledLibraryRequest=useRef({fullMap:0,stableSettings:0});
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [replayComparisonOpen, setReplayComparisonOpen] = useState(false);
  const [comparisonErrorOpen, setComparisonErrorOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  // F12 is heard above every screen (see `hooks/screenshot`); the menu only closes for it, and waits out a capture.
  const screenshot = useScreenshot();
  const takingScreenshot = screenshot.capturing;
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = anchorEl;
  const { registerMenu } = screenshot;
  useEffect(() => {
    registerMenu({ isOpen: () => anchorRef.current !== null, close: () => setAnchorEl(null) });
    return () => registerMenu(null);
  }, [registerMenu]);
  const analyzer = useAnalysisApp();
  const clipState = useObservable(() => analyzer.clipRecorder.state$, analyzer.clipRecorder.state$.value);
  const busy = ["preparing", "recording", "rendering", "saving"].includes(clipState.status);
  const { exportSession, toggleExport, openSettings } = useInspector();
  // The titles only explain a button whose label is hidden.
  const labelHidden = useDockLabelsHidden();
  const replayEvents = useObservable(() => analyzer.gameSimulator.replayEvents$, []);
  const lazerAvailable = useObservable(() => analyzer.gameSimulator.lazerAvailable$, false);
  const rulesetFocus = useObservable(() => analyzer.gameSimulator.rulesetFocus$, "stable");
  const performanceRevision = useObservable(() => analyzer.performanceTimeline.changed$, 0);
  const fullMapPerformance = useMemo(
    () => (analysisOpen ? analyzer.performanceTimeline.fullMap(rulesetFocus) : undefined),
    [analyzer.performanceTimeline, analysisOpen, rulesetFocus, performanceRevision],
  );
  // The session the replay view's error list reads its causes from; the page counts the same ones.
  const missSession = useObservable(
    () => analyzer.gameSimulator.missExplanations$,
    analyzer.gameSimulator.missExplanations$.value,
  );
  const errorCauses = useMemo(() => {
    if (!analysisOpen) return undefined;
    const { errors } = summarizeReplayEvents(replayEvents, rulesetFocus);
    return summarizeErrorCauses({ errors, events: replayEvents, ruleset: rulesetFocus, session: missSession });
  }, [analysisOpen, replayEvents, rulesetFocus, missSession]);
  const validation = useObservable(() => analyzer.gameSimulator.validation$, analyzer.gameSimulator.validation$.value);
  const replayComparison = useObservable<ReplayComparisonState>(() => analyzer.gameSimulator.replayComparison$, {
    status: "EMPTY",
  });

  // Export needs a ready replay long enough for a clip, and no clip being made.
  const exportDisabled =
    busy || !replayReady || !analyzer.gameSimulator.getPrimaryReplay() || analyzer.gameClock.durationInMs < MIN_CLIP_DURATION_MS;
  // The compare actions wait for a ready replay, and for a screenshot in flight.
  const compareDisabled = takingScreenshot || !replayReady;

  const handleClose = () => setAnchorEl(null);
  const handleOpenHelp = () => {
    setHelpOpen(true);
    handleClose();
  };
  const handleOpenAnalysis = useCallback(() => {
    const sourceEvents = analyzer.gameSimulator.getEventsForRuleset(rulesetFocus);
    if (sourceEvents.length === 0 || !analyzer.gameSimulator.getPrimaryReplay()) {
      setAnchorEl(null);
      return;
    }
    analyzer.gameClock.pause();
    setAnalysisOpen(true);
    setAnchorEl(null);
  },[analyzer,rulesetFocus]);
  useEffect(()=>{
    if(fullMapRequest<=handledLibraryRequest.current.fullMap||!replayReady||!replayEvents.length)return;
    handledLibraryRequest.current.fullMap=fullMapRequest;handleOpenAnalysis();
  },[fullMapRequest,replayReady,replayEvents,handleOpenAnalysis]);
  useEffect(()=>{
    if(stableSettingsRequest<=handledLibraryRequest.current.stableSettings)return;
    handledLibraryRequest.current.stableSettings=stableSettingsRequest;openSettings({tab:"general"});
  },[stableSettingsRequest,openSettings]);
  const handleSwitchAnalysisRuleset = useCallback(
    (target: ReplayAnalysisRuleset) => {
      analyzer.gameSimulator.setRulesetFocus(target);
    },
    [analyzer.gameSimulator],
  );
  const analysisViewModel = useMemo(() => {
    if (!analysisOpen || replayEvents.length === 0) return undefined;

    const sourceEvents = analyzer.gameSimulator.getEventsForRuleset(rulesetFocus);
    const replay = analyzer.gameSimulator.getPrimaryReplay();
    if (sourceEvents.length === 0 || !replay) return undefined;

    const beatmap = analyzer.getBeatmap();
    const metadata = analyzer.scenarioManager.getBeatmapMetadata();
    const supportedLazerMainIds = new Set(
      beatmap.hitObjects.flatMap((hitObject) => {
        if (hitObject.type === "HIT_CIRCLE") return [hitObject.id];
        if (isSlider(hitObject))
          return [beatmap.lazerModSettings.classic?.noSliderHeadAccuracy ? hitObject.id : hitObject.head.id];
        if (hitObject.type === "SPINNER") return [hitObject.id];
        return [];
      }),
    );
    const analysisEvents =
      rulesetFocus === "stable"
        ? sourceEvents
        : sourceEvents.filter(
            (event) => event.type !== "HitObjectJudgement" || supportedLazerMainIds.has(event.hitObjectId),
          );
    const finalInfo = analyzer.gameSimulator.getFinalInfoForRuleset(rulesetFocus);
    const finalStats = analyzer.gameSimulator.getFinalScoreStatsForRuleset(rulesetFocus);
    const completionTimeMs = beatmap.hitObjects.reduce<number | null>((latest, hitObject) => {
      const objectEndTime = isHitCircle(hitObject) ? hitObject.hitTime : hitObject.endTime;
      if (!Number.isFinite(objectEndTime)) return latest;
      return latest === null ? objectEndTime : Math.max(latest, objectEndTime);
    }, null);
    const chartTimeline = beatmap.hitObjects.reduce<{
      start: number | null;
      end: number | null;
      lastObjectStart: number | null;
    }>(
      (range, hitObject) => {
        if (!isHitCircle(hitObject) && !isSlider(hitObject)) return range;
        const objectStartTime = isHitCircle(hitObject) ? hitObject.hitTime : hitObject.startTime;
        const objectEndTime = isHitCircle(hitObject) ? hitObject.hitTime : hitObject.endTime;
        return {
          start: Number.isFinite(objectStartTime)
            ? range.start === null
              ? objectStartTime
              : Math.min(range.start, objectStartTime)
            : range.start,
          end: Number.isFinite(objectEndTime)
            ? range.end === null
              ? objectEndTime
              : Math.max(range.end, objectEndTime)
            : range.end,
          lastObjectStart: Number.isFinite(objectStartTime)
            ? range.lastObjectStart === null
              ? objectStartTime
              : Math.max(range.lastObjectStart, objectStartTime)
            : range.lastObjectStart,
        };
      },
      { start: null, end: null, lastObjectStart: null },
    );
    const summary = analyzeFullMap({
      ruleset: rulesetFocus,
      events: analysisEvents,
      hits: analyzer.gameSimulator.getHitsForRuleset(rulesetFocus),
      startTime: chartTimeline.start ?? 0,
      duration: chartTimeline.end ?? completionTimeMs ?? analyzer.gameClock.durationInMs,
      baseRate: analyzer.gameClock.baseRate,
      aggregateAccuracyInput: finalInfo?.accuracy,
      aggregateJudgementCountsInput: finalInfo?.verdictCounts,
      maxComboObtained: finalStats?.maxComboSoFar,
      mapMaxCombo: finalStats?.mapMaxCombo,
      objectCoverage: {
        totalObjectCount: beatmap.hitObjects.length,
        excludedSpinnerCount: 0,
        unsupportedObjectCount: 0,
      },
      aimEvidence: collectReplayAimEvidence(
        beatmap,
        replay,
        sourceEvents,
        analyzer.gameSimulator.getTimingUnreliableHitObjectIds(rulesetFocus),
      ),
    });

    const finalReplayFrame = replay.frames[replay.frames.length - 1];
    // Aim reads the unfiltered events, as the aim evidence above does: Classic slider heads are judged hits too.
    const aim = collectFullMapAimScatter(beatmap, replay, sourceEvents);
    // Marks read the unfiltered events too, so the lane under the graph is the replay view's own timeline.
    const { timings } = summarizeReplayEvents(sourceEvents, rulesetFocus);
    // The timeline's slider-break colour is Stable's slider breaks and Lazer's missed slider ticks.
    const sliderBreak = rulesetFocus === "lazer" ? timings.lazerSliderTickMiss : timings.sliderBreak;

    return buildFullMapAnalysisViewModel({
      summary,
      aim,
      marks: { miss: timings.miss, sliderBreak, ok: timings.ok, meh: timings.meh },
      context: {
        title: metadata?.title,
        artist: metadata?.artist,
        difficulty: metadata?.difficultyName,
        player: replay.player,
      },
      replay: {
        lastFrameTimeMs: finalReplayFrame?.time ?? null,
        mods: replay.mods,
        lazerMods: replay.lazerMods,
        sourceRuleset: isLazerReplay(replay) ? "lazer" : "stable",
      },
      beatmap: {
        durationMs: analyzer.gameClock.durationInMs,
        completionTimeMs,
        // Trim only the graph axes; analysis sections and completion still include slider tails.
        chartEndTimeMs: chartTimeline.lastObjectStart,
        objectCount: beatmap.hitObjects.length,
        hitCircleCount: beatmap.hitObjects.filter(isHitCircle).length,
        sliderCount: beatmap.hitObjects.filter(isSlider).length,
        timingPoints: beatmap.controlPointInfo.timingPoints.list.map((point) => ({
          time: point.time,
          beatLength: point.beatLength,
        })),
        difficulty: {
          drainRate: beatmap.difficulty.drainRate,
          circleSize: beatmap.difficulty.circleSize,
          overallDifficulty: beatmap.difficulty.overallDifficulty,
          approachRate: beatmap.difficulty.approachRate,
        },
      },
    });
  }, [analysisOpen, analyzer, replayEvents, rulesetFocus]);
  const handleCompareReplay = async () => {
    handleClose();
    const file = await frontendAPI.selectReplayFile(analyzer.osuFolderService.replaysFolder$.getValue());
    if (!file) return;
    const state = await analyzer.loadComparisonReplay(file);
    if (state?.status === "READY") setReplayComparisonOpen(true);
  };
  const handleCompareAutoplay = () => {
    handleClose();
    setReplayComparisonOpen(false);
    analyzer.compareWithAutoplayReference();
  };
  const handleClearReplayComparison = () => {
    analyzer.clearReplayComparison();
    setReplayComparisonOpen(false);
    handleClose();
  };
  useEffect(() => {
    if (analysisOpen && (replayEvents.length === 0 || !analyzer.gameSimulator.getPrimaryReplay())) {
      setAnalysisOpen(false);
    }
  }, [analysisOpen, analyzer.gameSimulator, replayEvents]);
  useEffect(() => {
    if (replayComparison.status === "ERROR") setComparisonErrorOpen(true);
    if (replayComparison.status !== "READY" || replayComparison.sourceKind !== "replay") {
      setReplayComparisonOpen(false);
    }
  }, [replayComparison]);

  return (
    <>
      <HelpModalDialog isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
      {replayComparison.status === "READY" && replayComparison.sourceKind === "replay" && (
        <ReplayComparisonDialog
          open={replayComparisonOpen}
          state={replayComparison}
          onClose={() => setReplayComparisonOpen(false)}
          onClear={handleClearReplayComparison}
        />
      )}
      <Snackbar
        open={comparisonErrorOpen && replayComparison.status === "ERROR"}
        autoHideDuration={6500}
        onClose={() => setComparisonErrorOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" variant="filled" onClose={() => setComparisonErrorOpen(false)}>
          {replayComparison.status === "ERROR" ? replayComparison.message : "Could not build replay comparison"}
        </Alert>
      </Snackbar>
      {analysisViewModel && (
        <FullMapAnalysisDialog
          open={analysisOpen}
          viewModel={analysisViewModel}
          performance={fullMapPerformance}
          errorCauses={errorCauses}
          replayValidation={validation}
          canSwitchRuleset={lazerAvailable}
          onSwitchRuleset={handleSwitchAnalysisRuleset}
          onOpenReplayAt={(timeMs) => {
            // A clip export drives the clock itself until it is done.
            if (analyzer.clipRecorder.isBusy) return;
            analyzer.gameClock.seekTo(timeMs);
            setAnalysisOpen(false);
          }}
          onClose={() => setAnalysisOpen(false)}
        />
      )}
      {replayComparison.status === "READY" && (
        <Tooltip title={`Exit comparison with ${replayComparison.secondary.label}`}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<Clear />}
            aria-label="Exit replay comparison"
            onClick={handleClearReplayComparison}
            sx={{
              height: 28,
              minWidth: { xs: 26, lg: "auto" },
              px: { xs: 0.5, lg: 1 },
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 500,
              color: REWIND_COLORS.textPrimary,
              backgroundColor: "rgba(255,255,255,0.05)",
              borderColor: "rgba(255,255,255,0.18)",
              "& .MuiButton-startIcon": { mr: { xs: 0, lg: 0.75 }, ml: 0, "& svg": { fontSize: 15 } },
              "&:hover": {
                backgroundColor: "rgba(255,255,255,0.09)",
                borderColor: "rgba(255,255,255,0.32)",
              },
            }}
          >
            <Box component="span" sx={{ display: { xs: "none", lg: "inline" } }}>
              Exit comparison
            </Box>
          </Button>
        </Tooltip>
      )}
      {settings}
      <Button
        size="small"
        aria-label="Full-map analysis"
        title={labelHidden ? "Analysis" : undefined}
        startIcon={<BarChart />}
        disabled={replayEvents.length === 0 || !replayReady}
        onClick={handleOpenAnalysis}
        onMouseDown={preventPointerFocus}
        sx={replayReady ? dockTextButton : { ...dockTextButton, ...noReplayDim }}
      >
        <DockButtonLabel>Analysis</DockButtonLabel>
      </Button>
      <LibraryViewerNavigation/>
      <Tooltip title={takingScreenshot ? "" : "More"}>
        <IconButton
          size="small"
          aria-label="More replay actions"
          aria-haspopup="true"
          disabled={takingScreenshot}
          onClick={(event) => setAnchorEl(event.currentTarget)}
          onMouseDown={preventPointerFocus}
          sx={dockIconButton}
        >
          <MoreIcon />
        </IconButton>
      </Tooltip>
      <Menu
        open={Boolean(anchorEl)}
        onClose={handleClose}
        anchorEl={anchorEl}
        MenuListProps={{ "aria-label": "More replay actions", sx: menuIconSx }}
        TransitionProps={{ onEnter: screenshot.menuEntered, onExited: screenshot.menuExited }}
        {...centerUp}
      >
        <MenuItem
          selected={exportSession}
          disabled={exportDisabled}
          onClick={() => {
            handleClose();
            toggleExport();
          }}
        >
          <ListItemIcon>
            <IosShare />
          </ListItemIcon>
          <ListItemText primary={exportSession ? "Close export" : "Export clip"} />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => void handleCompareReplay()} disabled={compareDisabled || replayEvents.length === 0}>
          <ListItemIcon>
            <Add />
          </ListItemIcon>
          <ListItemText primary="Compare with another replay…" />
        </MenuItem>
        <MenuItem onClick={handleCompareAutoplay} disabled={compareDisabled || replayEvents.length === 0}>
          <ListItemIcon>
            <AutoAwesome />
          </ListItemIcon>
          <ListItemText primary="Compare with Autoplay" />
        </MenuItem>
        {replayComparison.status === "READY" && replayComparison.sourceKind === "replay" && (
          <MenuItem
            disabled={compareDisabled}
            onClick={() => {
              setReplayComparisonOpen(true);
              handleClose();
            }}
          >
            <ListItemIcon>
              <CompareArrows />
            </ListItemIcon>
            <ListItemText primary="Open replay comparison" />
          </MenuItem>
        )}
        <Divider />
        <MenuItem onClick={handleOpenHelp}>
          <ListItemIcon>
            <Help />
          </ListItemIcon>
          <ListItemText>Keyboard shortcuts</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            handleClose();
            void analyzer.scenarioManager.clearReplay();
          }}
          disabled={!analyzer.gameSimulator.getPrimaryReplay()}
        >
          <ListItemIcon>
            <Close />
          </ListItemIcon>
          <ListItemText primary="Close replay" />
        </MenuItem>
      </Menu>
    </>
  );
}
