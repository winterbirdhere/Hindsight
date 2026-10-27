import { Box, ButtonBase } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import { useId } from "react";
import { useObservable } from "rxjs-hooks";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { exportProgress, type ExportStep } from "../../services/manager/clip-export-progress";
import type { ClipRunSummary } from "../../services/manager/clip-export-types";
import { formatClipSeconds, formatClipTime } from "../../services/manager/clip-range";
import { thinScrollbar } from "../../styles/scrollbar";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { visuallyHidden } from "../analyzer/incident-format";
import { SettingsSection, ValueRow } from "../settings/controls";
import { ExportSprint } from "./ExportSprint";

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";
const SECTION_HAIRLINE = "inset 0 -1px 0 rgba(255,255,255,0.08)";
const FOOTER_HAIRLINE = "inset 0 1px 0 rgba(255,255,255,0.08)";
const DASH = "—";

/** The glow of the active step's dot, between 4 and 10 px (the mock's pulse). */
const glow = keyframes`
  0%, 100% { box-shadow: 0 0 4px ${REWIND_COLORS.accentGlow}; }
  50% { box-shadow: 0 0 10px ${REWIND_COLORS.accentGlow}; }
`;

const RESOLUTION_NAMES: Record<number, string> = { 1920: "1080p", 2560: "1440p", 3840: "4K" };

function outputSummary(run: ClipRunSummary): string {
  const parts = [RESOLUTION_NAMES[run.width] ?? `${run.width} px`, `${run.fps} FPS`];
  if (run.speed !== 1) parts.push(`${formatClipSeconds(run.speed)}×`);
  parts.push(run.audio ? "audio" : "no audio");
  return parts.join(" · ");
}

function StepMark({ state }: { state: ExportStep["state"] }) {
  if (state === "done") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false" style={{ display: "block" }}>
        <polyline
          points="2,6.5 5,9 10,3"
          style={{ fill: "none", stroke: REWIND_COLORS.judgement100, strokeWidth: 1.8 }}
        />
      </svg>
    );
  }
  if (state === "active") {
    return (
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: REWIND_COLORS.accent,
          // Steady under reduced motion.
          boxShadow: `0 0 7px ${REWIND_COLORS.accentGlow}`,
          animation: `${glow} 1.6s ease-in-out infinite`,
          [REDUCED_MOTION]: { animation: "none" },
        }}
      />
    );
  }
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: REWIND_COLORS.textQuaternary }}
    />
  );
}

/** The state of a step in words, for assistive technology. A skipped step's own detail already says so. */
const STEP_STATE_TEXT: Record<ExportStep["state"], string | undefined> = {
  done: "done",
  active: "in progress",
  pending: "pending",
  skipped: undefined,
};

const stepColour = (state: ExportStep["state"]) =>
  state === "active" ? REWIND_COLORS.textPrimary : state === "done" ? REWIND_COLORS.textSecondary : REWIND_COLORS.textDim;

const summaryValueSx = {
  fontFamily: REWIND_FONTS.mono,
  fontWeight: 600,
  fontSize: 12.5,
  lineHeight: "18px",
  textAlign: "right",
  overflowWrap: "anywhere",
  color: REWIND_COLORS.textPrimary,
} as const;

/**
 * The inspector's view while a clip is exporting (18d): a header, the current step with one overall percentage and
 * the sprint lane, the four steps, a summary of the clip and `Cancel export`. It reads the recorder's state and run
 * summary on every render and keeps none of it, so a view mounted again mid-export shows the right totals. It fills the
 * height its parent gives it; the middle scrolls vertically, never sideways.
 */
