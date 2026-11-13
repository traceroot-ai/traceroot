import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstallationToken } from "../auth";

vi.mock("../jwt", () => ({ generateJWT: () => "jwt" }));

function stubFetch() {
  const fetchMock = vi.fn(
    async (..._args: unknown[]) =>
      new Response(JSON.stringify({ token: "t", expires_at: "2030-01-01T00:00:00Z" }), {
        status: 201,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("getInstallationToken", () => {
  it("sends no body when no scope is given", async () => {
    const fetchMock = stubFetch();
    await getInstallationToken("42", "app", "key");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("sends the repositories and permissions it is given", async () => {
    const fetchMock = stubFetch();
    await getInstallationToken("42", "app", "key", {
      repositories: ["api"],
      permissions: { contents: "read" },
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      repositories: ["api"],
      permissions: { contents: "read" },
    });
  });

  it("surfaces a refusal instead of retrying with a wider scope", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getInstallationToken("42", "app", "key", { permissions: { contents: "read" } }),
    ).rejects.toThrow("422");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
