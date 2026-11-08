import { spawn } from "node:child_process";
import http from "node:http";

export interface SlowRemote {
  url: string;
  close(): Promise<void>;
}

/**
 * Serve bare repositories over git's smart HTTP protocol, holding every
 * response back for `delayMs`. A clone against it is a real clone that is
 * simply too slow, which is what the clone time limit has to cope with.
 */
export function startSlowRemote(options: {
  root: string;
  delayMs: number;
  port: number;
}): Promise<SlowRemote> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: options.root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-length"]
          ? { CONTENT_LENGTH: String(req.headers["content-length"]) }
          : {}),
        ...(req.headers["content-encoding"]
          ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) }
          : {}),
        ...(req.headers["git-protocol"]
          ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) }
          : {}),
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      const headerText = split === -1 ? "" : output.subarray(0, split).toString("utf8");
      const body = split === -1 ? output : output.subarray(split + 4);
      setTimeout(() => {
        let status = 200;
        for (const line of headerText.split("\r\n")) {
          const [name, ...rest] = line.split(":");
          const value = rest.join(":").trim();
          if (!name) continue;
          if (name.toLowerCase() === "status") status = parseInt(value, 10) || 200;
          else res.setHeader(name, value);
        }
        res.statusCode = status;
        res.end(body);
      }, options.delayMs);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${options.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
