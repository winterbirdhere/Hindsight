import { fireEvent, render, screen } from "@testing-library/react";
import { useGameClockControls } from "../../hooks/game-clock";
import { ALLOWED_SPEEDS } from "../../utils/constants";
import { SpeedStepper } from "./SpeedStepper";

jest.mock("../../hooks/game-clock", () => ({ useGameClockControls: jest.fn() }));

function setup(speed: number) {
  const setSpeed = jest.fn();
  (useGameClockControls as jest.Mock).mockReturnValue({ speed, setSpeed, baseRate: 1 });
  render(<SpeedStepper />);
  return setSpeed;
}

it("steps through the allowed speeds", () => {
  const index = ALLOWED_SPEEDS.indexOf(1);
  const setSpeed = setup(1);
  fireEvent.click(screen.getByRole("button", { name: "Increase viewer speed" }));
  expect(setSpeed).toHaveBeenLastCalledWith(ALLOWED_SPEEDS[index + 1]);
  fireEvent.click(screen.getByRole("button", { name: "Decrease viewer speed" }));
  expect(setSpeed).toHaveBeenLastCalledWith(ALLOWED_SPEEDS[index - 1]);
});

it("disables stepping past the ends and offers the full list", () => {
  const setSpeed = setup(ALLOWED_SPEEDS[ALLOWED_SPEEDS.length - 1]);
  expect((screen.getByRole("button", { name: "Increase viewer speed" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Viewer playback speed/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: `${ALLOWED_SPEEDS[0].toFixed(2)}×` }));
  expect(setSpeed).toHaveBeenLastCalledWith(ALLOWED_SPEEDS[0]);
});
