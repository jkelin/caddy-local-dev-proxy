/// <reference types="bun" />

export {};

const expectations = [
  {
    url: "http://web.localhost/health?source=test-project",
    service: "web",
  },
  {
    url: "http://api.localhost/health?source=test-project",
    service: "api",
  },
] as const;

for (const expectation of expectations) {
  const response = await fetch(expectation.url, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`${expectation.url} returned HTTP ${response.status}.`);
  }

  const body: unknown = await response.json();
  // The verifier checks only the stable observable fields; additional fields
  // may be added to the demo response without making the smoke test brittle.
  if (
    typeof body !== "object" ||
    body === null ||
    !("service" in body) ||
    body.service !== expectation.service
  ) {
    throw new Error(
      `${expectation.url} did not reach the ${expectation.service} service.`,
    );
  }

  console.log(`${expectation.url} -> ${expectation.service}`);
}
