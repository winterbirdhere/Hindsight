import { Meta, Story } from "@storybook/react";
import type { ScrollStep } from "../../services/common/playback-steps";
import { HelpBox } from "./HelpModal";

export default {
  component: HelpBox,
  title: "HelpModal",
  argTypes: {
    onClose: { action: "onClose executed!" },
  },
} as Meta;

// The keyboard shortcuts dialog alone, without the app around it; the wheel's row follows the Scroll step.
const Template: Story<{ scrollStep?: ScrollStep }> = ({ scrollStep }) => <HelpBox onClose={() => undefined} scrollStep={scrollStep} />;

export const Primary = Template.bind({});

export const FixedScrollStep = Template.bind({});
FixedScrollStep.args = { scrollStep: "1/4" };
