import { Command } from "commander";
import { createRequire } from "module";
import { registerLogin } from "./commands/login.js";
import { registerStatus } from "./commands/status.js";
import { registerTraces } from "./commands/traces.js";
import { fatal } from "./output.js";

// Read version from package.json without top-level await or JSON import assertions.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("traceroot")
  .description("TraceRoot CLI — inspect traces, spans, and service health")
  .version(version, "-V, --version", "Print version and exit")
  .helpOption("-h, --help", "Display help for command");

registerLogin(program);
registerStatus(program);
registerTraces(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  fatal(err instanceof Error ? err.message : String(err));
});
