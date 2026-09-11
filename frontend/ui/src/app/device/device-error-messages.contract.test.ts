import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { mapDeviceErrorMessage, isRecoverableDeviceError } from "./device-error-messages";

// Contract test against the INSTALLED better-auth package. The device plugin
// collapses several distinct situations into `invalid_request`, so our mapper
// disambiguates on the human-readable `error_description` strings — which live
// in better-auth, not this repo, and are not part of any stability contract. A
// version bump that rewords them would silently degrade every mapped case to
// the generic fallback; this test makes that drift fail CI loudly instead.
//
// The constants aren't publicly exported (the subpath exports only the plugin
// factory), so resolve the public entry and load its sibling error-codes
// module by file path. A dist-layout change in better-auth fails here loudly —
// acceptable in a test, which is exactly why the runtime mapper sticks to
// substring literals instead of importing this module.
async function loadInstalledErrorCodes(): Promise<Record<string, { message: string }>> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("better-auth/plugins/device-authorization");
  const mod = await import(pathToFileURL(join(dirname(entry), "error-codes.mjs")).href);
  return mod.DEVICE_AUTHORIZATION_ERROR_CODES;
}

describe("device error messages: contract with the installed better-auth strings", () => {
  it("maps the real plugin messages to their specific UI copy (not the generic fallback)", async () => {
    const codes = await loadInstalledErrorCodes();

    expect(
      mapDeviceErrorMessage({
        error: "invalid_request",
        error_description: codes.DEVICE_CODE_ALREADY_PROCESSED.message,
      }),
    ).toBe("This code has already been used.");

    expect(
      mapDeviceErrorMessage({
        error: "invalid_request",
        error_description: codes.DEVICE_CODE_NOT_CLAIMED.message,
      }),
    ).toBe("This code hasn't been verified yet. Go back and re-enter it.");

    expect(
      mapDeviceErrorMessage({
        error: "invalid_request",
        error_description: codes.INVALID_USER_CODE.message,
      }),
    ).toBe("That code doesn't match a pending request. Double-check it and try again.");
  });

  it("classifies recoverability from the real plugin messages", async () => {
    const codes = await loadInstalledErrorCodes();

    // Re-enterable here: a mistyped or not-yet-verified code.
    expect(isRecoverableDeviceError({ error_description: codes.INVALID_USER_CODE.message })).toBe(
      true,
    );
    expect(
      isRecoverableDeviceError({ error_description: codes.DEVICE_CODE_NOT_CLAIMED.message }),
    ).toBe(true);

    // Terminal: needs a fresh code from the CLI, so no "Try again" loop.
    expect(
      isRecoverableDeviceError({ error_description: codes.DEVICE_CODE_ALREADY_PROCESSED.message }),
    ).toBe(false);
    expect(isRecoverableDeviceError({ error_description: codes.EXPIRED_USER_CODE.message })).toBe(
      false,
    );
  });
});
