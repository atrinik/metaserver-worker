import { describe, expect, it } from "vitest";

import classicJsonFixture from "./fixtures/classic-directory-v4/index.json?raw";
import classicXmlFixture from "./fixtures/classic-directory-v4/index.xml?raw";
import gameJsonFixture from "./fixtures/game-directory-v1/canonical.json?raw";
import gameXmlFixture from "./fixtures/game-directory-v1/projection.xml?raw";

import {
  type ClassicDirectoryServer,
  type ClassicDirectorySnapshot,
  type DirectoryArtifactDescriptor,
  type DirectorySnapshot,
  type GameDirectoryServer,
  type GameDirectorySnapshot,
  MAX_CLASSIC_DIRECTORY_ARTIFACT_BYTES,
  MAX_DIRECTORY_LIFETIME_SECONDS,
  MAX_GAME_DIRECTORY_JSON_BYTES,
  MAX_GAME_DIRECTORY_PROJECTION_BYTES,
  renderDirectoryArtifacts,
} from "../src/directory-artifacts";

const GENERATED_AT = 1_786_219_200;
const EXPIRES_AT = GENERATED_AT + 3_600;
const ID_A = "0".repeat(64);
const ID_B = "f".repeat(64);

function classicSnapshot(
  servers: readonly ClassicDirectoryServer[] = [],
): ClassicDirectorySnapshot {
  return {
    profile: "classic-v1",
    revision: 19,
    generation: "42",
    generatedAt: GENERATED_AT,
    expiresAt: EXPIRES_AT,
    servers,
  };
}

function gameSnapshot(
  servers: readonly GameDirectoryServer[] = [],
): GameDirectorySnapshot {
  return {
    profile: "game-v1",
    revision: 19,
    generation: "42",
    generatedAt: GENERATED_AT,
    expiresAt: EXPIRES_AT,
    servers,
  };
}

function classicServer(
  serverId = ID_A,
  overrides: Partial<ClassicDirectoryServer> = {},
): ClassicDirectoryServer {
  return {
    serverId,
    name: "Classic server",
    playersCount: 2,
    version: "3.0",
    textComment: "Welcome",
    certificateSha256: serverId,
    passwordRequired: false,
    ...overrides,
  };
}

