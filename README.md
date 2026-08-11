# Caddy Local Dev Proxy

[![npm version](https://img.shields.io/npm/v/caddy-local-dev-proxy)](https://www.npmjs.com/package/caddy-local-dev-proxy)
[![license](https://img.shields.io/npm/l/caddy-local-dev-proxy)](LICENSE)

Run multiple local development servers behind memorable `.localhost` domains instead of keeping track of port numbers.

```text
http://app.localhost  -> http://localhost:3000
http://api.localhost  -> http://localhost:4000
```

The command starts Caddy as an operating-system-detached process, then configures its reverse-proxy routes through Caddy's admin API. Caddy keeps running after the BunX command exits.

## Why

- No hosts-file changes: `localhost` and names ending in `.localhost` resolve to the loopback interface.
- One command configures any number of local domains.
- The proxy survives the shell command that launched it.
- Windows starts Caddy without opening a console window.
- Re-running the command reuses an existing Caddy process.
- Unrelated routes in an existing Caddy configuration are preserved.
- New listeners bind only to IPv4 and IPv6 loopback addresses, not public interfaces.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer.
- [Caddy](https://caddyserver.com/docs/install) installed and available on `PATH`.
- Permission to bind localhost port 80. Linux may require root or `CAP_NET_BIND_SERVICE` for the Caddy executable.

Caddy's default admin endpoint, `http://127.0.0.1:2019`, must be enabled and reachable when reusing a running instance.

## Quick start

Map each domain to the port of its development server:

```sh
bunx caddy-local-dev-proxy app.localhost:3000 api.localhost:4000
```

Open `http://app.localhost` and `http://api.localhost` in a browser.

An equals sign can be used instead of a colon:

```sh
bunx caddy-local-dev-proxy app.localhost=3000 api.localhost=4000
```

The bare `localhost` name and nested subdomains are supported too:

```sh
bunx caddy-local-dev-proxy localhost:3000 admin.api.localhost:4000
```

## How it works

1. The command validates every domain and port.
2. It queries Caddy's default admin API to determine whether Caddy is already running and configured on port 80.
3. If Caddy is absent and port 80 is free, it validates a bootstrap configuration and starts `caddy run` in a detached process group. On Windows, the process is created with its console window hidden.
4. It reads the active native JSON configuration, adds managed reverse-proxy routes, and posts the result to Caddy's transactional `/load` endpoint.
5. It reads the configuration back to verify that Caddy retained a port-80 listener.

Routes managed by this package have stable Caddy IDs beginning with `caddy-local-dev-proxy:`. Every invocation replaces the package's previous routes with the mappings supplied in that invocation. Other Caddy routes and top-level configuration are retained.

To stop the detached server:

```sh
caddy stop
```

## Safety and limitations

- Only `localhost` and valid names ending in `.localhost` are accepted.
- Ports must be integers from 1 through 65535.
- New Caddy servers listen on `127.0.0.1:80` and `[::1]:80` only.
- If port 80 is occupied but the Caddy admin API is unavailable, the command fails rather than starting a conflicting process.
- A Caddy instance with a disabled or relocated admin API cannot be managed.
- Configuration uses a read-modify-load transaction. Concurrent writes from another Caddy API client may result in last-write-wins behavior.

## Local test project

The repository includes two small Bun servers for exercising the proxy end to end.

In the first terminal:

```sh
bun run test-project:start
```

In the second terminal, start or update the proxy:

```sh
bun run test-project:proxy
```

Then verify both domains:

```sh
bun run test-project:verify
```

The test project uses:

- `http://web.localhost` -> `http://localhost:3100`
- `http://api.localhost` -> `http://localhost:3200`

## Development

Install dependencies:

```sh
bun install
```

Available commands:

```sh
just test       # unit and integration tests
just typecheck  # TypeScript validation
just check      # tests plus typecheck
just build      # bundled BunX executable in dist/index.js
```

The same operations are available through the corresponding `bun run` scripts.

## Publishing

The package publishes the bundled `dist/index.js` executable. Bun's publish lifecycle runs tests and typechecking before packaging, then builds the distributable.

After configuring npm credentials and updating the package version:

```sh
just publish
```

Or invoke Bun directly:

```sh
bun run publish:npm
```

## License

[MIT](LICENSE) © Jan Kelin
