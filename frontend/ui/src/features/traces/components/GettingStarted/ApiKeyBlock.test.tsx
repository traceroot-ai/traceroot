// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImpersonationError } from "@/lib/api/errors";
import { createAccessKey } from "@/lib/api";
import { ApiKeyBlock } from "./ApiKeyBlock";

vi.mock("@/lib/api", () => ({ createAccessKey: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it.each([
  [new Error("Forbidden"), "Failed to generate key. Please try again."],
  [
    new ImpersonationError("API keys cannot be managed while impersonating."),
    "API keys cannot be managed while impersonating.",
  ],
])("renders the appropriate generate error", async (error, message) => {
  vi.mocked(createAccessKey).mockRejectedValue(error);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ApiKeyBlock projectId="p" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(await screen.findByText(message)).toBeTruthy();
});
