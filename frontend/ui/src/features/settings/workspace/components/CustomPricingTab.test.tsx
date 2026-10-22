// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CustomModelPrice } from "@/lib/api";

const samplePrice: CustomModelPrice = {
  id: "price-1",
  workspaceId: "w1",
  modelName: "meta-llama/Llama-3.3-70B-Instruct",
  matchPattern: "^meta-llama/.*",
  inputPrice: 0.8,
  outputPrice: 2.4,
  cacheReadPrice: 0.2,
  cacheWritePrice: 1.0,
  createdBy: "user-1",
  createTime: "2026-10-22T00:00:00.000Z",
  updateTime: "2026-10-22T00:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  getCustomModelPrices: vi.fn(),
  createCustomModelPrice: vi.fn(),
  updateCustomModelPrice: vi.fn(),
  deleteCustomModelPrice: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getCustomModelPrices: (workspaceId: string) => mocks.getCustomModelPrices(workspaceId),
  createCustomModelPrice: (workspaceId: string, data: any) =>
    mocks.createCustomModelPrice(workspaceId, data),
  updateCustomModelPrice: (workspaceId: string, priceId: string, data: any) =>
    mocks.updateCustomModelPrice(workspaceId, priceId, data),
  deleteCustomModelPrice: (workspaceId: string, priceId: string) =>
    mocks.deleteCustomModelPrice(workspaceId, priceId),
}));

import { CustomPricingTab } from "./CustomPricingTab";

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={qc}>
      <CustomPricingTab workspaceId="w1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getCustomModelPrices.mockResolvedValue({ prices: [] });
});

afterEach(() => {
  cleanup();
  mocks.getCustomModelPrices.mockReset();
  mocks.createCustomModelPrice.mockReset();
  mocks.updateCustomModelPrice.mockReset();
  mocks.deleteCustomModelPrice.mockReset();
});

describe("CustomPricingTab", () => {
  it("renders empty state when there are no prices", async () => {
    mocks.getCustomModelPrices.mockResolvedValue({ prices: [] });
    renderTab();

    expect(await screen.findByText(/no custom model prices configured/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /add custom price/i })).toBeTruthy();
  });

  it("renders list of configured custom model prices", async () => {
    mocks.getCustomModelPrices.mockResolvedValue({ prices: [samplePrice] });
    renderTab();

    expect(await screen.findByText("meta-llama/Llama-3.3-70B-Instruct")).toBeTruthy();
    expect(screen.getByText("^meta-llama/.*")).toBeTruthy();
    expect(screen.getByText("$0.8000 / 1M")).toBeTruthy();
    expect(screen.getByText("$2.4000 / 1M")).toBeTruthy();
    expect(screen.getByText("$0.2000 / 1M")).toBeTruthy();
    expect(screen.getByText("$1.0000 / 1M")).toBeTruthy();
  });

  it("validates inputs and creates a new custom model price", async () => {
    mocks.getCustomModelPrices.mockResolvedValue({ prices: [] });
    mocks.createCustomModelPrice.mockResolvedValue({ price: samplePrice });
    renderTab();

    const addBtn = await screen.findByRole("button", { name: /add custom price/i });
    fireEvent.click(addBtn);

    expect(await screen.findByText("Add Custom Model Price")).toBeTruthy();

    // Click save without inputs -> error
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Model name is required")).toBeTruthy();

    // Fill model name
    fireEvent.change(screen.getByPlaceholderText("e.g. meta-llama/Llama-3.3-70B-Instruct"), {
      target: { value: "mistral-large" },
    });

    // Save with missing input price -> error
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/input price must be a valid number/i)).toBeTruthy();

    // Fill prices
    fireEvent.change(screen.getByPlaceholderText("0.80"), { target: { value: "2.0" } });
    fireEvent.change(screen.getByPlaceholderText("2.40"), { target: { value: "6.0" } });

    // Save with invalid regex
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \^meta-llama/i), {
      target: { value: "[invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/match pattern must be a valid regular expression/i)).toBeTruthy();

    // Fix regex and save
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \^meta-llama/i), {
      target: { value: "^mistral-.*" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mocks.createCustomModelPrice).toHaveBeenCalledWith("w1", {
        modelName: "mistral-large",
        matchPattern: "^mistral-.*",
        inputPrice: 2.0,
        outputPrice: 6.0,
        cacheReadPrice: undefined,
        cacheWritePrice: undefined,
      });
    });
  });

  it("edits an existing price", async () => {
    mocks.getCustomModelPrices.mockResolvedValue({ prices: [samplePrice] });
    mocks.updateCustomModelPrice.mockResolvedValue({
      price: { ...samplePrice, inputPrice: 1.2 },
    });
    renderTab();

    expect(await screen.findByText("meta-llama/Llama-3.3-70B-Instruct")).toBeTruthy();

    // Click Edit button
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(await screen.findByText("Edit Model Price")).toBeTruthy();

    // Change input price
    const inputPriceField = screen.getByDisplayValue("0.8");
    fireEvent.change(inputPriceField, { target: { value: "1.2" } });

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(mocks.updateCustomModelPrice).toHaveBeenCalledWith("w1", "price-1", {
        modelName: "meta-llama/Llama-3.3-70B-Instruct",
        matchPattern: "^meta-llama/.*",
        inputPrice: 1.2,
        outputPrice: 2.4,
        cacheReadPrice: 0.2,
        cacheWritePrice: 1.0,
      });
    });
  });

  it("deletes a custom price via confirmation dialog", async () => {
    mocks.getCustomModelPrices.mockResolvedValue({ prices: [samplePrice] });
    mocks.deleteCustomModelPrice.mockResolvedValue({ success: true });
    renderTab();

    expect(await screen.findByText("meta-llama/Llama-3.3-70B-Instruct")).toBeTruthy();

    // Click delete icon button
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(await screen.findByText("Delete Model Price")).toBeTruthy();

    // Confirm deletion
    const dialog = screen.getByRole("dialog");
    const deleteConfirmBtn = within(dialog).getByRole("button", { name: "Delete" });
    fireEvent.click(deleteConfirmBtn);

    await waitFor(() => {
      expect(mocks.deleteCustomModelPrice).toHaveBeenCalledWith("w1", "price-1");
    });
  });
});
