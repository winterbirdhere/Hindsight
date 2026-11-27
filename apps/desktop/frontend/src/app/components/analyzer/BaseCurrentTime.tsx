import React, { forwardRef, ForwardRefRenderFunction, useImperativeHandle, useRef } from "react";
import { formatGameTime } from "@osujs/math";
import { Typography } from "@mui/material";
import { REWIND_COLORS } from "../../styles/tokens";

export type GameCurrentTimeProps = Record<string, unknown>;

export interface GameCurrentTimeHandle {
  updateTime: (timeInMs: number) => void;
}

const ForwardCurrentTime: ForwardRefRenderFunction<GameCurrentTimeHandle, GameCurrentTimeProps> = (props, ref) => {
  const refMain = useRef<HTMLSpanElement>(null);
  const refMs = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    updateTime(timeInMs) {
      const [timeHMS, timeMS] = formatGameTime(timeInMs, true).split(".");
      if (refMain.current && refMain.current.textContent !== timeHMS) refMain.current.textContent = timeHMS;
      if (refMs.current && refMs.current.textContent !== "." + timeMS) refMs.current.textContent = "." + timeMS;
    },
  }));
  return (
    <Typography component={"span"} variant="inherit" sx={{ userSelect: "all" }}>
      <span ref={refMain}>0:00</span>

      <Typography
        component={"span"}
        variant="inherit"
        sx={{ color: REWIND_COLORS.textTertiary }}
        ref={refMs}
      >
        .000
      </Typography>
    </Typography>
  );
};

export const BaseCurrentTime = forwardRef(ForwardCurrentTime);
