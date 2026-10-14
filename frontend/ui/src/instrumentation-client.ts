import { z } from "zod";

// Next.js runs this file before any app code in the browser. zod probes for
// eval support (Function("")) the first time it builds an object schema, and
// under the page's Content-Security-Policy (no 'unsafe-eval') that probe is a
// reported violation on every page load. jitless skips the probe; zod then
// parses without generated code, which it would fall back to anyway.
z.config({ jitless: true });
