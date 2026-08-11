#!/usr/bin/env bun

import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const MANAGED_ROUTE_ID_PREFIX = "caddy-local-dev-proxy:";

const ADMIN_URL = "http://127.0.0.1:2019";
const LOCAL_LISTENERS = ["127.0.0.1:80", "[::1]:80"] as const;
const SERVER_NAME = "caddy_local_dev_proxy";

export interface ProxyMapping {
  hostname: string;
  port: number;
}

const CaddyRouteSchema = z.looseObject({
  "@id": z.string().optional(),
});
const CaddyServerSchema = z.looseObject({
  listen: z.array(z.string()).optional(),
  routes: z.array(CaddyRouteSchema).optional(),
});
const CaddyHttpAppSchema = z.looseObject({
  servers: z.record(z.string(), CaddyServerSchema).optional(),
});
const CaddyAppsSchema = z.looseObject({
  http: CaddyHttpAppSchema.optional(),
});
const CaddyConfigSchema = z.looseObject({
  apps: CaddyAppsSchema.optional(),
});

export type CaddyRoute = z.infer<typeof CaddyRouteSchema>;
export type CaddyServer = z.infer<typeof CaddyServerSchema>;
export type CaddyConfig = z.infer<typeof CaddyConfigSchema>;

/**
 * Parses `host.localhost:port` and `host.localhost=port` arguments.
 * Edge cases: hostnames are case-insensitive, duplicates are rejected after
 * normalization, and only the reserved localhost name tree is accepted.
 */
export function parseMappings(args: readonly string[]): ProxyMapping[] {
  if (args.length === 0) {
    throw new Error("At least one mapping is required.");
  }

  const seenHostnames = new Set<string>();

  return args.map((rawArgument) => {
    const argument = rawArgument.trim();
    const equalsIndex = argument.lastIndexOf("=");
    const separatorIndex =
      equalsIndex >= 0 ? equalsIndex : argument.lastIndexOf(":");

    if (separatorIndex <= 0 || separatorIndex === argument.length - 1) {
      throw new Error(
        `Expected "${rawArgument}" to use <domain>:<port> or <domain>=<port>.`,
      );
    }

    const hostname = argument.slice(0, separatorIndex).toLowerCase();
    const portText = argument.slice(separatorIndex + 1);

    if (!isValidLocalhostHostname(hostname)) {
      throw new Error(
        `"${hostname}" must be localhost or a valid hostname ending in .localhost.`,
      );
    }

    if (!/^\d+$/.test(portText)) {
      throw new Error(`Port "${portText}" must be between 1 and 65535.`);
    }

    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Port "${portText}" must be between 1 and 65535.`);
    }

    if (seenHostnames.has(hostname)) {
      throw new Error(`Duplicate hostname "${hostname}".`);
    }
    seenHostnames.add(hostname);

    return { hostname, port };
  });
}

/**
 * Validates DNS-style names in the RFC-reserved localhost tree.
 * Edge cases: empty labels, leading/trailing hyphens, non-ASCII characters,
 * and overlong DNS names are intentionally rejected rather than normalized.
 */
function isValidLocalhostHostname(hostname: string): boolean {
  if (hostname !== "localhost" && !hostname.endsWith(".localhost")) {
    return false;
  }
  if (hostname.length > 253) {
    return false;
  }

  return hostname
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );
}

/**
 * Reports whether native Caddy JSON has an HTTP server bound to port 80.
 * Edge cases: it recognizes host, IPv6, network-prefixed, and port-range
 * addresses; missing config branches are treated as absent.
 */
export function configListensOnPort80(config: CaddyConfig): boolean {
  const servers = config.apps?.http?.servers;
  if (servers === undefined) {
    return false;
  }

  return Object.values(servers).some((server) =>
    server.listen?.some((address) => /:80(?:-|$)/.test(address)),
  );
}

/**
 * Adds this tool's host routes while preserving unrelated Caddy config.
 * Edge cases: stale managed routes are replaced idempotently, and an existing
 * port-80 server is reused so Caddy is never asked to bind the port twice.
 */
export function mergeCaddyConfig(
  config: CaddyConfig,
  mappings: readonly ProxyMapping[],
): CaddyConfig {
  const apps = config.apps ?? {};
  const http = apps.http ?? {};
  const servers = http.servers ?? {};
  const port80ServerName = Object.entries(servers).find(([, server]) =>
    server.listen?.some((address) => /:80(?:-|$)/.test(address)),
  )?.[0];
  const targetName = port80ServerName ?? SERVER_NAME;
  const targetServer = servers[targetName] ?? {};
  const unmanagedRoutes = (targetServer.routes ?? []).filter(
    (route) =>
      route["@id"] === undefined ||
      !route["@id"].startsWith(MANAGED_ROUTE_ID_PREFIX),
  );

  // Each mapping is a top-level route so a non-matching managed host can fall
  // through to any pre-existing Caddy routes on the shared HTTP server.
  const managedRoutes: CaddyRoute[] = mappings.map((mapping) => ({
    "@id": `${MANAGED_ROUTE_ID_PREFIX}${mapping.hostname}`,
    match: [{ host: [mapping.hostname] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `localhost:${mapping.port}` }],
      },
    ],
  }));
  const nextServer: CaddyServer = {
    ...targetServer,
    listen: port80ServerName
      ? targetServer.listen
      : [...LOCAL_LISTENERS],
    ...(port80ServerName ? {} : { automatic_https: { disable: true } }),
    routes: [...managedRoutes, ...unmanagedRoutes],
  };

  return {
    ...config,
    apps: {
      ...apps,
      http: {
        ...http,
        servers: {
          ...servers,
          [targetName]: nextServer,
        },
      },
    },
  };
}

/**
 * Reads and validates active config from a Caddy admin endpoint.
 * Edge cases: connection failures mean no reachable Caddy, while HTTP errors
 * and invalid JSON are surfaced because starting a second instance is unsafe.
 * The endpoint parameter exists for isolated integration tests and custom API
 * clients; the CLI always uses Caddy's default loopback endpoint.
 */
export async function readCaddyConfig(
  adminUrl = ADMIN_URL,
): Promise<CaddyConfig | null> {
  let response: Response;
  try {
    response = await fetch(`${adminUrl.replace(/\/+$/, "")}/config/`, {
      signal: AbortSignal.timeout(750),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Caddy admin API returned ${response.status}: ${await responseText(response)}`,
    );
  }

  return CaddyConfigSchema.parse(await response.json());
}

