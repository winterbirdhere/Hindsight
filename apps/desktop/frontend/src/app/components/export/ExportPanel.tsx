import { Box, ButtonBase } from "@mui/material";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useObservable } from "rxjs-hooks";
import { frontendAPI } from "../../api";
import { useClipExportRange } from "../../hooks/clip-export";
import { useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { clipAppearanceOptions } from "../../services/analysis/clip-export-settings";
import {
  CLIP_EXPORT_FRAME_RATES,
  CLIP_EXPORT_WIDTHS,
  createClipFramePlan,
  type ClipExportFrameRate,
  type ClipExportOptions,
  type ClipExportWidth,
  type ClipRecorderState,
} from "../../services/manager/clip-export-types";
import {
  clipVideoSeconds,
  formatClipSeconds,
  formatClipTime,
  parseClipTime,
  withClipEnd,
  withClipLength,
  withClipStart,
} from "../../services/manager/clip-range";
import { thinScrollbar } from "../../styles/scrollbar";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { visuallyHidden } from "../analyzer/incident-format";
import { SpeedStepper } from "../analyzer/SpeedStepper";
import { FolderButton } from "../analyzer/OsuDirectorySettings";
import { Segmented, SettingsSection, TextToggle, ValueRow } from "../settings/controls";
import { ExportProgress } from "./ExportProgress";

const SECTION_HAIRLINE = "inset 0 -1px 0 rgba(255,255,255,0.08)";
const FOOTER_HAIRLINE = "inset 0 1px 0 rgba(255,255,255,0.1)";
const BUSY_STATUSES: ReadonlyArray<ClipRecorderState["status"]> = ["preparing", "recording", "rendering", "saving"];
/** The page ink of the summary's length (the mock's #e8e6e1). */
const SUMMARY_INK = "#e8e6e1";
/** The link's hover colour (the mock's #ffc2d6). */
const LINK_HOVER = "#ffc2d6";

/** Below this panel width (the inspector is 240 to 440 px) the range fields and the saved clip's buttons are two rows. */
const NARROW = "@container (max-width: 329px)";

const RESOLUTIONS: ReadonlyArray<{ value: string; label: string }> = CLIP_EXPORT_WIDTHS.map((width) => ({
  value: String(width),
  label: width === 3840 ? "4K" : `${(width * 9) / 16}p`,
}));
const FRAME_RATES: ReadonlyArray<{ value: string; label: string }> = CLIP_EXPORT_FRAME_RATES.map((fps) => ({
  value: String(fps),
  label: String(fps),
}));
const resolutionName = (width: number) => RESOLUTIONS.find((option) => option.value === String(width))?.label ?? `${width} px`;

type RangeFieldName = "start" | "end" | "length";
/**
 * What the user has typed into a field and not yet left, with the values it was typed against (`bounds`): a field's
 * draft is only as good as those. When any of them changes from outside, the user's newer input wins and the draft goes.
 */
interface Draft {
  text: string;
  bounds: readonly number[];
}
type Drafts = Partial<Record<RangeFieldName, Draft>>;

const sameBounds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Plain seconds: digits with an optional fraction. Anything else (times, signs, commas) is not a length. */
/**
 * What a range field takes: digits and a point, and a colon in Start and End, which hold a time. Anything else never
 * gets in, typed or pasted, so a field cannot hold a letter.
 */
function allowedRangeText(name: RangeFieldName, text: string): string {
  return text.replace(name === "length" ? /[^0-9.]/g : /[^0-9:.]/g, "");
}

function parseSeconds(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : undefined;
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <path
        d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5"
        style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }}
      />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <path
        d="M3.5 1.5 L7 5 L3.5 8.5"
        style={{
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
    </svg>
  );
}

function SavedCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" focusable="false" style={{ display: "block", flex: "none" }}>
      <polyline
        points="2,6.5 5,9 10,3"
        style={{ fill: "none", stroke: REWIND_COLORS.judgement100, strokeWidth: 1.9 }}
      />
    </svg>
  );
}

const rangeLabelSx = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 11.5,
  lineHeight: "normal",
  color: REWIND_COLORS.textSecondary,
} as const;

/**
 * One of the three range fields: a 32 px text field under its label. Its shown text is the range's own value unless
 * the user is typing here (`draft`), in which case it is exactly what was typed.
 */
