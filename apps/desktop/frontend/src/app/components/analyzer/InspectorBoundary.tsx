import { Box, ButtonBase } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { REWIND_COLORS } from "../../styles/tokens";
import { quietTextButton } from "./incident-format";

interface Props {
  children?: ReactNode;
  /**
   * Whether the inspector is on screen. Put the boundary around the condition that shows the inspector, not
   * inside it: an error thrown while the inspector is being removed (a cleanup) is handed to the nearest ancestor
   * that stays mounted, so a boundary inside the removed part would never see it. While `active` is false the
   * message is never shown, and the error is forgotten when the inspector is shown again.
   */
  active?: boolean;
  /** Placement of the message where the inspector would be (a grid cell, an overlay). */
  frameSx?: SxProps<Theme>;
}

interface State {
  failed: boolean;
  active: boolean;
}

/**
 * A render or effect error in the inspector (column or drawer) must not take the stage and the dock with it: React
 * unmounts the whole tree on an uncaught error, which leaves a black window. It says so in one neutral line and
 * offers to try again. The error itself goes to the console (the app's log file).
 */
export class InspectorBoundary extends Component<Props, State> {
  state: State = { failed: false, active: this.props.active ?? true };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const active = props.active ?? true;
    // Shown again: a fresh start.
    return active !== state.active ? { active, failed: active ? false : state.failed } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("The inspector hit an error.", error, info.componentStack);
  }

  private reload = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed || !(this.props.active ?? true)) return this.props.children;
    return (
      <Box
        role="alert"
        sx={[
          {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            alignContent: "flex-start",
            flexWrap: "wrap",
            gap: "8px",
            p: "14px 18px",
            boxSizing: "border-box",
            backgroundColor: REWIND_COLORS.surface,
            boxShadow: `inset 1px 0 0 ${REWIND_COLORS.hairline}`,
            color: REWIND_COLORS.textSecondary,
            fontSize: 13,
            lineHeight: 1.4,
          },
          ...(Array.isArray(this.props.frameSx) ? this.props.frameSx : this.props.frameSx ? [this.props.frameSx] : []),
        ]}
      >
        <span>The inspector hit an error.</span>
        <ButtonBase onClick={this.reload} sx={{ ...quietTextButton, mr: "-8px" }}>
          Reload inspector
        </ButtonBase>
      </Box>
    );
  }
}
