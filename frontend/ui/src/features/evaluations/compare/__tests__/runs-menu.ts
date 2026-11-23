import { fireEvent, screen, within } from "@testing-library/react";

const RUNS_PANEL = { name: /^(Runs|Add runs)$/ };

/** The toolbar's Runs menu, opened if it isn't. */
export async function openRuns() {
  if (!screen.queryByRole("dialog", RUNS_PANEL)) {
    fireEvent.click(screen.getByRole("button", { name: /^Runs \(\d+\)$/ }));
  }
  return within(await screen.findByRole("dialog", RUNS_PANEL));
}

/** The runs compared, as the Runs menu lists them. */
export async function runsLegend() {
  return (await openRuns()).getByRole("group", { name: "Runs in this comparison" });
}

/** `runsLegend`, for a test that can't wait: the menu opens as it is clicked. */
export function runsLegendNow() {
  const legend = { name: "Runs in this comparison" };
  if (!screen.queryByRole("group", legend)) {
    fireEvent.click(screen.getByRole("button", { name: /^Runs \(\d+\)$/ }));
  }
  return screen.getByRole("group", legend);
}