export function ExportProgress() {
  const { clipRecorder } = useAnalysisApp();
  const state = useObservable(() => clipRecorder.state$, clipRecorder.state$.value);
  const run = useObservable(() => clipRecorder.run$, clipRecorder.run$.value);
  const model = exportProgress(state, run);
  const headingId = useId();

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: REWIND_COLORS.surface,
        color: REWIND_COLORS.textBright,
        fontFamily: REWIND_FONTS.ui,
      }}
    >
      <Box
        sx={{
          height: 52,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          p: "0 20px",
          boxShadow: `inset 0 -1px 0 ${REWIND_COLORS.hairline}`,
        }}
      >
        <Box
          component="h2"
          id={headingId}
          sx={{
            flex: 1,
            m: 0,
            whiteSpace: "nowrap",
            fontFamily: REWIND_FONTS.ui,
            fontWeight: 600,
            fontSize: 15.5,
            color: REWIND_COLORS.textPrimary,
          }}
        >
          Exporting clip
        </Box>
        <Box
          component="span"
          sx={{
            fontFamily: REWIND_FONTS.mono,
            fontSize: 11.5,
            textAlign: "right",
            whiteSpace: "nowrap",
            color: REWIND_COLORS.textTertiary,
          }}
        >
          locked
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowX: "hidden", overflowY: "auto", ...thinScrollbar }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: "4px", p: "16px 20px 6px" }}>
          <Box sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" }}>
            <Box
              component="h3"
              aria-live="polite"
              sx={{
                m: 0,
                minWidth: 0,
                overflowWrap: "anywhere",
                fontFamily: REWIND_FONTS.ui,
                fontWeight: 600,
                fontSize: 20,
                lineHeight: 1.2,
                letterSpacing: "-0.01em",
                color: REWIND_COLORS.textPrimary,
              }}
            >
              {model.title}
            </Box>
            {/* The live title is a sibling, not a child: a progressbar's content is not announced as it changes. */}
            <Box
              component="span"
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={model.percent}
              sx={{
                flex: "none",
                fontFamily: REWIND_FONTS.mono,
                fontWeight: 500,
                fontSize: 18,
                fontVariantNumeric: "tabular-nums",
                color: REWIND_COLORS.textPrimary,
              }}
            >
              {`${model.percent}%`}
            </Box>
          </Box>
          <Box
            component="span"
            sx={{ fontFamily: REWIND_FONTS.mono, fontSize: 12, color: REWIND_COLORS.textTertiary }}
          >
            {model.subline}
          </Box>
          <ExportSprint fraction={model.fraction} rendering={model.rendering} />
        </Box>

        <Box component="ul" sx={{ m: 0, listStyle: "none", p: "0 20px 12px", boxShadow: SECTION_HAIRLINE }}>
          {model.steps.map((step) => (
            <Box
              component="li"
              key={step.id}
              data-state={step.state}
              aria-current={step.state === "active" ? "step" : undefined}
              sx={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                height: 30,
                fontSize: 13.5,
                fontWeight: step.state === "active" ? 600 : 400,
                color: stepColour(step.state),
              }}
            >
              <Box component="span" sx={{ width: 12, flex: "none", display: "grid", placeItems: "center" }}>
                <StepMark state={step.state} />
              </Box>
              <Box component="span" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                {step.label}
              </Box>
              {STEP_STATE_TEXT[step.state] && (
                <Box component="span" sx={visuallyHidden}>
                  {STEP_STATE_TEXT[step.state]}
                </Box>
              )}
              {step.detail && (
                <Box
                  component="span"
                  sx={{
                    flex: "none",
                    fontFamily: REWIND_FONTS.mono,
                    fontSize: 12,
                    fontWeight: 400,
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                    color: REWIND_COLORS.textTertiary,
                  }}
                >
                  {step.detail}
                </Box>
              )}
            </Box>
          ))}
        </Box>

        <SettingsSection label="CLIP" last>
          <ValueRow label="Range">
            <Box component="span" sx={summaryValueSx}>
              {run ? `${formatClipTime(run.startMs)} – ${formatClipTime(run.endMs)}` : DASH}
            </Box>
          </ValueRow>
          <ValueRow label="Output">
            <Box component="span" sx={summaryValueSx}>
              {run ? outputSummary(run) : DASH}
            </Box>
          </ValueRow>
          <ValueRow label="Format">
            <Box component="span" sx={summaryValueSx}>
              {clipRecorder.getFormat().label}
            </Box>
          </ValueRow>
        </SettingsSection>
      </Box>

      <Box sx={{ flex: "none", display: "flex", flexDirection: "column", gap: "14px", p: "12px 20px 16px", boxShadow: FOOTER_HAIRLINE }}>
        <Box
          component="p"
          sx={{ m: 0, fontSize: 12.5, lineHeight: 1.4, color: REWIND_COLORS.textSecondary, textWrap: "pretty" }}
        >
          Playback and the timeline are locked until the export finishes.
        </Box>
        <ButtonBase
          onClick={() => {
            // The recorder reports its own failures; a rejection must not surface as an unhandled one.
            void Promise.resolve(clipRecorder.cancel()).catch(() => undefined);
          }}
          onMouseDown={preventPointerFocus}
          sx={{
            width: "100%",
            height: 44,
            borderRadius: "10px",
            backgroundColor: REWIND_COLORS.control,
            boxShadow: REWIND_COLORS.controlEdge,
            fontFamily: REWIND_FONTS.ui,
            fontWeight: 600,
            fontSize: 14,
            color: REWIND_COLORS.textPrimary,
            "&:hover": { backgroundColor: REWIND_COLORS.controlHover },
            "&.Mui-focusVisible": REWIND_FOCUS_RING,
          }}
        >
          Cancel export
        </ButtonBase>
      </Box>
    </Box>
  );
}
