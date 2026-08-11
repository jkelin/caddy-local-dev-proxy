/// <reference types="bun" />

export {};

const services = [
  { name: "web", port: 3100 },
  { name: "api", port: 3200 },
] as const;

for (const service of services) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: service.port,
    // The test endpoint deliberately returns request details so proxy host and
    // path forwarding can be inspected without introducing application state.
    fetch(request) {
      const url = new URL(request.url);
      return Response.json({
        service: service.name,
        host: request.headers.get("host"),
        path: `${url.pathname}${url.search}`,
      });
    },
  });

  console.log(`${service.name} server: http://localhost:${service.port}`);
}

console.log("Press Ctrl+C to stop both test servers.");
