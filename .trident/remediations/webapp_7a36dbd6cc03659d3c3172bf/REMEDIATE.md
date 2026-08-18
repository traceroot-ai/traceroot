# Trident Surface remediation task
You are pairing with the engineer to remediate a code or web-app
security finding raised by Trident Surface. Read the full report,
patch the root cause in the repo, and stop only after the
proof-of-concept, rescan, or equivalent security test confirms the
issue is closed.
## What you're fixing
Trident found a **HIGH** vulnerability — **Agent Git clone tool injects model-controlled values into `sh -c`** — via an autonomous web-application pentest — Trident cloned the repo into an isolated sandbox and confirmed this with a working proof-of-concept exploit.
- **Class / category:** `Agent Git clone tool injects model-controlled values into `sh -c``
- **Finding id:** `webapp_7a36dbd6cc03659d3c3172bf`
- **Scan run:** `web-eTXP89z6kn`
Your task: fix **this specific vulnerability** in the codebase. The full
report below describes exactly what the issue is, how Trident found and
confirmed it, the affected location, and the recommended fix. Apply a fix
that closes it at the root cause (the report's remediation, or an
equivalent that defeats the same exploit). Don't make unrelated changes.
## Full vulnerability report (what it is · how it was found · how to fix it)
# Agent Git clone tool injects model-controlled values into `sh -c`

**ID:** vuln-0003
**Severity:** HIGH
**Found:** 2026-08-18 22:26:44 UTC
**Target:** traceroot:frontend/packages/agent/src/tools/git-clone.ts
**CWE:** CWE-78

## Description

The default Docker clone fallback interpolates unconstrained repository/ref strings into a shell command after acquiring a GitHub installation token.

## Impact

Injected shell code runs in a network-enabled sandbox while workspace GitHub credentials are present.

## Technical Analysis

**Root cause**
Repository and ref parameters are concatenated into shell syntax instead of passed as structured arguments.

**Validation method**
static shell parsing analysis

**Assessment notes**
- Confidence: **high** — A source trace shows string interpolation into `sh -c`; a non-executing POSIX syntax check accepted a quote-closing injected ref.
- Severity rationale: Injected shell code runs in a network-enabled sandbox while workspace GitHub credentials are present.
- Would change if: Use structured Git arguments or validated values and never put a token in a command string.
- Rule: `command-injection.agent-git-clone`
- Fingerprint: `sha256:4da587abe4c3d18d0ccd99910d28d8e94ff4bcf74b4377e6a42232d7d8e5320d`

## Proof of Concept

Static source-to-sink trace (no exploit was executed against a running target):

The default Docker clone fallback interpolates unconstrained repository/ref strings into a shell command after acquiring a GitHub installation token.

## Code Analysis

**Location 1:** `frontend/packages/agent/src/tools/git-clone.ts` (lines 85-96)
  root_control

**Location 2:** `frontend/packages/agent/src/executors/docker.ts` (lines 48-53)
  sink

**Location 3:** `frontend/packages/agent/src/index.ts` (lines 109-168)
  entrypoint

## Remediation

Validate `owner/repo` and ref values, use argument arrays/environment expansion, and use a non-secret credential channel.
## How to fix it
1. Locate the affected code named in the report (file / route / parameter / sink).
2. Fix the **root cause**, not just the symptom — e.g. parameterize the
   query, enforce authorization server-side, validate/encode the input or
   output, rotate and vault the leaked secret, etc., as the report directs.
3. Grep the codebase for the same pattern and fix every other instance.
4. Keep the change minimal and scoped to this vulnerability.
## How to verify
1. Reproduce the issue with the proof-of-concept / steps in the report and
   confirm it works against the current (unpatched) code.
2. Apply your fix.
3. Re-run the exact same proof-of-concept and confirm the exploit now fails.
4. Run the existing test suite (no regressions) and, where the framework
   allows, add a test that asserts this vulnerability stays closed.
## Acceptance criteria
- The exploit from the report no longer works.
- The fix addresses the root cause and any sibling instances.
- A Surface rescan, supplied proof-of-concept, or equivalent security test confirms the finding stays closed.
- Existing behaviour and tests are unaffected.
- The commit message references the finding id (`webapp_7a36dbd6cc03659d3c3172bf`).
Open the finding in Trident: /project/cmsh6onrj0009w0p05w25mmuc/trident/surface/findings?finding=webapp_7a36dbd6cc03659d3c3172bf
_Generated with Trident (tridentsecurity.io) — review before merging._
## Working rules
- Keep the fix scoped to this vulnerability.
- Do not replace the finding with generic hardening advice; ship the
  concrete code/config change that defeats the reported exploit.
- If this is a leaked secret, rotate the credential and move the value
  into the repo's existing secret manager or environment mechanism.
- Add or update tests where the stack supports it.
- Commit message must reference finding id `webapp_7a36dbd6cc03659d3c3172bf`.
_Generated with Trident Surface · tridentsecurity.io_