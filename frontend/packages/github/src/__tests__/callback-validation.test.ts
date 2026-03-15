import { describe, it, expect } from "vitest";
import {
  validateCallbackParams,
  verifyInstallationId,
  type CallbackParams,
} from "../callback-validation.js";

describe("validateCallbackParams", () => {
  describe("missing required parameters", () => {
    it("rejects when code is missing", () => {
      const params: CallbackParams = {
        code: null,
        state: "abc123",
        installationId: null,
        setupAction: null,
        storedState: "abc123",
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing code or state parameter");
    });

    it("rejects when state is missing", () => {
      const params: CallbackParams = {
        code: "somecode",
        state: null,
        installationId: null,
        setupAction: null,
        storedState: "abc123",
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing code or state parameter");
    });
  });

  describe("normal OAuth flow (user initiated from our app)", () => {
    it("accepts when state matches stored state", () => {
      const params: CallbackParams = {
        code: "somecode",
        state: "abc123",
        installationId: null,
        setupAction: null,
        storedState: "abc123",
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(true);
      expect(result.isDirectGitHubInstall).toBe(false);
    });

    it("rejects when state does not match stored state", () => {
      const params: CallbackParams = {
        code: "somecode",
        state: "abc123",
        installationId: null,
        setupAction: null,
        storedState: "different",
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid state parameter");
    });

    it("rejects when no stored state exists (and not direct install)", () => {
      const params: CallbackParams = {
        code: "somecode",
        state: "abc123",
        installationId: null,
        setupAction: null,
        storedState: null,
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid state parameter");
    });
  });

  describe("direct GitHub install flow", () => {
    it("accepts when setup_action=install, has installation_id, and no stored state", () => {
      const params: CallbackParams = {
        code: "somecode",
        state: "github-generated-state",
        installationId: "12345",
        setupAction: "install",
        storedState: null,
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(true);
      expect(result.isDirectGitHubInstall).toBe(true);
    });

    it("rejects when setup_action=install but missing installation_id", () => {
      const params: CallbackParams = {
        code: "somecode",
        state: "github-generated-state",
        installationId: null,
        setupAction: "install",
        storedState: null,
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid state parameter");
      expect(result.isDirectGitHubInstall).toBe(false);
    });

    it("validates state when stored state exists (even with setup_action=install)", () => {
      // If user started our flow but then also got install params,
      // we should still validate the state cookie
      const params: CallbackParams = {
        code: "somecode",
        state: "github-generated-state",
        installationId: "12345",
        setupAction: "install",
        storedState: "our-state",
      };
      const result = validateCallbackParams(params);
      // Should fail because state doesn't match stored state
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid state parameter");
    });

    it("accepts when stored state exists and matches", () => {
      const params: CallbackParams = {
        code: "somecode",
        state: "our-state",
        installationId: "12345",
        setupAction: "install",
        storedState: "our-state",
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(true);
      // Not considered direct install because we had a stored state
      expect(result.isDirectGitHubInstall).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles empty strings as falsy", () => {
      const params: CallbackParams = {
        code: "",
        state: "abc",
        installationId: null,
        setupAction: null,
        storedState: "abc",
      };
      const result = validateCallbackParams(params);
      expect(result.valid).toBe(false);
    });
  });
});

describe("verifyInstallationId", () => {
  const appId = "123456";

  it("returns verified with installationId when user has installation for our app", () => {
    const installations = [
      { id: 999, app_id: 123456 },
      { id: 888, app_id: 111111 },
    ];
    const result = verifyInstallationId(null, installations, appId);
    expect(result.verified).toBe(true);
    expect(result.installationId).toBe("999");
  });

  it("returns verified with undefined when user has no installation", () => {
    const installations = [{ id: 888, app_id: 111111 }];
    const result = verifyInstallationId(null, installations, appId);
    expect(result.verified).toBe(true);
    expect(result.installationId).toBeUndefined();
  });

  it("returns verified when claimed ID matches actual installation", () => {
    const installations = [{ id: 999, app_id: 123456 }];
    const result = verifyInstallationId("999", installations, appId);
    expect(result.verified).toBe(true);
    expect(result.installationId).toBe("999");
  });

  it("rejects when claimed ID does not match actual installation", () => {
    const installations = [{ id: 999, app_id: 123456 }];
    const result = verifyInstallationId("fake-id", installations, appId);
    expect(result.verified).toBe(false);
    expect(result.error).toContain("Installation ID mismatch");
    expect(result.error).toContain("fake-id");
    expect(result.error).toContain("999");
  });

  it("handles string IDs from GitHub API", () => {
    const installations = [{ id: "999", app_id: "123456" }];
    const result = verifyInstallationId("999", installations, appId);
    expect(result.verified).toBe(true);
    expect(result.installationId).toBe("999");
  });

  it("handles empty installations array", () => {
    const result = verifyInstallationId("999", [], appId);
    expect(result.verified).toBe(true);
    expect(result.installationId).toBeUndefined();
  });
});