function RangeField({
  name,
  label,
  value,
  suffix,
  onType,
  onLeave,
  onKeyDown,
}: {
  name: RangeFieldName;
  label: string;
  value: string;
  suffix?: string;
  onType(name: RangeFieldName, text: string): void;
  onLeave(name: RangeFieldName): void;
  onKeyDown(name: RangeFieldName, event: KeyboardEvent<HTMLInputElement>): void;
}) {
  return (
    <Box
      component="label"
      sx={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: 0, cursor: "text" }}
    >
      <Box component="span" sx={rangeLabelSx}>
        {label}
      </Box>
      <Box
        data-range-field=""
        sx={{
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: "4px",
          p: "0 10px",
          borderRadius: "7px",
          backgroundColor: REWIND_COLORS.inset,
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)",
          // The brighter inset line is the focus cue: no outer ring.
          "&:focus-within": { boxShadow: `inset 0 0 0 1px ${REWIND_COLORS.focus}` },
          minWidth: 0,
        }}
      >
        <Box
          component="input"
          type="text"
          aria-label={label}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(event: { target: { value: string } }) => onType(name, event.target.value)}
          onBlur={() => onLeave(name)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => onKeyDown(name, event)}
          onKeyUp={(event: KeyboardEvent<HTMLInputElement>) => event.stopPropagation()}
          sx={{
            flex: 1,
            minWidth: 0,
            width: "100%",
            height: "100%",
            p: 0,
            m: 0,
            border: 0,
            outline: "none",
            backgroundColor: "transparent",
            fontFamily: REWIND_FONTS.mono,
            fontWeight: 500,
            fontSize: 13,
            color: REWIND_COLORS.textPrimary,
          }}
        />
        {suffix ? (
          <Box
            component="span"
            aria-hidden="true"
            sx={{ flex: "none", fontSize: 11.5, color: REWIND_COLORS.textDim }}
          >
            {suffix}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

/** The folder's own name: the last segment of the path, or the whole path when it has none (a drive root). */
function folderName(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.length > 1 || (segments.length === 1 && !/^[A-Za-z]:$/.test(segments[0]))
    ? segments[segments.length - 1]
    : path;
}

/** The saved clip's secondary button. */
function SecondaryButton({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return (
    <ButtonBase
      onClick={onClick}
      onMouseDown={preventPointerFocus}
      sx={{
        flex: 1,
        // Stacked, each button is as tall as it is and as wide as the footer.
        [NARROW]: { flex: "none" },
        minWidth: 0,
        height: 36,
        whiteSpace: "nowrap",
        p: "0 12px",
        borderRadius: "8px",
        backgroundColor: REWIND_COLORS.control,
        boxShadow: REWIND_COLORS.controlEdge,
        fontFamily: REWIND_FONTS.ui,
        fontWeight: 600,
        fontSize: 13,
        color: REWIND_COLORS.textPrimary,
        "&:hover": { backgroundColor: REWIND_COLORS.controlHover, color: REWIND_COLORS.white },
        "&.Mui-focusVisible": REWIND_FOCUS_RING,
      }}
    >
      {children}
    </ButtonBase>
  );
}

/**
 * The whole Export mode of the inspector (18a, 18c): the set-up view, or the exporting view while the recorder is busy.
 * It keeps nothing of an export itself: the recorder's state and run summary are the source of the saved clip, the
 * cancelled note and the error, which stay until the next export starts.
 */
export function ExportPanel() {
  const { clipRecorder } = useAnalysisApp();
  const state = useObservable(() => clipRecorder.state$, clipRecorder.state$.value);
  const run = useObservable(() => clipRecorder.run$, clipRecorder.run$.value);
  // The view below is swapped when an export starts and ends, so the live region cannot live in it: a region only
  // announces text inserted after it exists. This one stays mounted, empty until there is an outcome to say.
  const announcement =
    state.status === "done" && state.path
      ? run
        ? `Clip saved. ${formatClipSeconds(run.durationSeconds)} s, ${run.frameCount} frames.`
        : "Clip saved."
      : state.status === "cancelled"
      ? "Export cancelled."
      : "";
  return (
    <Box sx={{ position: "relative", height: "100%", minHeight: 0 }}>
      <Box role="status" sx={visuallyHidden}>
        {announcement}
      </Box>
      {BUSY_STATUSES.includes(state.status) ? <ExportProgress /> : <ExportSetup state={state} />}
    </Box>
  );
}

function ExportSetup({ state }: { state: ClipRecorderState }) {
  const { gameClock, clipRecorder, clipExportSettingsStore } = useAnalysisApp();
  const { closeExport, openSettings, locked } = useInspector();
  const { range, setRange, durationMs, playbackRate } = useClipExportRange();
  const clipSettings = useObservable(() => clipExportSettingsStore.settings$, clipExportSettingsStore.settings);
  const run = useObservable(() => clipRecorder.run$, clipRecorder.run$.value);
  const speed = useObservable(() => gameClock.speed$, gameClock.speed);
  const { width, fps, audio } = clipSettings;
  const headingId = useId();

  /**
   * The drafts, one per field. The ref is the truth for the handlers (a blur raised from a key handler must see the
   * draft that handler just cleared); the state only draws them.
   */
  const [drafts, setDraftsState] = useState<Drafts>({});
  const draftsRef = useRef<Drafts>({});
  /** True from the moment the folder picker is asked until it answers or fails. */
  const [choosingFolder, setChoosingFolder] = useState(false);
  const choosingFolderRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setDrafts = (next: Drafts) => {
    draftsRef.current = next;
    setDraftsState(next);
  };
  const clearDraft = (name: RangeFieldName) => {
    if (!draftsRef.current[name]) return;
    const { [name]: _dropped, ...rest } = draftsRef.current;
    setDrafts(rest);
  };
  /** The values a field's text is about: Start the start, End the end, Length the start, the end and the rate. */
  const boundsOf = (name: RangeFieldName): readonly number[] =>
    name === "start"
      ? [range.startMs]
      : name === "end"
      ? [range.endMs]
      : [range.startMs, range.endMs, playbackRate];
  /** A draft that still matches the live values; a stale one is never shown and never applied. */
  const liveDraft = (name: RangeFieldName, from: Drafts = draftsRef.current): Draft | undefined => {
    const draft = from[name];
    return draft && sameBounds(draft.bounds, boundsOf(name)) ? draft : undefined;
  };
  const [exportError, setExportError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const format = useMemo(() => {
    try {
      return clipRecorder.getFormat();
    } catch {
      return null;
    }
  }, [clipRecorder]);
  const framePlan = useMemo(() => {
    try {
      return createClipFramePlan(range.startMs, range.endMs, playbackRate, fps);
    } catch {
      return undefined;
    }
  }, [range.startMs, range.endMs, playbackRate, fps]);

  const shownValues: Record<RangeFieldName, string> = {
    start: formatClipTime(range.startMs),
    end: formatClipTime(range.endMs),
    length: formatClipSeconds(clipVideoSeconds(range, playbackRate)),
  };

  // An outside change drops the drafts it makes stale at once; the fields show the live values this render already.
  useLayoutEffect(() => {
    const current = draftsRef.current;
    const fresh: Drafts = {};
    let dropped = false;
    for (const name of ["start", "end", "length"] as const) {
      const draft = liveDraft(name, current);
      if (draft) fresh[name] = draft;
      else if (current[name]) dropped = true;
    }
    if (dropped) setDrafts(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.startMs, range.endMs, playbackRate]);

  /**
   * Applies the typed text when its field is left. Text that does not parse changes nothing, and the field restores.
   * A Start or End that was cleared goes back to the replay's own start or end.
   */
  const leaveField = (name: RangeFieldName) => {
    const typed = liveDraft(name);
    clearDraft(name);
    if (!typed) return;
    let next = range;
    if (name !== "length" && typed.text.trim() === "") {
      next = name === "start" ? withClipStart(range, 0, durationMs) : withClipEnd(range, durationMs, durationMs);
    } else if (name === "length") {
      const seconds = parseSeconds(typed.text);
      if (seconds === undefined) return;
      next = withClipLength(range, seconds, playbackRate, durationMs);
    } else {
      const ms = parseClipTime(typed.text);
      if (ms === undefined) return;
      next = name === "start" ? withClipStart(range, ms, durationMs) : withClipEnd(range, ms, durationMs);
    }
    if (next.startMs !== range.startMs || next.endMs !== range.endMs) setRange(next);
  };
  const keyInField = (name: RangeFieldName, event: KeyboardEvent<HTMLInputElement>) => {
    // Nothing typed here is a playback shortcut.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      // Prevented: the inspector closes Export on an Esc nobody has used.
      event.preventDefault();
      clearDraft(name);
      event.currentTarget.blur();
    }
  };
  /** A pointer press on a button never moves focus, so it has to leave the field being edited itself. */
  const leaveActiveField = () => {
    if (Object.keys(draftsRef.current).length > 0 && document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
  };
  const pressWithoutFocus = (event: React.MouseEvent<HTMLElement>) => {
    leaveActiveField();
    preventPointerFocus(event);
  };

  const exportClip = async () => {
    if (!framePlan || !format || clipRecorder.isBusy) return;
    setExportError(null);
    setOpenError(null);
    const options: ClipExportOptions = {
      startMs: range.startMs,
      endMs: range.endMs,
      width,
      fps,
      audio,
      ...clipAppearanceOptions(clipSettings),
      speed,
      ...(clipSettings.saveFolder ? { saveFolder: clipSettings.saveFolder } : {}),
    };
    try {
      await clipRecorder.exportClip(options);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "Could not export this clip.");
    }
  };
  const chooseSaveFolder = async () => {
    // One picker at a time: a second press (or Enter) while one is open is ignored.
    if (choosingFolderRef.current) return;
    choosingFolderRef.current = true;
    setChoosingFolder(true);
    try {
      const chosen: unknown = await frontendAPI.selectDirectory(clipSettings.saveFolder);
      if (typeof chosen !== "string" || !chosen) return;
      // A late answer is still wanted after the panel has gone: it is a store write, not component state.
      clipExportSettingsStore.changeSettings((settings) => {
        settings.saveFolder = chosen;
      });
    } catch {
      // The picker could not open: the folder stays as it was.
    } finally {
      choosingFolderRef.current = false;
      if (mounted.current) setChoosingFolder(false);
    }
  };
  const openResult = async (reveal: boolean) => {
    if (!state.path) return;
    setOpenError(null);
    try {
      await (reveal ? frontendAPI.showExportedClip(state.path) : frontendAPI.openExportedClip(state.path));
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : "Could not open the exported clip.");
    }
  };

  const saved = state.status === "done" && state.path ? state.path : undefined;
  const cancelled = state.status === "cancelled";
  const failure = exportError ?? (state.status === "error" ? state.error ?? "Could not export this clip." : null);
  const tooManyFrames = !framePlan;
  // While the inspector is locked (the recorder is busy) nothing can be stored or left for Settings, so neither is offered.
  const canExport = Boolean(framePlan && format) && !locked;
  const statusLineSx = { m: 0, fontSize: 12.5, lineHeight: 1.4, textWrap: "pretty" } as const;

  const fieldProps = (name: RangeFieldName) => ({
    name,
    value: liveDraft(name, drafts)?.text ?? shownValues[name],
    onType: (field: RangeFieldName, text: string) =>
      setDrafts({
        ...draftsRef.current,
        [field]: { text: allowedRangeText(field, text), bounds: liveDraft(field)?.bounds ?? boundsOf(field) },
      }),
    onLeave: leaveField,
    onKeyDown: keyInField,
  });

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        height: "100%",
        minHeight: 0,
        containerType: "inline-size",
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
          p: "0 12px 0 20px",
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
          Export clip
        </Box>
        <Box
          component="span"
          sx={{
            fontFamily: REWIND_FONTS.mono,
            fontSize: 11.5,
            whiteSpace: "nowrap",
            color: REWIND_COLORS.textTertiary,
          }}
        >
          Esc
        </Box>
        <ButtonBase
          aria-label="Close export"
          title="Close (Esc)"
          onClick={closeExport}
          onMouseDown={preventPointerFocus}
          sx={{
            flex: "none",
            width: 28,
            height: 28,
            borderRadius: "6px",
            color: REWIND_COLORS.textBright,
            "&:hover": { color: REWIND_COLORS.white, backgroundColor: "rgba(255,255,255,0.08)" },
            "&.Mui-focusVisible": REWIND_FOCUS_RING,
          }}
        >
          <CloseGlyph />
        </ButtonBase>
      </Box>

      <Box
        data-export-body=""
        sx={{
          flex: 1,
          minHeight: 0,
          overflowX: "hidden",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          ...thinScrollbar,
        }}
      >
        <Box
          role="group"
          aria-labelledby={`${headingId}-range`}
          sx={{
            flex: "none",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            p: "9px 20px 8px",
            boxShadow: SECTION_HAIRLINE,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", mb: "2px" }}>
            <Box
              component="span"
              id={`${headingId}-range`}
              sx={{
                fontFamily: REWIND_FONTS.mono,
                fontWeight: 500,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: REWIND_COLORS.textTertiary,
              }}
            >
              Range
            </Box>
            <Box
              component="span"
              sx={{ fontFamily: REWIND_FONTS.mono, fontSize: 11.5, color: REWIND_COLORS.textTertiary }}
            >
              map time
            </Box>
          </Box>
          <Box
            data-range-fields=""
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: "8px",
              // Narrow: Start and End share a row, Length has its own. The DOM, and so the tab order, stays Start, End, Length.
              [NARROW]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))", "& > :last-child": { gridColumn: "1 / -1" } },
            }}
          >
            <RangeField label="Start" {...fieldProps("start")} />
            <RangeField label="End" {...fieldProps("end")} />
            <RangeField label="Length" suffix="s" {...fieldProps("length")} />
          </Box>
        </Box>

        <Box sx={{ flex: "none", p: "8px 20px", display: "flex", alignItems: "center", boxShadow: SECTION_HAIRLINE }}>
          <ButtonBase
            disabled={locked}
            title="Opens Settings → Display with Exported clip selected"
            onClick={() => openSettings({ tab: "display", target: "clip" })}
            onMouseDown={pressWithoutFocus}
            sx={{
              height: 28,
              p: "0 2px",
              gap: "6px",
              fontFamily: REWIND_FONTS.ui,
              fontWeight: 500,
              fontSize: 13,
              color: REWIND_COLORS.accentSoft,
              "&:hover": { color: LINK_HOVER },
              "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
              "&.Mui-focusVisible": REWIND_FOCUS_RING,
            }}
          >
            Clip display settings
            <ChevronGlyph />
          </ButtonBase>
        </Box>

        <SettingsSection label="OUTPUT" variant="toggles" last>
          <ValueRow label="Resolution">
            <Segmented
              label="Resolution"
              width={190}
              value={String(width)}
              options={RESOLUTIONS}
              onChange={(next) =>
                clipExportSettingsStore.changeSettings((settings) => {
                  settings.width = Number(next) as ClipExportWidth;
                })
              }
            />
          </ValueRow>
          <ValueRow label="Frame rate">
            <Segmented
              label="Frame rate"
              width={190}
              value={String(fps)}
              options={FRAME_RATES}
              onChange={(next) =>
                clipExportSettingsStore.changeSettings((settings) => {
                  settings.fps = Number(next) as ClipExportFrameRate;
                })
              }
            />
          </ValueRow>
          <ValueRow label="Speed">
            <SpeedStepper subject="clip" />
          </ValueRow>
          <ValueRow label="Save to">
            <Box sx={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, maxWidth: "100%" }}>
              <Box component="span" sx={{ position: "relative", display: "flex", minWidth: 0, maxWidth: 160 }}>
                <Box
                  component="span"
                  title={clipSettings.saveFolder || undefined}
                  // The short name is for the eye; assistive technology reads the full path below, once.
                  aria-hidden={clipSettings.saveFolder ? true : undefined}
                  sx={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: REWIND_FONTS.ui,
                    fontSize: 13,
                    color: clipSettings.saveFolder ? REWIND_COLORS.textPrimary : REWIND_COLORS.textTertiary,
                  }}
                >
                  {clipSettings.saveFolder ? folderName(clipSettings.saveFolder) : "Videos folder"}
                </Box>
                {clipSettings.saveFolder ? (
                  <Box component="span" sx={visuallyHidden}>
                    {clipSettings.saveFolder}
                  </Box>
                ) : null}
              </Box>
              <FolderButton
                raised
                aria-label="Change save folder"
                disabled={locked || choosingFolder}
                onClick={() => void chooseSaveFolder()}
              >
                Change…
              </FolderButton>
            </Box>
          </ValueRow>
          <TextToggle
            label="Audio"
            checked={audio}
            onChange={(next) =>
              clipExportSettingsStore.changeSettings((settings) => {
                settings.audio = next;
              })
            }
          />
        </SettingsSection>
      </Box>

      <Box
        data-export-footer=""
        sx={{
          flex: "none",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          p: "12px 20px 16px",
          boxShadow: FOOTER_HAIRLINE,
        }}
      >
        {/* Not a live region: the hidden one in `ExportPanel` announces the outcome once. The cancelled note sits after the summary. */}
        {saved || cancelled ? (
          <Box sx={{ order: cancelled ? 1 : 0, display: "flex", flexDirection: "column", gap: "4px" }}>
            {saved ? (
              <>
                <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: "8px", rowGap: "2px" }}>
                  <SavedCheck />
                  <Box component="span" sx={{ fontWeight: 600, fontSize: 15, color: REWIND_COLORS.textPrimary }}>
                    Clip saved
                  </Box>
                  {run ? (
                    <Box
                      component="span"
                      sx={{
                        fontFamily: REWIND_FONTS.mono,
                        fontSize: 12,
                        fontWeight: 400,
                        color: REWIND_COLORS.textTertiary,
                      }}
                    >
                      {`${formatClipSeconds(run.durationSeconds)} s · ${run.frameCount} frames`}
                    </Box>
                  ) : null}
                </Box>
                <Box
                  component="span"
                  sx={{
                    fontFamily: REWIND_FONTS.mono,
                    fontSize: 12,
                    lineHeight: 1.45,
                    color: REWIND_COLORS.textSecondary,
                    overflowWrap: "anywhere",
                  }}
                >
                  {saved}
                </Box>
              </>
            ) : null}
            {cancelled ? (
              <Box component="p" sx={{ ...statusLineSx, color: REWIND_COLORS.textSecondary }}>
                Export cancelled.
              </Box>
            ) : null}
          </Box>
        ) : null}
        {saved ? (
          <>
            <Box sx={{ display: "flex", gap: "8px", [NARROW]: { flexDirection: "column" } }}>
              <SecondaryButton onClick={() => void openResult(false)}>Open clip</SecondaryButton>
              <SecondaryButton onClick={() => void openResult(true)}>Show in folder</SecondaryButton>
            </Box>
            {openError ? (
              <Box component="p" role="alert" sx={{ ...statusLineSx, color: REWIND_COLORS.judgementMiss }}>
                {openError}
              </Box>
            ) : null}
          </>
        ) : null}

        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            fontFamily: REWIND_FONTS.mono,
            fontSize: 12,
            lineHeight: 1.5,
            color: REWIND_COLORS.textTertiary,
          }}
        >
          {!format ? (
            <Box component="span">Video encoding unavailable</Box>
          ) : framePlan ? (
            <Box component="span">
              <Box component="span" sx={{ color: SUMMARY_INK }}>
                {`${formatClipSeconds(framePlan.durationSeconds)} s`}
              </Box>
              {` · ${format.extension.toUpperCase()}`}
            </Box>
          ) : null}
          <Box component="span">{`${resolutionName(width)} · ${fps} FPS`}</Box>
        </Box>

        {tooManyFrames ? (
          <Box component="p" sx={{ ...statusLineSx, color: REWIND_COLORS.judgementMiss }}>
            This range has too many frames. Shorten the clip.
          </Box>
        ) : null}
        {failure ? (
          <Box component="p" role="alert" sx={{ ...statusLineSx, order: 2, color: REWIND_COLORS.judgementMiss }}>
            {failure}
          </Box>
        ) : null}

        <ButtonBase
          disabled={!canExport}
          onClick={() => void exportClip()}
          onMouseDown={pressWithoutFocus}
          sx={{
            order: 2,
            width: "100%",
            height: 44,
            p: "0 18px",
            borderRadius: "10px",
            fontFamily: REWIND_FONTS.ui,
            fontWeight: 600,
            fontSize: 14,
            color: REWIND_COLORS.white,
            backgroundColor: "#1c1d22",
            boxShadow:
              "inset 0 0 0 1px rgba(255,122,160,0.55), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 5px rgba(255,84,104,0.07), 0 10px 30px rgba(255,84,104,0.18)",
            "&:hover": {
              backgroundColor: "#23242a",
              boxShadow:
                "inset 0 0 0 1px rgba(255,150,180,0.8), inset 0 1px 0 rgba(255,255,255,0.1), 0 0 0 6px rgba(255,84,104,0.1), 0 10px 34px rgba(255,84,104,0.26)",
            },
            "&.Mui-disabled": {
              color: REWIND_COLORS.textQuaternary,
              backgroundColor: "#1c1d22",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)",
            },
            "&.Mui-focusVisible": REWIND_FOCUS_RING,
          }}
        >
          Export clip
        </ButtonBase>
      </Box>
    </Box>
  );
}