/**
 * Loads a complete native JSON config through Caddy's transactional API.
 * Edge cases: non-2xx responses include a bounded response body, and network
 * errors propagate to the CLI instead of claiming the routes were applied.
 * A trailing slash on a test or client-supplied endpoint is normalized.
 */
export async function loadCaddyConfig(
  config: CaddyConfig,
  adminUrl = ADMIN_URL,
): Promise<void> {
  const response = await fetch(`${adminUrl.replace(/\/+$/, "")}/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(
      `Caddy rejected the configuration (${response.status}): ${await responseText(response)}`,
    );
  }
}

/**
 * Bounds diagnostic response text so a misbehaving endpoint cannot flood CLI
 * output. Edge cases: empty bodies receive a useful placeholder.
 */
async function responseText(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return text.length === 0 ? "empty response" : text.slice(0, 1_000);
}

/**
 * Probes both loopback families before attempting to bind a privileged port.
 * Edge cases: a listener on either IPv4 or IPv6 blocks startup, and failed
 * connections are expected rather than treated as command failures.
 */
async function isLocalPortListening(port: number): Promise<boolean> {
  const results = await Promise.all([
    canConnect("127.0.0.1", port),
    canConnect("::1", port),
  ]);
  return results.some(Boolean);
}

/**
 * Attempts one TCP connection using Bun's native socket API.
 * Edge cases: connection refusal and unsupported IPv6 both return false; a
 * successful socket is closed immediately without writing application data.
 */
async function canConnect(hostname: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname,
      port,
      socket: {
        data() {},
      },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts `caddy run` in an OS-detached process group and waits for its API.
 * Edge cases: the bootstrap config is validated first, temporary files are
 * always removed, and early process exit is reported instead of timing out.
 */
async function startDetachedCaddy(): Promise<CaddyConfig> {
  const executable = Bun.which("caddy");
  if (executable === null) {
    throw new Error(
      "Caddy is not installed or is not on PATH. Install Caddy, then rerun this command.",
    );
  }

  const bootstrapConfig = mergeCaddyConfig({}, []);
  const temporaryConfigPath = join(
    tmpdir(),
    `caddy-local-dev-proxy-${crypto.randomUUID()}.json`,
  );
  await Bun.write(temporaryConfigPath, JSON.stringify(bootstrapConfig));

  try {
    await validateBootstrapConfig(executable, temporaryConfigPath);

    const process = Bun.spawn(
      [executable, "run", "--config", temporaryConfigPath],
      {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    process.unref();

    return await waitForCaddy(process);
  } finally {
    await Bun.file(temporaryConfigPath).delete().catch(() => undefined);
  }
}

/**
 * Uses Caddy itself to validate the bootstrap JSON before detaching it.
 * Edge cases: stdout and stderr are read concurrently to avoid pipe backpressure,
 * and either stream may contain the useful validation diagnostic.
 */
async function validateBootstrapConfig(
  executable: string,
  configPath: string,
): Promise<void> {
  const process = Bun.spawn(
    [executable, "validate", "--config", configPath],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const diagnostic = stderr.trim() || stdout.trim() || "unknown error";
    throw new Error(`Caddy could not validate its bootstrap config: ${diagnostic}`);
  }
}

/**
 * Waits only through Caddy's short startup window after a detached spawn.
 * Edge cases: an immediate process exit usually indicates port permissions or
 * a race for port 80; an API that never appears yields an actionable timeout.
 */
async function waitForCaddy(
  process: Bun.Subprocess<"ignore", "ignore", "ignore">,
): Promise<CaddyConfig> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const config = await readCaddyConfig();
    if (config !== null) {
      return config;
    }

    const exitCode = await Promise.race([
      process.exited,
      Bun.sleep(100).then(() => null),
    ]);
    if (exitCode !== null) {
      throw new Error(
        `Detached Caddy exited during startup with code ${exitCode}. Port 80 may require elevated privileges on this system.`,
      );
    }
  }

  throw new Error(
    "Detached Caddy did not expose its admin API within 3 seconds.",
  );
}

/**
 * Prints stable CLI usage without requiring Caddy to be installed.
 * Edge cases: help is accepted as the only argument path and exits successfully.
 */
function printUsage(): void {
  console.log(`Usage:
  bunx caddy-local-dev-proxy <domain>:<port> [<domain>:<port> ...]

Mappings may use either a colon or equals sign:
  bunx caddy-local-dev-proxy app.localhost:3000 api.localhost=4000`);
}

/**
 * Coordinates discovery, detached startup, config injection, and verification.
 * Edge cases: an occupied port without a reachable Caddy API fails safely, and
 * existing unrelated Caddy routes remain intact through the merge.
 */
export async function main(args: readonly string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printUsage();
    return 0;
  }

  const mappings = parseMappings(args);
  let config = await readCaddyConfig();
  let started = false;

  if (config === null) {
    if (await isLocalPortListening(80)) {
      throw new Error(
        "Port 80 is already in use, but Caddy's admin API is not reachable at 127.0.0.1:2019.",
      );
    }
    config = await startDetachedCaddy();
    started = true;
  } else if (
    !configListensOnPort80(config) &&
    (await isLocalPortListening(80))
  ) {
    throw new Error(
      "Port 80 is in use by another process, so the running Caddy instance cannot bind it.",
    );
  }

  const updatedConfig = mergeCaddyConfig(config, mappings);
  await loadCaddyConfig(updatedConfig);

  const appliedConfig = await readCaddyConfig();
  if (appliedConfig === null || !configListensOnPort80(appliedConfig)) {
    throw new Error("Caddy did not retain the applied port-80 configuration.");
  }

  console.log(started ? "Started detached Caddy." : "Using running Caddy.");
  for (const mapping of mappings) {
    console.log(
      `http://${mapping.hostname} -> http://localhost:${mapping.port}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`caddy-local-dev-proxy: ${message}`);
    process.exitCode = 1;
  }
}
