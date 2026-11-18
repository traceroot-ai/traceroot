/**
 * A stand-in for the public API that answers the 24 exposed routes from
 * fixtures/*.json. FIXTURES, NOT THE REAL BACKEND: it gives the parity harness
 * a fast loop and never counts as the live result. It checks the bearer the way
 * the real API does: a key that does not start with `tr-` is a 400 (it takes
 * the user-credential path and asks for a project_id), a wrong `tr-` key is 401.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

const traces = fixture("traces");
const sessions = fixture("sessions");
const findings = fixture("findings");
const detectors = fixture("detectors");
const alerts = fixture("alerts");
const dashboards = fixture("dashboards");
const datasets = fixture("datasets");
const sql = fixture("sql");

const P = "/api/v1/public";
let queries = 0;

/** Exact-path routes, then `{param}` routes; each answers with a fixture. */
const routes: [string, string, (body: unknown) => unknown][] = [
  ["GET", `${P}/traces`, () => traces.list],
  ["GET", `${P}/traces/:id`, () => traces.detail],
  ["GET", `${P}/sessions`, () => sessions.list],
  ["GET", `${P}/sessions/:id`, () => sessions.detail],
  ["GET", `${P}/detectors/findings`, () => findings.list],
  ["GET", `${P}/detectors/findings/:id`, () => findings.detail],
  ["GET", `${P}/detectors/traces/:id/finding`, () => findings.detail],
  ["GET", `${P}/detectors`, () => detectors.list],
  ["GET", `${P}/detectors/:id`, () => detectors.detail],
  ["GET", `${P}/alerts`, () => alerts.list],
  ["GET", `${P}/alerts/:id`, () => alerts.detail],
  ["GET", `${P}/dashboards`, () => dashboards.list],
  ["GET", `${P}/dashboards/:id`, () => dashboards.detail],
  ["GET", `${P}/dashboards/:id/data`, () => dashboards.data],
  ["POST", `${P}/widgets/query`, () => dashboards.query],
  ["GET", `${P}/widgets/:id`, () => dashboards.widget],
  ["GET", `${P}/widgets/:id/data`, () => dashboards.widgetData],
  ["GET", `${P}/evaluation-runs/:id`, () => fixture("evaluation-run")],
  ["GET", `${P}/datasets`, () => datasets.list],
  ["GET", `${P}/datasets/:id`, () => datasets.detail],
  ["GET", `${P}/datasets/:id/versions`, () => datasets.versions],
  ["GET", `${P}/dataset-versions/:id`, () => datasets.version],
  ["GET", `${P}/sql/schema`, () => sql.schema],
  // elapsed_ms changes on every call, as a real query's does.
  ["POST", `${P}/sql`, () => ({ ...(sql.result as object), elapsed_ms: 10 + ++queries })],
];

function match(method: string, path: string) {
  for (const [m, pattern, answer] of routes) {
    if (m !== method) continue;
    const want = pattern.split("/");
    const got = path.split("/");
    if (
      want.length === got.length &&
      want.every((part, i) => part.startsWith(":") || part === got[i])
    ) {
      return answer;
    }
  }
  return undefined;
}

export function startMockRest(apiKey: string, port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (bearer === undefined) return send(401, { detail: "Missing credentials" });
      if (!bearer.startsWith("tr-")) {
        return send(400, { detail: "project_id query parameter is required for user credentials" });
      }
      if (bearer !== apiKey) return send(401, { detail: "Invalid API key" });
      const answer = match(req.method ?? "GET", new URL(req.url ?? "/", "http://mock").pathname);
      if (answer === undefined) return send(404, { detail: "Not found" });
      const text = Buffer.concat(chunks).toString("utf8");
      send(200, answer(text === "" ? undefined : JSON.parse(text)));
    });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    }),
  );
}
