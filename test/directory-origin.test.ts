import { describe, expect, it } from "vitest";

import {
  directoryOriginValidatorsMatchBytes,
  isDirectoryOriginPublicationTime,
  isDirectoryOriginStrongEtag,
} from "../src/directory-origin";

describe("static directory origin metadata", () => {
  it.each([
    '"a"',
    '"0123456789abcdef0123456789abcdef"',
    `"${"x".repeat(126)}"`,
    '"!#$%&\'()*+,-./:;<=>?@[]^_`{|}~"',
  ])("accepts opaque strong ETag %s", (etag) => {
    expect(isDirectoryOriginStrongEtag(etag)).toBe(true);
  });

  it.each([
    "",
    'W/"opaque"',
    "opaque",
    '""',
    '"has space"',
    '"has\\backslash"',
    '"has\"quote"',
    '"has\u007fdelete"',
    `"${"x".repeat(127)}"`,
  ])("rejects invalid HTTP validator %s", (etag) => {
    expect(isDirectoryOriginStrongEtag(etag)).toBe(false);
  });

  it("allows a validator to be reused only for byte-identical representations", () => {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    expect(directoryOriginValidatorsMatchBytes([
      { etag: '"html"', bodySha256: digestA },
      { etag: '"json"', bodySha256: digestB },
      { etag: '"html"', bodySha256: digestA },
    ])).toBe(true);
    expect(directoryOriginValidatorsMatchBytes([
      { etag: '"shared"', bodySha256: digestA },
      { etag: '"shared"', bodySha256: digestB },
    ])).toBe(false);
    expect(directoryOriginValidatorsMatchBytes([
      { etag: 'W/"weak"', bodySha256: digestA },
    ])).toBe(false);
    expect(directoryOriginValidatorsMatchBytes([
      { etag: '"opaque"', bodySha256: "not-a-digest" },
    ])).toBe(false);
  });

  it("bounds alias upload time by the embedded freshness interval", () => {
    const generatedAt = 1_000;
    const expiresAt = 2_000;

    expect(isDirectoryOriginPublicationTime(
      generatedAt * 1_000,
      generatedAt,
      expiresAt,
    )).toBe(true);
    expect(isDirectoryOriginPublicationTime(
      expiresAt * 1_000 - 1,
      generatedAt,
      expiresAt,
    )).toBe(true);
    expect(isDirectoryOriginPublicationTime(
      generatedAt * 1_000 - 1,
      generatedAt,
      expiresAt,
    )).toBe(false);
    expect(isDirectoryOriginPublicationTime(
      expiresAt * 1_000,
      generatedAt,
      expiresAt,
    )).toBe(false);
    expect(isDirectoryOriginPublicationTime(
      Number.NaN,
      generatedAt,
      expiresAt,
    )).toBe(false);
  });
});
