import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { BaseAudioSettingsPanel } from "./BaseAudioSettingsPanel";

function AudioSettingsHarness() {
  const [muted, setMuted] = useState(true);
  const [master, setMaster] = useState(0.5);
  const props = {
    muted,
    master,
    music: 0.75,
    effects: 1,
    onMutedChange: setMuted,
    onMasterChange: setMaster,
    onMusicChange: () => undefined,
    onEffectsChange: () => undefined,
  };
  return (
    <>
      <BaseAudioSettingsPanel {...props} />
      <output aria-label="Effective master volume">{muted ? 0 : master}</output>
    </>
  );
}

describe("Audio settings recovery and labels", () => {
  it("lets a persisted muted state be unmuted without losing its volume", () => {
    render(<AudioSettingsHarness />);
    const mute = screen.getByRole("checkbox", { name: "Mute audio" }) as HTMLInputElement;
    expect(mute.checked).toBe(true);
    expect(screen.getByLabelText("Effective master volume").textContent).toBe("0");
    fireEvent.click(mute);
    expect(mute.checked).toBe(false);
    expect(screen.getByLabelText("Effective master volume").textContent).toBe("0.5");
  });

  it("exposes distinct volume controls and updates the selected channel", () => {
    render(<AudioSettingsHarness />);
    for (const name of ["Master Volume", "Music Volume", "Effects Volume"]) {
      expect(screen.getByRole("slider", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "Mute audio" }));
    fireEvent.change(screen.getByRole("slider", { name: "Master Volume" }), { target: { value: "70" } });
    expect(screen.getByLabelText("Effective master volume").textContent).toBe("0.7");
    expect((screen.getByRole("slider", { name: "Music Volume" }) as HTMLInputElement).value).toBe("75");
  });
});
