// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CandidateIdentity } from "./candidate-identity";
import type { RunProvenance } from "../types";

afterEach(() => cleanup());

function prov(p: Partial<RunProvenance> = {}): RunProvenance {
  return {
    git_repository: null,
    git_ref: null,
    git_commit: null,
    git_dirty: null,
    ci_provider: null,
    ci_build_id: null,
    sdk_language: null,
    sdk_version: null,
    declared_model: null,
    declared_prompt_version: null,
    ...p,
  };
}

describe("CandidateIdentity", () => {
  it("renders nothing when there is no provenance (honest absence)", () => {
    const { container } = render(<CandidateIdentity provenance={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when provenance is present but wholly empty", () => {
    const { container } = render(<CandidateIdentity provenance={prov()} />);
    expect(container.firstChild).toBeNull();
  });

  it("labels the model as DECLARED, never a bare 'model' (no over-claiming the observed model)", () => {
    render(<CandidateIdentity provenance={prov({ declared_model: "claude-opus-4" })} />);
    expect(screen.getByText("Declared model")).toBeDefined();
    expect(screen.getByText("claude-opus-4")).toBeDefined();
  });

  it("shows a shortened commit and flags uncommitted changes", () => {
    render(
      <CandidateIdentity
        provenance={prov({
          git_repository: "https://github.com/acme/agent",
          git_commit: "4a91c02deadbeef",
          git_dirty: true,
        })}
      />,
    );
    // Commit is truncated to 7 chars; the repo scheme is stripped.
    expect(screen.getByText(/github\.com\/acme\/agent@4a91c02/)).toBeDefined();
    expect(screen.getByText(/uncommitted changes/i)).toBeDefined();
  });

  it("surfaces CI and SDK identity when present", () => {
    render(
      <CandidateIdentity
        provenance={prov({
          ci_provider: "github-actions",
          ci_build_id: "1234",
          sdk_language: "python",
          sdk_version: "0.4.1",
        })}
      />,
    );
    expect(screen.getByText("github-actions #1234")).toBeDefined();
    expect(screen.getByText("python 0.4.1")).toBeDefined();
  });
});
