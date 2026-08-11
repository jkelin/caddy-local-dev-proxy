import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  loadCaddyConfig,
  readCaddyConfig,
  type CaddyConfig,
} from "./index.ts";

let activeConfig: unknown = {};
let lastContentType: string | null = null;

const adminServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // The fake implements only the Caddy API surface consumed by this package;
  // unknown paths fail loudly so endpoint regressions cannot pass accidentally.
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/config/" && request.method === "GET") {
      return new Response(JSON.stringify(activeConfig), {
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/load" && request.method === "POST") {
      lastContentType = request.headers.get("content-type");
      activeConfig = await request.json();
      return new Response();
    }
    if (path === "/failure/config/" && request.method === "GET") {
      return new Response("admin unavailable", { status: 503 });
    }
    if (path === "/failure/load" && request.method === "POST") {
      return new Response("configuration rejected", { status: 400 });
    }

    return new Response("not found", { status: 404 });
  },
});

const adminUrl = `http://127.0.0.1:${adminServer.port}`;

afterAll(() => {
  adminServer.stop(true);
});

beforeEach(() => {
  activeConfig = {};
  lastContentType = null;
});

describe("Caddy admin API integration", () => {
  test("reads and validates native Caddy JSON", async () => {
    const expected: CaddyConfig = {
      admin: { listen: "127.0.0.1:2019" },
      apps: { http: { servers: { proxy: { listen: [":80"] } } } },
    };
    activeConfig = expected;

    await expect(readCaddyConfig(adminUrl)).resolves.toEqual(expected);
  });

  test("normalizes a trailing slash on the admin endpoint", async () => {
    const expected: CaddyConfig = { apps: { http: {} } };
    activeConfig = expected;

    await expect(readCaddyConfig(`${adminUrl}/`)).resolves.toEqual(expected);
    await loadCaddyConfig({}, `${adminUrl}/`);
    expect(activeConfig).toEqual({});
  });

  test("preserves unknown native Caddy fields during validation", async () => {
    const expected: CaddyConfig = {
      storage: { module: "file_system", root: "/tmp/caddy" },
      custom_extension: { enabled: true },
    };
    activeConfig = expected;

    await expect(readCaddyConfig(adminUrl)).resolves.toEqual(expected);
  });

  test.each([
    null,
    [],
    { apps: [] },
    { apps: { http: { servers: { bad: { listen: [80] } } } } },
    { apps: { http: { servers: { bad: { routes: ["route"] } } } } },
  ])("rejects malformed API configuration %#", async (config) => {
    activeConfig = config;

    await expect(readCaddyConfig(adminUrl)).rejects.toBeDefined();
  });

  test("loads native JSON with the required content type", async () => {
    const config: CaddyConfig = {
      apps: { http: { servers: { proxy: { listen: [":80"] } } } },
    };

    await loadCaddyConfig(config, adminUrl);

    expect(activeConfig).toEqual(config);
    expect(lastContentType).toBe("application/json");
  });

  test("round-trips a loaded configuration", async () => {
    const config: CaddyConfig = {
      apps: {
        http: {
          servers: {
            proxy: {
              listen: ["127.0.0.1:80", "[::1]:80"],
              routes: [{ "@id": "managed-route", handle: [] }],
            },
          },
        },
      },
    };

    await loadCaddyConfig(config, adminUrl);

    await expect(readCaddyConfig(adminUrl)).resolves.toEqual(config);
  });

  test("includes admin response details in read errors", async () => {
    await expect(readCaddyConfig(`${adminUrl}/failure`)).rejects.toThrow(
      "Caddy admin API returned 503: admin unavailable",
    );
  });

  test("includes admin response details in load errors", async () => {
    await expect(
      loadCaddyConfig({}, `${adminUrl}/failure`),
    ).rejects.toThrow(
      "Caddy rejected the configuration (400): configuration rejected",
    );
  });
});
