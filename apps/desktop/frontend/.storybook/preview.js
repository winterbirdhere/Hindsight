import React from "react";

import { addDecorator } from "@storybook/react";

import { rewindTheme } from "../src/app/styles/theme";
import { CssBaseline, ThemeProvider } from "@mui/material";

const defaultTheme = rewindTheme;

export const parameters = {
  actions: { argTypesRegex: "^on[A-Z].*" },
  controls: {
    matchers: {
      color: /(background|color)$/i,
      date: /Date$/,
    },
  },
};

const withThemeProvider = (Story, context) => {
  return (
    <ThemeProvider theme={defaultTheme}>
      <CssBaseline />
      <Story {...context} />
    </ThemeProvider>
  );
};

addDecorator(withThemeProvider);
