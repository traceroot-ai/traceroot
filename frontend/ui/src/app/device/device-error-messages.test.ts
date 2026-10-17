import { describe, expect, it } from "vitest";
import { mapDeviceErrorMessage, isRecoverableDeviceError } from "./device-error-messages";

describe("mapDeviceErrorMessage", () => {
  it("maps expired_token", () => {
    expect(
      mapDeviceErrorMessage({ error: "expired_token", error_description: "User code has expired" }),
    ).toBe("This code has expired. Go back to your terminal and run the login command again.");
  });

  it("maps access_denied to the locked-to-another-account message", () => {
    expect(
      mapDeviceErrorMessage({
        error: "access_denied",
        error_description: "You are not authorized",
      }),
    ).toBe(
      "This code was already opened by a different account and is locked to it. Go back to your terminal and run the login command again to get a fresh code.",
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
    const generic =
      "Something went wrong. Go back to your terminal and run the login command again.";
    expect(mapDeviceErrorMessage({ error: "some_new_error" })).toBe(generic);
    expect(mapDeviceErrorMessage(null)).toBe(generic);
    expect(mapDeviceErrorMessage(undefined)).toBe(generic);
  });
});

describe("isRecoverableDeviceError", () => {
  it("treats a mistyped code as recoverable (re-entering can work)", () => {
    expect(
      isRecoverableDeviceError({
        error: "invalid_request",
        error_description: "Invalid user code",
      }),
    ).toBe(true);
  });

  it("treats a not-yet-claimed code as recoverable", () => {
    expect(
      isRecoverableDeviceError({
        error: "invalid_request",
        error_description: "Device code has not been claimed by a verifying session",
      }),
    ).toBe(true);
  });

  it("treats a code locked to another account as terminal (needs a fresh code)", () => {
    expect(
      isRecoverableDeviceError({
        error: "access_denied",
        error_description: "You are not authorized",
      }),
    ).toBe(false);
  });

  it("treats expired and already-used codes as terminal", () => {
    expect(
      isRecoverableDeviceError({
        error: "expired_token",
        error_description: "User code has expired",
      }),
    ).toBe(false);
    expect(
      isRecoverableDeviceError({
        error: "invalid_request",
        error_description: "Device code already processed",
      }),
    ).toBe(false);
  });

  it("treats a missing error as terminal", () => {
    expect(isRecoverableDeviceError(null)).toBe(false);
    expect(isRecoverableDeviceError(undefined)).toBe(false);
  });
});
