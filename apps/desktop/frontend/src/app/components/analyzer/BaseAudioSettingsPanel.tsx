import { Box, FormControlLabel, Slider, Stack, Switch, Tooltip, Typography } from "@mui/material";
import { VolumeDown, VolumeUp } from "@mui/icons-material";
import { useId } from "react";

type Change = (x: number) => void;

interface BaseAudioSettingsPanelProps {
  muted: boolean;
  master: number;
  effects: number;
  music: number;

  onMasterChange: Change;
  onEffectsChange: Change;
  onMusicChange: Change;
  onMutedChange: (muted: boolean) => unknown;
}

export function VolumeSlider({
  disabled,
  onChange,
  value,
  labelledBy,
}: {
  disabled?: boolean;
  onChange: Change;
  value: number;
  labelledBy: string;
}) {
  return (
    <Stack gap={2} direction={"row"}>
      <VolumeDown />
      <Slider
        aria-labelledby={labelledBy}
        size="small"
        valueLabelDisplay="auto"
        disabled={disabled}
        value={Math.floor(value * 100)}
        step={1}
        onChange={(_, x) => onChange((x as number) / 100)}
      />
      <VolumeUp />
    </Stack>
  );
}

export function BaseAudioSettingsPanel(props: BaseAudioSettingsPanelProps) {
  const { muted, master, effects, music, onMasterChange, onEffectsChange, onMusicChange, onMutedChange } = props;
  const labelId = useId();
  return (
    <Stack
      sx={{
        p: 2,
      }}
      gap={1}
    >
      <FormControlLabel
        label="Mute audio"
        control={<Switch checked={muted} onChange={(_, checked) => onMutedChange(checked)} />}
      />
      <Box>
        <Typography id={`${labelId}-master`} gutterBottom>
          Master Volume
        </Typography>
        <VolumeSlider labelledBy={`${labelId}-master`} onChange={onMasterChange} value={master} />
      </Box>

      <Box>
        <Typography id={`${labelId}-music`} gutterBottom>
          Music Volume
        </Typography>
        <VolumeSlider labelledBy={`${labelId}-music`} onChange={onMusicChange} value={music} />
      </Box>
      <Box>
        <Typography id={`${labelId}-effects`} gutterBottom>
          Effects Volume
        </Typography>
        <Tooltip title={"Replay hitsound volume"}>
          <span>
            <VolumeSlider labelledBy={`${labelId}-effects`} onChange={onEffectsChange} value={effects} />
          </span>
        </Tooltip>
      </Box>
    </Stack>
  );
}
