import { describe, expect, it } from "vitest";
import { mapDeviceErrorMessage } from "./device-error-messages";

describe("mapDeviceErrorMessage", () => {
  it("maps expired_token", () => {
    expect(
      mapDeviceErrorMessage({ error: "expired_token", error_description: "User code has expired" }),
    ).toBe("This code has expired. Go back to your terminal and run the login command again.");
  });

  it("maps access_denied", () => {
    expect(
      mapDeviceErrorMessage({
        error: "access_denied",
        error_description: "You are not authorized",
      }),
    ).toBe(
      "This code isn't associated with your account, so it can't be approved or denied from here.",
    );
  });

  it("maps unauthorized", () => {
    expect(
      mapDeviceErrorMessage({
        error: "unauthorized",
        error_description: "Authentication required",
      }),
    ).toBe("You need to sign in again before continuing.");
  });

  it("maps an already-processed invalid_request by description", () => {
    expect(
      mapDeviceErrorMessage({
        error: "invalid_request",
        error_description: "Device code already processed",
      }),
    ).toBe("This code has already been used.");
  });

  it("maps a not-yet-claimed invalid_request by description", () => {
    expect(
      mapDeviceErrorMessage({
        error: "invalid_request",
        error_description: "Device code has not been claimed by a verifying session",
      }),
    ).toBe("This code hasn't been verified yet. Go back and re-enter it.");
  });

  it("maps an unknown-code invalid_request by description", () => {
    expect(
      mapDeviceErrorMessage({ error: "invalid_request", error_description: "Invalid user code" }),
    ).toBe("That code doesn't match a pending request. Double-check it and try again.");
  });

  it("falls back to the raw description for an unrecognized error", () => {
    expect(
      mapDeviceErrorMessage({ error: "some_new_error", error_description: "Something odd" }),
    ).toBe("Something odd");
  });

  it("falls back to a generic message when there is no description", () => {
    expect(mapDeviceErrorMessage({ error: "some_new_error" })).toBe(
      "Something went wrong. Please try again.",
    );
    expect(mapDeviceErrorMessage(null)).toBe("Something went wrong. Please try again.");
    expect(mapDeviceErrorMessage(undefined)).toBe("Something went wrong. Please try again.");
  });
});
