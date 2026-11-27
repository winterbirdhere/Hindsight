import { Box, Tooltip } from "@mui/material";
import { useRef, useState } from "react";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import {
  type ErrorCauseBreakdownRow,
  type ErrorCauseCount,
  type ErrorCauseFamily,
  type FullMapErrorCauses as ErrorCauses,
} from "./full-map-error-causes";
import { FullMapHoverCard, fullMapHoverCardSlotProps, type FullMapHoverCardRow } from "./FullMapHoverCard";
import {
  FULL_MAP_HEAD_HEIGHT,
  fullMapPanel,
  fullMapPanelHead,
  fullMapSectionLabel,
  FullMapSegmented,
  inSmallWindow,
} from "./full-map-styles";

/** Name, count, share; the bar runs under all three. */
const COLUMNS = "minmax(0, 1fr) auto 76px";

const FAMILY_ROWS: ReadonlyArray<{ family: ErrorCauseFamily; label: string }> = [
  { family: "aim", label: "Aim" },
  { family: "tapping", label: "Tapping" },
  { family: "notelock", label: "Notelock" },
];

const nameStyle = { fontSize: 13, fontWeight: 600, color: REWIND_COLORS.textPrimary } as const;
const countStyle = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 16,
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
  color: REWIND_COLORS.textPrimary,
} as const;
const shareStyle = {
  fontSize: 12.5,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  color: REWIND_COLORS.textTertiary,
} as const;

type Shown = "all" | "miss";

const SHOWN_OPTIONS: ReadonlyArray<{ value: Shown; label: string }> = [
  { value: "all", label: "All" },
  { value: "miss", label: "Miss" },
];

/** The same row counting only its misses: the bar then has the one kind. */
const missesOf = (count: ErrorCauseCount): ErrorCauseCount => ({ total: count.miss, miss: count.miss, slider: 0 });

const sentenceStyle = { color: REWIND_COLORS.textTertiary, fontSize: 12.5 } as const;

/** A card shows at most this many causes; more are folded into a last row, Other. */
const MAX_CARD_ROWS = 8;

/**
 * The rows of a family's hover card, for the errors counted: the family's causes with their counts, most first. A
 * family with no errors, or with one cause that only repeats the row's own name, has no card.
 */
function breakdownCard(
  name: string,
  breakdown: readonly ErrorCauseBreakdownRow[],
  missesOnly: boolean,
): FullMapHoverCardRow[] | undefined {
  const shown = breakdown
    .map(({ label, count }) => ({ label, shown: missesOnly ? count.miss : count.total }))
    .filter((row) => row.shown > 0)
    .sort((a, b) => b.shown - a.shown || (a.label < b.label ? -1 : 1));
  const familyTotal = shown.reduce((sum, row) => sum + row.shown, 0);
  if (familyTotal === 0) return undefined;
  if (shown.length === 1 && shown[0].label.toLowerCase() === name.toLowerCase()) return undefined;
  const rows =
    shown.length > MAX_CARD_ROWS
      ? [
          ...shown.slice(0, MAX_CARD_ROWS - 1),
          { label: "Other", shown: shown.slice(MAX_CARD_ROWS - 1).reduce((sum, row) => sum + row.shown, 0) },
        ]
      : shown;
  return rows.map((row) => ({ label: row.label, value: String(row.shown), share: row.shown / familyTotal }));
}

/** One kind of error in a bar: as wide as its share of every error counted. */
function Segment({ kind, count, total, color }: { kind: string; count: number; total: number; color: string }) {
  if (count <= 0 || total <= 0) return null;
  return <Box data-kind={kind} sx={{ flex: `0 0 ${(count / total) * 100}%`, backgroundColor: color }} />;
}

