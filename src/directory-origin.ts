/**
 * Validate the static origin metadata that consumers use for conditional
 * retrieval. Body SHA-256 remains independent integrity metadata; the public
 * validator is the opaque strong ETag selected by R2 for the alias object.
 */
export function isDirectoryOriginStrongEtag(value: unknown): value is string {
  if (
    typeof value !== "string" || value.length < 3 || value.length > 128 ||
    value[0] !== '"' || value[value.length - 1] !== '"'
  ) {
    return false;
  }
  for (let index = 1; index + 1 < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (
      codePoint < 0x21 || codePoint > 0x7e || codePoint === 0x22 ||
      codePoint === 0x5c
    ) {
      return false;
    }
  }
  return true;
}

interface DirectoryOriginRepresentation {
  readonly etag: unknown;
  readonly bodySha256: unknown;
}

/**
 * A reused validator may identify only byte-identical representations. This
 * pins the cross-format part of the public cache contract independently from
 * whichever opaque values R2 selects.
 */
export function directoryOriginValidatorsMatchBytes(
  representations: readonly DirectoryOriginRepresentation[],
): boolean {
  const bytesByValidator = new Map<string, string>();
  for (const representation of representations) {
    if (
      !isDirectoryOriginStrongEtag(representation.etag) ||
      typeof representation.bodySha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(representation.bodySha256)
    ) {
      return false;
    }
    const previous = bytesByValidator.get(representation.etag);
    if (previous !== undefined && previous !== representation.bodySha256) {
      return false;
    }
    bytesByValidator.set(representation.etag, representation.bodySha256);
  }
  return true;
}

export function isDirectoryOriginPublicationTime(
  timestampMilliseconds: unknown,
  generatedAt: number,
  expiresAt: number,
): boolean {
  if (
    typeof timestampMilliseconds !== "number" ||
    !Number.isFinite(timestampMilliseconds) ||
    !Number.isSafeInteger(generatedAt) || generatedAt < 0 ||
    !Number.isSafeInteger(expiresAt) || expiresAt <= generatedAt
  ) {
    return false;
  }
  return timestampMilliseconds >= generatedAt * 1_000 &&
    timestampMilliseconds < expiresAt * 1_000;
}