function gameServer(
  serverId = ID_A,
  overrides: Partial<GameDirectoryServer> = {},
): GameDirectoryServer {
  return {
    serverId,
    certificateSha256: serverId,
    name: "Game server",
    description: "Welcome",
    protocol: { major: 1, minor: 0 },
    content: { id: "atrinik", revisionSha256: "1".repeat(64) },
    players: { online: 0, capacity: 20 },
    status: "online",
    passwordRequired: false,
    ...overrides,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectValidArtifact(
  artifact: DirectoryArtifactDescriptor,
): Promise<void> {
  const encoded = new TextEncoder().encode(artifact.body);
  expect(Array.from(artifact.bodyBytes)).toEqual(Array.from(encoded));
  expect(artifact.byteLength).toBe(encoded.byteLength);
  expect(artifact.sha256).toBe(await sha256Hex(encoded));
  expect(artifact.strongEtag).toMatch(
    new RegExp(`^\"[^\"]+-sha256-${artifact.sha256}\"$`),
  );
}

describe("static directory artifact rendering", () => {
  it.each([
    ["classic-v1", classicSnapshot()],
    ["game-v1", gameSnapshot()],
  ] as const)("renders one coherent empty %s generation", async (_, input) => {
    const rendered = await renderDirectoryArtifacts(input);

    expect(rendered).toMatchObject({
      profile: input.profile,
      revision: input.revision,
      generation: input.generation,
      generatedAt: input.generatedAt,
      expiresAt: input.expiresAt,
      serverCount: 0,
    });
    expect(Object.keys(rendered.artifacts)).toEqual(["html", "xml", "json"]);
    expect(rendered.artifacts.html.path).toBe("/index.html");
    expect(rendered.artifacts.xml.path).toBe("/index.xml");
    expect(rendered.artifacts.json.path).toBe("/index.json");
    expect(rendered.artifacts.html.contentType).toBe("text/html; charset=utf-8");
    expect(rendered.artifacts.xml.contentType).toBe("application/xml; charset=utf-8");
    expect(rendered.artifacts.json.contentType).toBe("application/json; charset=utf-8");
    await Promise.all(Object.values(rendered.artifacts).map(expectValidArtifact));

    const json = JSON.parse(rendered.artifacts.json.body) as Record<string, unknown>;
    expect(json).not.toHaveProperty("revision");
    expect(json.generation).toBe("42");
    expect(json.generatedAt).toBe(input.profile === "game-v1" ? String(GENERATED_AT) : GENERATED_AT);
    expect(json.expiresAt).toBe(input.profile === "game-v1" ? String(EXPIRES_AT) : EXPIRES_AT);
    expect(rendered.artifacts.html.body).not.toContain("Revision");
    expect(rendered.artifacts.xml.body).not.toContain(" revision=");
    expect(rendered.artifacts.xml.body).toContain(`generation="42"`);
    expect(rendered.artifacts.xml.body).toContain(`generated-at="${GENERATED_AT}"`);
    expect(rendered.artifacts.xml.body).toContain(`expires-at="${EXPIRES_AT}"`);
  });

  it("emits the exact canonical empty game JSON and protocol ETag", async () => {
    const artifact = (await renderDirectoryArtifacts(gameSnapshot())).artifacts.json;
    const expected =
      '{"schema":"atrinik-directory-v1","generation":"42",' +
      `"generatedAt":"${GENERATED_AT}","expiresAt":"${EXPIRES_AT}",` +
      '"servers":[]}\n';

    expect(artifact.body).toBe(expected);
    expect(artifact.strongEtag).toBe(
      `"atrinik-directory-v1-sha256-${await sha256Hex(new TextEncoder().encode(expected))}"`,
    );
  });

  it("matches the exact non-empty protocol JSON and XML conformance vectors", async () => {
    const firstId = "1".repeat(64);
    const secondId = "2".repeat(64);
    const input: GameDirectorySnapshot = {
      profile: "game-v1",
      revision: 101,
      generation: "42",
      generatedAt: 1_786_219_200,
      expiresAt: 1_786_233_600,
      servers: [
        gameServer(firstId, {
          name: 'Atrinik "Alpha"',
          description: "Cooperative Ω",
          region: "eu-west",
          protocol: { major: 1, minor: 0 },
          content: {
            id: "atrinik-main",
            revisionSha256: "a".repeat(64),
          },
          players: { online: 3, capacity: 64 },
          endpoint: { hostname: "xn--bcher-kva.example.org", port: 13_327 },
        }),
        gameServer(secondId, {
          name: "Beta",
          description: "",
          protocol: { major: 1, minor: 7 },
          content: {
            id: "atrinik-season-1",
            revisionSha256: "b".repeat(64),
          },
          players: { online: 64, capacity: 64 },
          status: "full",
          passwordRequired: true,
        }),
      ],
    };
    const rendered = await renderDirectoryArtifacts(input);
    const expectedJson = gameJsonFixture;
    const expectedXml = gameXmlFixture;

    expect(rendered.artifacts.json.body).toBe(expectedJson);
    expect(rendered.artifacts.xml.body).toBe(expectedXml);
    expect(rendered.artifacts.json.strongEtag).toBe(
      '"atrinik-directory-v1-sha256-' +
        '059f559d0fe439576cae10bd623eb79ab6dfd6d0a78420563730c07cf9727d78"',
    );
  });

  it.each([
    ["classic", classicSnapshot([
      classicServer(ID_B, { name: "zeta" }),
      classicServer(ID_A, { name: "alpha" }),
    ])],
    ["game", gameSnapshot([
      gameServer(ID_B, { name: "zeta" }),
      gameServer(ID_A, { name: "alpha" }),
    ])],
  ] as const)("sorts %s servers by raw identity without mutating input", async (_, input) => {
    const originalOrder = input.servers.map((server) => server.serverId);
    const first = await renderDirectoryArtifacts(input);
    const second = await renderDirectoryArtifacts(input);

    expect(input.servers.map((server) => server.serverId)).toEqual(originalOrder);
    expect(first.artifacts.json.body).toBe(second.artifacts.json.body);
    expect(first.artifacts.xml.body).toBe(second.artifacts.xml.body);
    expect(first.artifacts.html.body).toBe(second.artifacts.html.body);
    expect(first.artifacts.json.body.indexOf(ID_A)).toBeLessThan(
      first.artifacts.json.body.indexOf(ID_B),
    );
    expect(first.artifacts.xml.body.indexOf(ID_A)).toBeLessThan(
      first.artifacts.xml.body.indexOf(ID_B),
    );
  });

  it("escapes adversarial Unicode and markup without changing semantic values", async () => {
    const name = '雪 & <script>"\'x\'</script>';
    const description =
      'café <img onerror="alert(1)"> & \'quoted\' ' +
      '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///secret">]>&leak;';
    const rendered = await renderDirectoryArtifacts(gameSnapshot([
      gameServer(ID_A, { name, description }),
    ]));

    const parsed = JSON.parse(rendered.artifacts.json.body) as {
      servers: Array<{ name: string; description: string }>;
    };
    expect(parsed.servers[0]).toMatchObject({ name, description });
    expect(rendered.artifacts.html.body).not.toContain("<script>");
    expect(rendered.artifacts.html.body).not.toContain("<img");
    expect(rendered.artifacts.html.body).not.toContain("<!DOCTYPE");
    expect(rendered.artifacts.html.body).toContain(
      "雪 &amp; &lt;script&gt;&quot;&#39;x&#39;&lt;/script&gt;",
    );
    expect(rendered.artifacts.xml.body).not.toContain("<script>");
    expect(rendered.artifacts.xml.body).not.toContain("<img");
    expect(rendered.artifacts.xml.body).not.toContain("<!DOCTYPE");
    expect(rendered.artifacts.xml.body).toContain(
      "雪 &amp; &lt;script&gt;&quot;&apos;x&apos;&lt;/script&gt;",
    );
    expect(rendered.artifacts.html.body).toContain(
      "&lt;img onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(rendered.artifacts.xml.body).toContain("&lt;!DOCTYPE x");
  });

  it.each([
    ["C1", "\u0085"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
  ])("rejects the protocol-forbidden %s scalar", async (_, scalar) => {
    await expect(renderDirectoryArtifacts(gameSnapshot([
      gameServer(ID_A, { description: `before${scalar}after` }),
    ]))).rejects.toThrow("Invalid directory artifact model");
  });

  it("renders classic vNext XML without synthesizing an address", async () => {
    const rendered = await renderDirectoryArtifacts(classicSnapshot([
      classicServer(ID_A),
      classicServer(ID_B, {
        endpoint: { hostname: "play.example.net", port: 13_327 },
      }),
    ]));
    const xml = rendered.artifacts.xml.body;

    expect(xml).toContain('<Servers protocol="4" schema="atrinik-classic-directory-v4"');
    expect(xml.match(/<Server>/gu)).toHaveLength(2);
    expect(xml.match(/<Address>/gu)).toHaveLength(1);
    expect(xml.match(/<Port>/gu)).toHaveLength(1);
    expect(xml).toContain("<Address>play.example.net</Address>");
    expect(rendered.artifacts.html.body).toContain("not published");
  });

  it("matches the committed classic-v4 JSON and XML fixtures", async () => {
    const input = classicSnapshot([
      classicServer(ID_A),
      classicServer(ID_B, {
        name: "Public fallback",
        playersCount: 4_294_967_295,
        textComment: "",
        passwordRequired: true,
        endpoint: { hostname: "play.example.net", port: 13_327 },
      }),
    ]);
    const rendered = await renderDirectoryArtifacts(input);
    expect(rendered.artifacts.json.body).toBe(classicJsonFixture);
    expect(rendered.artifacts.xml.body).toBe(classicXmlFixture);
  });

  it.each([
    ["classic", classicSnapshot(Array.from({ length: 512 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      return classicServer(id, { name: "S", version: "1", textComment: "" });
    }))],
    ["game", gameSnapshot(Array.from({ length: 512 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      return gameServer(id, { name: "S", description: "" });
    }))],
  ] as const)("accepts the maximum bounded %s server count", async (_, input) => {
    const rendered = await renderDirectoryArtifacts(input);
    expect(rendered.serverCount).toBe(512);
    expect(rendered.artifacts.json.byteLength).toBeLessThanOrEqual(
      input.profile === "game-v1"
        ? MAX_GAME_DIRECTORY_JSON_BYTES
        : MAX_CLASSIC_DIRECTORY_ARTIFACT_BYTES,
    );
    expect(rendered.artifacts.html.byteLength).toBeLessThanOrEqual(
      input.profile === "game-v1"
        ? MAX_GAME_DIRECTORY_PROJECTION_BYTES
        : MAX_CLASSIC_DIRECTORY_ARTIFACT_BYTES,
    );
    expect(rendered.artifacts.xml.byteLength).toBeLessThanOrEqual(
      input.profile === "game-v1"
        ? MAX_GAME_DIRECTORY_PROJECTION_BYTES
        : MAX_CLASSIC_DIRECTORY_ARTIFACT_BYTES,
    );
  });

  it("accepts maximum-byte Unicode fields and rejects one byte over", async () => {
    await expect(renderDirectoryArtifacts(gameSnapshot([
      gameServer(ID_A, {
        name: "é".repeat(40),
        description: "界".repeat(170),
      }),
    ]))).resolves.toMatchObject({ serverCount: 1 });

    await expect(renderDirectoryArtifacts(gameSnapshot([
      gameServer(ID_A, { name: "é".repeat(41) }),
    ]))).rejects.toThrow("Invalid directory artifact model");
  });

  it("accepts every game field at its individual maximum", async () => {
    const maximumHostname = [63, 63, 63, 61]
      .map((length) => "a".repeat(length))
      .join(".");
    expect(new TextEncoder().encode(maximumHostname)).toHaveLength(253);
    const input: GameDirectorySnapshot = {
      profile: "game-v1",
      revision: Number.MAX_SAFE_INTEGER,
      generation: "18446744073709551615",
      generatedAt: 253_402_286_399,
      expiresAt: 253_402_300_799,
      servers: [gameServer(ID_A, {
        name: "é".repeat(40),
        description: "é".repeat(256),
        region: `a${"-".repeat(30)}z`,
        protocol: { major: 1, minor: 65_535 },
        content: {
          id: `a${".".repeat(62)}z`,
          revisionSha256: "f".repeat(64),
        },
        players: { online: 100_000, capacity: 100_000 },
        status: "full",
        endpoint: { hostname: maximumHostname, port: 65_535 },
      })],
    };

    await expect(renderDirectoryArtifacts(input)).resolves.toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      generation: "18446744073709551615",
      serverCount: 1,
    });
  });

  it("accepts the classic publisher uint32 player maximum", async () => {
    const rendered = await renderDirectoryArtifacts(classicSnapshot([
      classicServer(ID_A, { playersCount: 4_294_967_295 }),
    ]));
    expect(rendered.artifacts.xml.body).toContain(
      "<PlayersCount>4294967295</PlayersCount>",
    );
  });

  it("enforces the canonical game JSON body cap on a valid maximum composite", async () => {
    const maximumServers = Array.from({ length: 512 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      return gameServer(id, {
        name: "n".repeat(80),
        description: "é".repeat(256),
        region: `a${"-".repeat(30)}z`,
        content: {
          id: `a${".".repeat(62)}z`,
          revisionSha256: "f".repeat(64),
        },
      });
    });

    await expect(renderDirectoryArtifacts(gameSnapshot(maximumServers))).rejects.toThrow(
      "Directory artifact exceeds its byte limit",
    );
  });

  it.each([
    ["classic player count", classicSnapshot([
      classicServer(ID_A, { playersCount: 4_294_967_296 }),
    ])],
    ["game protocol", gameSnapshot([
      gameServer(ID_A, { protocol: { major: 1, minor: 65_536 } }),
    ])],
    ["game description", gameSnapshot([
      gameServer(ID_A, { description: "a".repeat(513) }),
    ])],
    ["game region", gameSnapshot([
      gameServer(ID_A, { region: "a".repeat(33) }),
    ])],
    ["game content ID", gameSnapshot([
      gameServer(ID_A, { content: {
        id: "a".repeat(65),
        revisionSha256: "f".repeat(64),
      } }),
    ])],
    ["game capacity", gameSnapshot([
      gameServer(ID_A, { players: { online: 0, capacity: 100_001 } }),
    ])],
    ["endpoint port", gameSnapshot([
      gameServer(ID_A, { endpoint: { hostname: "play.example.net", port: 65_536 } }),
    ])],
    ["endpoint label", gameSnapshot([
      gameServer(ID_A, {
        endpoint: { hostname: `${"a".repeat(64)}.example`, port: 13_327 },
      }),
    ])],
  ] as const)("rejects an overflowing %s", async (_, input) => {
    await expect(renderDirectoryArtifacts(input)).rejects.toThrow(
      "Invalid directory artifact model",
    );
  });

  it("rejects overflow server counts before rendering", async () => {
    const servers = Array.from({ length: 513 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      return classicServer(id);
    });
    await expect(renderDirectoryArtifacts(classicSnapshot(servers))).rejects.toThrow(
      "Invalid directory artifact model: servers",
    );
  });

  it.each([
    { generation: "01" },
    { generation: "18446744073709551616" },
    { generatedAt: -1 },
    { expiresAt: GENERATED_AT },
    { expiresAt: GENERATED_AT + MAX_DIRECTORY_LIFETIME_SECONDS + 1 },
  ])("rejects invalid generation metadata %#", async (override) => {
    const input = { ...gameSnapshot(), ...override } as GameDirectorySnapshot;
    await expect(renderDirectoryArtifacts(input)).rejects.toThrow(
      "Invalid directory artifact model",
    );
  });

  it("rejects duplicate identities and inconsistent game status", async () => {
    await expect(renderDirectoryArtifacts(gameSnapshot([
      gameServer(ID_A),
      gameServer(ID_A),
    ]))).rejects.toThrow("duplicate server identity");
    await expect(renderDirectoryArtifacts(gameSnapshot([
      gameServer(ID_A, {
        players: { online: 20, capacity: 20 },
        status: "online",
      }),
    ]))).rejects.toThrow("game server 0 status");
  });

  it("rejects forbidden public and private fields at every model level", async () => {
    const forbiddenModels: unknown[] = [
      { ...gameSnapshot(), sourceIp: "192.0.2.1" },
      gameSnapshot([{ ...gameServer(), publisherCredential: "secret" } as GameDirectoryServer]),
      gameSnapshot([{
        ...gameServer(),
        endpoint: {
          hostname: "play.example.net",
          port: 13_327,
          candidate: "192.0.2.1:13327",
        },
      } as GameDirectoryServer]),
      gameSnapshot([{
        ...gameServer(),
        players: { online: 0, capacity: 20, names: ["player"] },
      } as GameDirectoryServer]),
    ];

    for (const input of forbiddenModels) {
      await expect(renderDirectoryArtifacts(input as DirectorySnapshot)).rejects.toThrow(
        "Invalid directory artifact model",
      );
    }
  });

  it("rejects accessor-backed models without executing the accessor", async () => {
    let accessed = false;
    const input = { ...gameSnapshot() } as Record<string, unknown>;
    Object.defineProperty(input, "generation", {
      enumerable: true,
      get() {
        accessed = true;
        return "42";
      },
    });

    await expect(renderDirectoryArtifacts(input as unknown as DirectorySnapshot))
      .rejects.toThrow("Invalid directory artifact model");
    expect(accessed).toBe(false);
  });

  it.each([
    "192.0.2.1",
    "2130706433",
    "PLAY.example.net",
    "xn--a.example.org",
  ])("rejects an unsafe explicit endpoint hostname: %s", async (hostname) => {
    await expect(renderDirectoryArtifacts(gameSnapshot([
      gameServer(ID_A, { endpoint: { hostname, port: 13_327 } }),
    ]))).rejects.toThrow("Invalid directory artifact model");
  });
});