/** One line of the list: a name, how many errors, their share of all, and a bar of what kind of errors they are. */
function CauseRow({
  label,
  count,
  total,
  quiet,
  card,
}: {
  label: string;
  count: ErrorCauseCount;
  total: number;
  /** The row of errors with no cause: its name and count are not the page's subject. */
  quiet?: boolean;
  /** The causes behind the count, shown in a hover card; the row can take the keyboard focus only with one. */
  card?: readonly FullMapHoverCardRow[];
}) {
  // The card points at the count, where the eye is, not at the middle of the wide row.
  const countCell = useRef<HTMLElement | null>(null);
  const row = (
    <Box
      component="section"
      aria-label={`${label}: ${count.total}`}
      data-testid="error-cause-row"
      {...(card ? { tabIndex: 0 } : {})}
      sx={{
        display: "grid",
        gridTemplateColumns: COLUMNS,
        alignItems: "baseline",
        rowGap: "7px",
        "&:focus-visible": REWIND_FOCUS_RING,
      }}
    >
      <Box component="span" sx={{ ...nameStyle, ...(quiet && { color: REWIND_COLORS.textTertiary, fontWeight: 500 }) }}>
        {label}
      </Box>
      <Box
        component="span"
        data-testid="error-cause-count"
        ref={countCell}
        sx={{ ...countStyle, ...(quiet && { color: REWIND_COLORS.textTertiary }) }}
      >
        {count.total}
      </Box>
      <Box component="span" sx={shareStyle}>
        {total > 0 ? `${((count.total / total) * 100).toFixed(1)}%` : ""}
      </Box>
      <Box
        data-testid="error-cause-bar"
        aria-hidden="true"
        sx={{
          gridColumn: "1 / -1",
          display: "flex",
          height: 6,
          borderRadius: "3px",
          overflow: "hidden",
          backgroundColor: REWIND_COLORS.inset,
        }}
      >
        {quiet ? (
          <Segment kind="none" count={count.total} total={total} color={REWIND_COLORS.textDim} />
        ) : (
          <>
            <Segment kind="miss" count={count.miss} total={total} color={REWIND_COLORS.judgementMiss} />
            <Segment kind="slider" count={count.slider} total={total} color={REWIND_COLORS.sliderBreak} />
          </>
        )}
      </Box>
    </Box>
  );
  // The whole row is the target; the card sits under the count, as the Miss row's does on the Judgements panel.
  return card ? (
    <Tooltip
      arrow
      describeChild
      placement="bottom"
      slotProps={{ ...fullMapHoverCardSlotProps, popper: { anchorEl: () => countCell.current as HTMLElement } }}
      title={<FullMapHoverCard rows={card} />}
    >
      {row}
    </Tooltip>
  ) : (
    row
  );
}

/**
 * How many of the replay's errors had an Aim, a Tapping or a Notelock cause, read from the error analysis the replay
 * view shows per error. Without that analysis the panel says why instead of showing counts.
 */
export function FullMapErrorCauses({
  causes,
  sourceRulesetLabel,
}: {
  causes: ErrorCauses;
  sourceRulesetLabel: "Stable" | "Lazer";
}) {
  const [shown, setShown] = useState<Shown>("all");
  // The filter changes nothing unless the replay has both kinds of error.
  const rowCounts = causes.status === "ready" ? [...Object.values(causes.families), causes.none] : [];
  const missTotal = rowCounts.reduce((sum, count) => sum + count.miss, 0);
  const canFilter = causes.status === "ready" && missTotal > 0 && rowCounts.some((count) => count.slider > 0);
  const missesOnly = canFilter && shown === "miss";
  const rowCount = (count: ErrorCauseCount) => (missesOnly ? missesOf(count) : count);
  const total = causes.status === "ready" ? (missesOnly ? missTotal : causes.total) : 0;
  return (
    <Box
      component="section"
      aria-label="Error causes"
      sx={{ ...fullMapPanel, gridTemplateRows: "auto minmax(0, 1fr)", ...inSmallWindow({ minHeight: 200 }) }}
    >
      <Box sx={fullMapPanelHead}>
        {/* At the head's top, where the other panels' names are, whatever the filter beside it does to the head. */}
        <Box component="h2" sx={{ ...fullMapSectionLabel, m: 0, alignSelf: "flex-start" }}>
          ERROR CAUSES
        </Box>
        {canFilter ? (
          <FullMapSegmented
            label="Errors shown"
            size="small"
            value={shown}
            options={SHOWN_OPTIONS}
            onChange={setShown}
          />
        ) : null}
        {causes.status === "ready" ? (
          <Box
            component="span"
            sx={{
              ml: "auto",
              fontFamily: REWIND_FONTS.ui,
              fontSize: 12.5,
              // The name's line, not the page's 1.4: a taller line would make the head taller and push the name down.
              lineHeight: `${FULL_MAP_HEAD_HEIGHT}px`,
              fontWeight: 500,
              fontVariantNumeric: "tabular-nums",
              color: REWIND_COLORS.textPrimary,
            }}
          >
            {total} {missesOnly ? (total === 1 ? "miss" : "misses") : total === 1 ? "error" : "errors"}
          </Box>
        ) : null}
      </Box>
      {causes.status === "ready" ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: "clamp(5px, 1.3vh, 16px)", pt: "2px", minHeight: 0 }}>
          {FAMILY_ROWS.map(({ family, label }) => (
            <CauseRow
              key={family}
              label={label}
              count={rowCount(causes.families[family])}
              total={total}
              card={breakdownCard(label, causes.breakdown[family], missesOnly)}
            />
          ))}
          {rowCount(causes.none).total > 0 ? (
            <CauseRow quiet label="No cause found" count={rowCount(causes.none)} total={total} />
          ) : null}
        </Box>
      ) : (
        <Box role="status" sx={sentenceStyle}>
          {causes.status === "analyzing"
            ? "Analyzing errors…"
            : causes.reason === "other-ruleset"
            ? `Causes are available in the ${sourceRulesetLabel} view only.`
            : "Error analysis unavailable."}
        </Box>
      )}
    </Box>
  );
}
