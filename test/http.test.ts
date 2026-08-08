import { describe, expect, it } from "vitest";

import {
  boundedRetryAfter,
  circuitBreakerEnabled,
  enforceCircuitBreaker,
  HttpError,
  httpErrorResponse,
} from "../src/http";

describe("bounded HTTP errors", () => {
  it("returns a stable no-store JSON response without a redirect", async () => {
    const response = httpErrorResponse(new HttpError("invalid_target"));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.has("Location")).toBe(false);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_target",
        message: "The request target is invalid.",
      },
    });
  });

  it("sets a canonical Allow header only when supplied", () => {
    const response = httpErrorResponse(new HttpError("method_not_allowed", {
      allow: ["POST", "GET", "POST"],
    }));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");

    const unrelated = httpErrorResponse(new HttpError("not_found", {
      allow: ["GET"],
    }));
    expect(unrelated.headers.has("Allow")).toBe(false);
  });

  it("bounds Retry-After and emits one stable rate-limit contract", async () => {
    expect(boundedRetryAfter(undefined)).toBe(60);
    expect(boundedRetryAfter(Number.NaN)).toBe(60);
    expect(boundedRetryAfter(-50)).toBe(1);
    expect(boundedRetryAfter(1.9)).toBe(2);
    expect(boundedRetryAfter(100_000)).toBe(86_400);

    const rateLimited = httpErrorResponse(new HttpError("rate_limited", {
      rateLimitReason: "publish_daily",
      retryAfterSeconds: 100_000,
    }));
    expect(rateLimited.headers.get("Retry-After")).toBe("86400");
    expect(await rateLimited.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "The request budget has been exhausted.",
        reason: "publish_daily",
        retry_after_seconds: 86_400,
      },
    });
    expect(httpErrorResponse(new HttpError("service_disabled", {
      retryAfterSeconds: 0,
    })).headers.get("Retry-After")).toBe("1");
    const unavailable = httpErrorResponse(
      new HttpError("request_control_unavailable", {
        retryAfterSeconds: 60,
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Retry-After")).toBe("60");
    expect(await unavailable.json()).toEqual({
      error: {
        code: "request_control_unavailable",
        message: "Request admission is temporarily unavailable.",
      },
    });
    expect(httpErrorResponse(new HttpError("bad_request", {
      retryAfterSeconds: 20,
    })).headers.has("Retry-After")).toBe(false);
  });

  it("advertises the WebSocket upgrade without redirecting", () => {
    const response = httpErrorResponse(new HttpError("upgrade_required"));
    expect(response.status).toBe(426);
    expect(response.headers.get("Upgrade")).toBe("websocket");
    expect(response.headers.has("Location")).toBe(false);
  });
});

describe("circuit breakers", () => {
  it("opens a route only for the exact explicit enabled value", () => {
    expect(circuitBreakerEnabled("enabled")).toBe(true);
    for (const value of [
      undefined,
      "",
      "ENABLED",
      " enabled",
      "enabled ",
      "true",
      "1",
      "disabled",
      "typo",
    ]) {
      expect(circuitBreakerEnabled(value)).toBe(false);
    }
  });

  it("fails closed for missing and invalid flags", () => {
    expect(() => enforceCircuitBreaker("enabled")).not.toThrow();
    for (const value of [undefined, "", "disabled", "true", "typo"]) {
      expect(() => enforceCircuitBreaker(value, 120)).toThrowError(
        expect.objectContaining({
          code: "service_disabled",
          status: 503,
          retryAfterSeconds: 120,
        }),
      );
    }
  });
});
