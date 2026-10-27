import { render, screen } from "@testing-library/react";
import { HomeScreen } from "./HomeScreen";

jest.mock("../../hooks/app-info", () => ({ useAppInfo: () => ({ appVersion: "0.2.2" }) }));
jest.mock("@mui/icons-material", () => ({ FastRewind: () => <svg aria-hidden="true" /> }));

it("identifies Hindsight without linking players to the original project's profile or communities", () => {
  const { container } = render(<HomeScreen />);
  expect(screen.getByText("Hindsight 0.2.2")).toBeTruthy();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(container.textContent).not.toMatch(/abstrakt|osu! University|Discord/i);
});
