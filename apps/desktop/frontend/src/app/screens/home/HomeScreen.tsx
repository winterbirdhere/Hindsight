import React from "react";
import { Stack, Typography } from "@mui/material";
import { FastRewind } from "@mui/icons-material";
import { useAppInfo } from "../../hooks/app-info";

// This page is actually just a placeholder for an overview page that can show things such as "Recently Played", etc.

export function HomeScreen() {
  const { appVersion } = useAppInfo();
  return (
    <Stack gap={4} sx={{ justifyContent: "center", alignItems: "center", margin: "auto", height: "100%" }}>
      <Stack alignItems={"center"}>
        <FastRewind sx={{ height: "2em", width: "2em" }} />
        <Typography fontSize={"1em"} sx={{ userSelect: "none", marginBottom: 2 }}>
          HINDSIGHT
        </Typography>
        <Typography fontSize={"caption.fontSize"} color={"text.secondary"}>
          Hindsight {appVersion}
        </Typography>
      </Stack>
    </Stack>
  );
}
