import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;

/** Serve `handler` on a free port and load the module pointed at it (it reads the URL at load). */
async function serve(handler: http.RequestListener) {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("BACKEND_INTERNAL_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.resetModules();
  return import("../spans-download.js");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("downloadSpansJsonl", () => {
  it("retries once on a new connection when the server closes the socket", async () => {
    let requests = 0;
    const { downloadSpansJsonl } = await serve((req, res) => {
      if (++requests === 1) return req.socket.destroy();
      res.end('{"span":1}\n');
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(downloadSpansJsonl("p1", "t1")).resolves.toBe('{"span":1}\n');
    expect(requests).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not retry an HTTP error status", async () => {
    let requests = 0;
    const { downloadSpansJsonl } = await serve((_req, res) => {
      requests++;
      res.statusCode = 500;
      res.end();
    });

    await expect(downloadSpansJsonl("p1", "t1")).rejects.toThrow("HTTP 500");
    expect(requests).toBe(1);
  });
});
