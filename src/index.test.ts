import { describe, expect, test } from "bun:test";

import {
  MANAGED_ROUTE_ID_PREFIX,
  configListensOnPort80,
  mergeCaddyConfig,
  parseMappings,
} from "./index.ts";

describe("parseMappings", () => {
  test("parses colon and equals forms and normalizes hostnames", () => {
    expect(parseMappings(["App.Localhost:3000", "api.localhost=4000"])).toEqual([
      { hostname: "app.localhost", port: 3000 },
      { hostname: "api.localhost", port: 4000 },
    ]);
  });

  test.each([
    ["localhost:1", { hostname: "localhost", port: 1 }],
    [
      "nested-admin.example.localhost:65535",
      { hostname: "nested-admin.example.localhost", port: 65_535 },
    ],
    [
      "  spaced.localhost=8080  ",
      { hostname: "spaced.localhost", port: 8_080 },
    ],
  ])("accepts boundary mapping %s", (argument, expected) => {
    expect(parseMappings([argument])).toEqual([expected]);
  });

  test("preserves mapping order", () => {
    expect(
      parseMappings([
        "third.localhost:3003",
        "first.localhost:3001",
        "second.localhost:3002",
      ]).map(({ hostname }) => hostname),
    ).toEqual([
      "third.localhost",
      "first.localhost",
      "second.localhost",
    ]);
  });

  test.each([
    [[], "At least one mapping"],
    [[""], "Expected"],
    [["   "], "Expected"],
    [["example.com:3000"], "must be localhost"],
    [["http://app.localhost:3000"], "valid hostname"],
    [["-bad.localhost:3000"], "valid hostname"],
    [["bad-.localhost:3000"], "valid hostname"],
    [["bad_name.localhost:3000"], "valid hostname"],
    [["bad..localhost:3000"], "valid hostname"],
    [[".localhost:3000"], "valid hostname"],
    [["app.localhost.:3000"], "must be localhost"],
    [["äpp.localhost:3000"], "valid hostname"],
    [[`${"a".repeat(64)}.localhost:3000`], "valid hostname"],
    [["app.localhost"], "Expected"],
    [["app.localhost:"], "Expected"],
    [["app.localhost:0"], "between 1 and 65535"],
    [["app.localhost:-1"], "between 1 and 65535"],
    [["app.localhost:+3000"], "between 1 and 65535"],
    [["app.localhost:3.5"], "between 1 and 65535"],
    [["app.localhost:65536"], "between 1 and 65535"],
    [["app.localhost:not-a-port"], "between 1 and 65535"],
    [["app.localhost:3000", "APP.localhost=4000"], "Duplicate hostname"],
  ])("rejects invalid mappings %#", (args, message) => {
    expect(() => parseMappings(args)).toThrow(message);
  });
});

describe("configListensOnPort80", () => {
  test.each([
    ["127.0.0.1:80", true],
    ["[::1]:80", true],
    [":80", true],
    ["tcp/:80-90", true],
    [":8080", false],
  ])("recognizes %s", (listen, expected) => {
    expect(
      configListensOnPort80({
        apps: { http: { servers: { existing: { listen: [listen] } } } },
      }),
    ).toBe(expected);
  });

  test("returns false when HTTP servers or listeners are absent", () => {
    expect(configListensOnPort80({})).toBe(false);
    expect(configListensOnPort80({ apps: { http: {} } })).toBe(false);
    expect(
      configListensOnPort80({
        apps: { http: { servers: { existing: {} } } },
      }),
    ).toBe(false);
  });

  test("finds port 80 across multiple servers and listeners", () => {
    expect(
      configListensOnPort80({
        apps: {
          http: {
            servers: {
              development: { listen: ["127.0.0.1:3000", ":8080"] },
              proxy: { listen: ["127.0.0.1:443", "127.0.0.1:80"] },
            },
          },
        },
      }),
    ).toBe(true);
  });
});

