import { Box } from "@mui/material";
import { RewindLogo } from "../../components/logo/RewindLogo";
import { startupCaption, STARTUP_STEPS, StartupProgress } from "../../services/startup/startup-steps";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

/** Card 7a. The bar shows completed startup steps, never a timer. */
export function SplashScreen({ progress }: { progress: StartupProgress }) {
  const { label, counter, fraction } = startupCaption(progress);
  return (
    <Box
      sx={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        placeItems: "center",
        background: "radial-gradient(circle at 50% 42%, #17181d, #0b0b0d 60%)",
        color: REWIND_COLORS.textPrimary,
        fontFamily: REWIND_FONTS.ui,
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "34px", marginTop: "-24px" }}>
        <RewindLogo variant="animated" size={220} />
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px" }}>
          <Box
            component="span"
            sx={{ font: `600 34px/1 ${REWIND_FONTS.ui}`, letterSpacing: "-0.04em", color: REWIND_COLORS.textPrimary }}
          >
            Hindsight
          </Box>
          <Box sx={{ width: 240 }}>
            <Box
              role="progressbar"
              aria-label="Starting Hindsight"
              aria-valuemin={0}
              aria-valuemax={STARTUP_STEPS.length}
              aria-valuenow={Math.min(progress.stepIndex, STARTUP_STEPS.length)}
              sx={{ height: 2, borderRadius: "1px", overflow: "hidden", background: "rgba(255,255,255,0.12)" }}
            >
              <Box
                sx={{
                  height: 2,
                  width: `${fraction * 100}%`,
                  background: REWIND_COLORS.textPrimary,
                  transition: "width 300ms ease-out",
                  "@media (prefers-reduced-motion: reduce)": { transition: "none" },
                }}
              />
            </Box>
            <Box
              sx={{
                marginTop: "12px",
                display: "flex",
                justifyContent: "space-between",
                font: `12px ${REWIND_FONTS.mono}`,
                color: REWIND_COLORS.textSecondary,
              }}
            >
              <span>{label}</span>
              <Box component="span" sx={{ color: REWIND_COLORS.textDim }}>
                {counter}
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
