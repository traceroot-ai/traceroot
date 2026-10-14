import { expect, it, vi } from "vitest";

vi.mock("@/env", () => ({ env: {} }));

import { findPostHogPerson } from "./posthog-person";

vi.useFakeTimers();
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const env = { POSTHOG_PERSONAL_API_KEY: "phx_test", POSTHOG_PROJECT_ID: "123" };
const sleep = async (ms: number) => void vi.advanceTimersByTime(ms);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const personUrl = "https://us.posthog.com/project/123/person/user%2F1";
const properties = {
  $geoip_city_name: "SF",
  $geoip_country_code: "US",
  $browser: "  ",
  $device_type: "Desktop",
  $initial_referring_domain: "$direct",
  $initial_pathname: "/p",
};
const found = { results: [{ properties }] };
const facts = { city: "SF", country: "US", deviceType: "Desktop", landingPath: "/p", personUrl };

it("returns null without fetching when the API key or project id is missing", async () => {
  const fetchImpl = vi.fn();
  await expect(findPostHogPerson("u", { fetchImpl, env: {} })).resolves.toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("polls until the person appears and maps the facts, dropping blanks and $direct", async () => {
  let polls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => json(polls++ ? found : { results: [] }));
  await expect(findPostHogPerson("user/1", { fetchImpl, env, sleep })).resolves.toEqual(facts);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://us.posthog.com/api/projects/123/persons/?distinct_id=user%2F1&limit=1",
    expect.objectContaining({ headers: { Authorization: "Bearer phx_test" } }),
  );
});

it("keeps polling past failed answers, warning once, and returns null at the deadline", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json({ detail: "no" }, 500));
  await expect(findPostHogPerson("user/1", { fetchImpl, env, sleep })).resolves.toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(7);
  expect(warn).toHaveBeenCalledTimes(1);
});
