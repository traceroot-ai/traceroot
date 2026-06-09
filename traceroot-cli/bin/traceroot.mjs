#!/usr/bin/env node
// Thin ESM entry-point — delegates to compiled TypeScript output.
// Node >= 20 required (native fetch, structuredClone, etc.)
import "../dist/cli.js";
