import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import type { ReplayComparisonState } from "../../services/common/game/GameSimulator";
import type {
  ComparisonParticipantKind,
  ReplayComparisonParticipantSummary,
} from "../../services/analysis/replay-comparison";
import { AnalysisStatsColors } from "../../utils/constants";

type ReadyReplayComparison = Extract<ReplayComparisonState, { status: "READY" }>;

const PRIMARY_TRACE_COLOR = "#e4e9ef";
const comparisonTraceColor = (kind: ComparisonParticipantKind) =>
  kind === "autoplay-reference" ? "#ffd166" : "#59d9ff";

export interface ReplayComparisonDialogProps {
  open: boolean;
  state: ReadyReplayComparison;
  onClose: () => void;
  onClear: () => void;
}

interface ReplayComparisonValuesProps {
  primaryLabel: string;
  secondaryLabel: string;
  secondaryKind: ComparisonParticipantKind;
  primary: ReplayComparisonParticipantSummary;
  secondary: ReplayComparisonParticipantSummary;
  ruleset: ReplayAnalysisRuleset;
}

function integerValue(value: number | null): string {
  return value === null ? "—" : Math.trunc(value).toLocaleString();
}

function resultValue(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString();
}

function MissSliderBreakLabel({ ruleset }: { ruleset: ReplayAnalysisRuleset }) {
  if (ruleset === "lazer") {
    return (
      <Box component="span" sx={{ color: AnalysisStatsColors.MISS }}>
        Miss
      </Box>
    );
  }

  return (
    <>
      <Box component="span" sx={{ color: AnalysisStatsColors.MISS }}>
        Miss
      </Box>
      <Box component="span" sx={{ color: "text.secondary" }}>
        {" / "}
      </Box>
      <Box component="span" sx={{ color: AnalysisStatsColors.SLIDER_BREAK }}>
        Slider Break
      </Box>
    </>
  );
}

export function ReplayComparisonValues({
  primaryLabel,
  secondaryLabel,
  secondaryKind,
  primary,
  secondary,
  ruleset,
}: ReplayComparisonValuesProps) {
  const missValue = (summary: ReplayComparisonParticipantSummary) =>
    ruleset === "stable"
      ? `${resultValue(summary.counts.countMiss)} / ${resultValue(summary.sliderBreakCount)}`
      : resultValue(summary.counts.countMiss);
  const rows = [
    {
      key: "score",
      label: <Box component="span">Score</Box>,
      primary: integerValue(primary.scoreInput),
      secondary: integerValue(secondary.scoreInput),
    },
    {
      key: "300",
      label: (
        <Box component="span" sx={{ color: AnalysisStatsColors.GREAT }}>
          300
        </Box>
      ),
      primary: resultValue(primary.counts.count300),
      secondary: resultValue(secondary.counts.count300),
    },
    {
      key: "100",
      label: (
        <Box component="span" sx={{ color: AnalysisStatsColors.OK }}>
          100
        </Box>
      ),
      primary: resultValue(primary.counts.count100),
      secondary: resultValue(secondary.counts.count100),
    },
    {
      key: "50",
      label: (
        <Box component="span" sx={{ color: AnalysisStatsColors.MEH }}>
          50
        </Box>
      ),
      primary: resultValue(primary.counts.count50),
      secondary: resultValue(secondary.counts.count50),
    },
    {
      key: "miss-sb",
      label: <MissSliderBreakLabel ruleset={ruleset} />,
      primary: missValue(primary),
      secondary: missValue(secondary),
    },
    {
      key: "max-combo",
      label: <Box component="span">Max Combo</Box>,
      primary: integerValue(primary.maxComboInput),
      secondary: integerValue(secondary.maxComboInput),
    },
  ];

  return (
    <Table size="small" aria-label="Replay score comparison" sx={{ tableLayout: "fixed" }}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: "29%" }} />
          <TableCell align="right" sx={{ width: "35.5%" }}>
            <Typography
              variant="caption"
              noWrap
              title={primaryLabel}
              sx={{ color: PRIMARY_TRACE_COLOR, fontWeight: 700 }}
            >
              {primaryLabel}
            </Typography>
          </TableCell>
          <TableCell align="right" sx={{ width: "35.5%" }}>
            <Typography
              variant="caption"
              noWrap
              title={secondaryLabel}
              sx={{ color: comparisonTraceColor(secondaryKind), fontWeight: 700 }}
            >
              {secondaryLabel}
            </Typography>
          </TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key} data-comparison-metric={row.key}>
            <TableCell component="th" scope="row" sx={{ py: 0.7, fontWeight: 700 }}>
              {row.label}
            </TableCell>
            <TableCell align="right" sx={{ py: 0.7, color: "rgba(255, 255, 255, 0.94)", fontWeight: 650 }}>
              {row.primary}
            </TableCell>
            <TableCell align="right" sx={{ py: 0.7, color: "rgba(255, 255, 255, 0.94)", fontWeight: 650 }}>
              {row.secondary}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ReplayComparisonDialog({ open, state, onClose, onClear }: ReplayComparisonDialogProps) {
  const secondaryColor = comparisonTraceColor(state.secondary.kind);
  const warnings = Array.from(
    new Set([
      ...state.result.compatibility.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.message),
      ...state.result.participantLimitations.primary.map((limitation) => limitation.message),
      ...state.result.participantLimitations.secondary.map((limitation) => limitation.message),
    ]),
  );
  const clear = () => {
    onClear();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="replay-comparison-title">
      <DialogTitle component="div" sx={{ pb: 1 }}>
        <Typography id="replay-comparison-title" component="h2" variant="h6">
          {state.ruleset === "lazer" ? "Lazer" : "Stable"} replay comparison
        </Typography>
        <Stack direction="row" alignItems="center" gap={1.25} mt={0.35}>
          <Stack direction="row" alignItems="center" gap={0.55}>
            <Box sx={{ width: 20, height: 3, borderRadius: 2, backgroundColor: PRIMARY_TRACE_COLOR }} />
            <Typography variant="caption" color="text.secondary">
              Primary
            </Typography>
          </Stack>
          <Stack direction="row" alignItems="center" gap={0.55}>
            <Box sx={{ width: 20, height: 3, borderRadius: 2, backgroundColor: secondaryColor }} />
            <Typography variant="caption" color="text.secondary">
              Comparison
            </Typography>
          </Stack>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ py: 1 }}>
        <ReplayComparisonValues
          primaryLabel={state.primary.label}
          secondaryLabel={state.secondary.label}
          secondaryKind={state.secondary.kind}
          primary={state.result.primarySummary}
          secondary={state.result.secondarySummary}
          ruleset={state.ruleset}
        />
        {state.sourceKind === "replay" && warnings.length > 0 && (
          <Typography variant="caption" component="p" sx={{ mt: 1, mb: 0, color: "text.secondary", lineHeight: 1.35 }}>
            Comparison limits: {warnings.join(" · ")}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={clear}>
          Exit comparison
        </Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