describe("mergeCaddyConfig", () => {
  test("creates a loopback-only HTTP server without mutating input", () => {
    const input = { admin: { listen: "127.0.0.1:2019" } };
    const result = mergeCaddyConfig(input, [
      { hostname: "app.localhost", port: 3000 },
    ]);

    expect(input).toEqual({ admin: { listen: "127.0.0.1:2019" } });
    expect(result.admin).toEqual(input.admin);
    expect(result.apps).toEqual({
      http: {
        servers: {
          caddy_local_dev_proxy: {
            listen: ["127.0.0.1:80", "[::1]:80"],
            automatic_https: { disable: true },
            routes: [
              {
                "@id": `${MANAGED_ROUTE_ID_PREFIX}app.localhost`,
                match: [{ host: ["app.localhost"] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "localhost:3000" }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
  });

  test("replaces managed routes on an existing port-80 server and preserves other routes", () => {
    const existingRoute = {
      match: [{ path: ["/existing"] }],
      handle: [{ handler: "static_response", body: "existing" }],
    };
    const input = {
      storage: { module: "file_system", root: "/var/lib/caddy" },
      apps: {
        http: {
          servers: {
            existing: {
              listen: [":80"],
              routes: [
                {
                  "@id": `${MANAGED_ROUTE_ID_PREFIX}old.localhost`,
                  handle: [],
                },
                existingRoute,
              ],
            },
          },
        },
      },
    };

    const result = mergeCaddyConfig(input, [
      { hostname: "new.localhost", port: 5173 },
    ]);
    const routes = result.apps?.http?.servers?.existing?.routes;

    expect(routes).toHaveLength(2);
    expect(routes?.[0]?.["@id"]).toBe(
      `${MANAGED_ROUTE_ID_PREFIX}new.localhost`,
    );
    expect(routes?.[1]).toBe(existingRoute);
    expect(result.storage).toBe(input.storage);
    expect(input.apps.http.servers.existing.routes).toHaveLength(2);
  });

  test("creates ordered routes for every mapping", () => {
    const result = mergeCaddyConfig({}, [
      { hostname: "web.localhost", port: 3100 },
      { hostname: "api.localhost", port: 3200 },
    ]);
    const routes =
      result.apps?.http?.servers?.caddy_local_dev_proxy?.routes ?? [];

    expect(routes.map((route) => route["@id"])).toEqual([
      `${MANAGED_ROUTE_ID_PREFIX}web.localhost`,
      `${MANAGED_ROUTE_ID_PREFIX}api.localhost`,
    ]);
    expect(routes.map((route) => route.handle)).toEqual([
      [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: "localhost:3100" }],
        },
      ],
      [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: "localhost:3200" }],
        },
      ],
    ]);
  });

  test("is idempotent when the same mappings are applied twice", () => {
    const mappings = [
      { hostname: "web.localhost", port: 3100 },
      { hostname: "api.localhost", port: 3200 },
    ];
    const first = mergeCaddyConfig({}, mappings);
    const second = mergeCaddyConfig(first, mappings);

    expect(second).toEqual(first);
    expect(
      second.apps?.http?.servers?.caddy_local_dev_proxy?.routes,
    ).toHaveLength(2);
  });

  test("removes stale managed routes when mappings are empty", () => {
    const initial = mergeCaddyConfig({}, [
      { hostname: "old.localhost", port: 3000 },
    ]);
    const result = mergeCaddyConfig(initial, []);

    expect(
      result.apps?.http?.servers?.caddy_local_dev_proxy?.routes,
    ).toEqual([]);
  });

  test("preserves existing HTTP app, server, and route fields", () => {
    const input = {
      apps: {
        custom: { enabled: true },
        http: {
          http_port: 80,
          servers: {
            secure: {
              listen: [":443"],
              protocols: ["h1", "h2"],
            },
            plain: {
              listen: [":80"],
              logs: { default_logger_name: "development" },
              routes: [{ "@id": "existing", handle: [] }],
            },
          },
        },
      },
    };

    const result = mergeCaddyConfig(input, [
      { hostname: "app.localhost", port: 5173 },
    ]);

    expect(result.apps?.custom).toBe(input.apps.custom);
    expect(result.apps?.http?.http_port).toBe(80);
    expect(result.apps?.http?.servers?.secure).toBe(
      input.apps.http.servers.secure,
    );
    expect(result.apps?.http?.servers?.plain?.logs).toEqual({
      default_logger_name: "development",
    });
    expect(result.apps?.http?.servers?.plain?.routes?.[1]).toBe(
      input.apps.http.servers.plain.routes[0],
    );
    expect(result.apps?.http?.servers?.plain?.automatic_https).toBeUndefined();
  });

  test("upgrades a previously named non-port-80 server without discarding its fields", () => {
    const result = mergeCaddyConfig(
      {
        apps: {
          http: {
            servers: {
              caddy_local_dev_proxy: {
                listen: ["127.0.0.1:8080"],
                trusted_proxies_strict: true,
              },
            },
          },
        },
      },
      [{ hostname: "app.localhost", port: 3000 }],
    );
    const server = result.apps?.http?.servers?.caddy_local_dev_proxy;

    expect(server?.listen).toEqual(["127.0.0.1:80", "[::1]:80"]);
    expect(server?.trusted_proxies_strict).toBe(true);
    expect(server?.automatic_https).toEqual({ disable: true });
  });
});
