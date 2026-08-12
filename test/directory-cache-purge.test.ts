import { describe, expect, it, vi } from "vitest";

import { purgeDirectoryAliases } from "../src/directory-cache-purge";

const ENVIRONMENT = Object.freeze({
  DIRECTORY_CACHE_PURGE_TOKEN: "test-directory-cache-purge-token",
  DIRECTORY_CACHE_ZONE_ID: "a".repeat(32),
  CLASSIC_DIRECTORY_PUBLIC_ORIGIN: "https://classic.meta.atrinik.org",
  GAME_DIRECTORY_PUBLIC_ORIGIN: "https://meta.atrinik.org",
});

describe("directory cache purge", () => {
  it("accepts only the exact documented successful envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(success({ id: "b".repeat(32) }));
    await expect(purgeDirectoryAliases(
      ENVIRONMENT,
      "classic-v1",
      fetcher,
    )).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTTP rejection", success({ id: "b".repeat(32) }, 500)],
    ["unsuccessful envelope", response({
      success: false,
      errors: [],
      messages: [],
      result: null,
    })],
    ["open envelope", response({
      success: true,
      errors: [],
      messages: [],
      result: { id: "b".repeat(32) },
      extra: true,
    })],
    ["malformed result", response({
      success: true,
      errors: [],
      messages: [],
      result: { id: "not-an-id" },
    })],
    ["messages", response({
      success: true,
      errors: [],
      messages: [{ code: 1 }],
      result: { id: "b".repeat(32) },
    })],
    ["wrong content type", new Response("{}", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })],
    ["invalid JSON", new Response("{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })],
    ["oversized body", new Response(" ".repeat(8_193), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })],
  ])("rejects %s", async (_name, purgeResponse) => {
    await expect(purgeDirectoryAliases(
      ENVIRONMENT,
      "classic-v1",
      vi.fn().mockResolvedValue(purgeResponse),
    )).rejects.toThrow();
  });

  it.each([
    ["token", { DIRECTORY_CACHE_PURGE_TOKEN: "short" }],
    ["zone", { DIRECTORY_CACHE_ZONE_ID: "A".repeat(32) }],
    ["scheme", {
      CLASSIC_DIRECTORY_PUBLIC_ORIGIN: "http://classic.meta.atrinik.org",
    }],
    ["path", {
      CLASSIC_DIRECTORY_PUBLIC_ORIGIN:
        "https://classic.meta.atrinik.org/index.json",
    }],
    ["credentials", {
      CLASSIC_DIRECTORY_PUBLIC_ORIGIN:
        "https://user@classic.meta.atrinik.org",
    }],
  ])("rejects invalid %s configuration before fetch", async (_name, mutation) => {
    const fetcher = vi.fn();
    await expect(purgeDirectoryAliases(
      { ...ENVIRONMENT, ...mutation },
      "classic-v1",
      fetcher,
    )).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function success(result: { readonly id: string }, status = 200): Response {
  return response({ success: true, errors: [], messages: [], result }, status);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
