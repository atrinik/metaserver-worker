import { DurableObject } from "cloudflare:workers";

import type { CoreEnv } from "./core-env";

import {
  DIRECTORY_ARTIFACT_POLICY_MAXIMUMS,
  directoryArtifactConfiguration,
} from "./config";
import {
  commitDirectoryArtifactPublication,
  DIRECTORY_PROFILES,
  expireDirectoryEntries,
  MAX_DIRECTORY_ENTRIES_PER_PROFILE,
  readDirectoryArtifactHistory,
  readDirectoryArtifactPublication,
  readDirectoryRevision,
} from "./directory-state";
import type {
  DirectoryArtifactPublication,
  DirectoryProfile,
} from "./directory-state";
import { writeDirectoryBuildMetric } from "./directory-metrics";
import type { DirectoryBuildOutcome } from "./directory-metrics";
import {
  CLASSIC_DIRECTORY_SCHEMA,
  GAME_DIRECTORY_SCHEMA,
  gameDirectoryServerJsonByteLength,
  renderDirectoryArtifacts,
} from "./directory-artifacts";
import type {
  ClassicDirectoryServer,
  DirectoryArtifactDescriptor,
  DirectorySnapshot,
  GameDirectoryServer,
  RenderedDirectoryGeneration,
} from "./directory-artifacts";
import { sha256Hex } from "./protocol";

const BUILDER_STATE_KEY = "directory-builder:state:v1";
const BUILDER_NUDGE_KEY = "directory-builder:nudge:v1";
const BUILDER_STATE_VERSION = 1;
const MANIFEST_SCHEMA = "atrinik-directory-manifest-v1";
const MAX_BUILD_COALESCE_ATTEMPTS = 4;
const MIN_ALIAS_PUBLICATION_LIFETIME_SECONDS =
  DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.minimumAliasPublicationLifetimeSeconds;
const PUBLIC_EXPIRY_QUANTUM_SECONDS =
  DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.expiryQuantumSeconds;
const MAX_IMMUTABLE_DELETES_PER_RECONCILIATION = 64;
const MAX_R2_LIST_CURSOR_BYTES = 4_096;
const IMMUTABLE_GENERATION_FILENAMES = Object.freeze([
  "index.html",
  "index.json",
  "index.xml",
  "manifest.json",
] as const);
const TEXT_ENCODER = new TextEncoder();
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;

interface DirectoryEntryRecord {
  readonly server_id: string;
  readonly name: string;
  readonly players_count: number | null;
  readonly version: string | null;
  readonly text_comment: string | null;
  readonly description: string | null;
  readonly region: string | null;
  readonly protocol_major: number | null;
  readonly protocol_minor: number | null;
  readonly content_id: string | null;
  readonly content_revision_sha256: string | null;
  readonly players_online: number | null;
  readonly players_capacity: number | null;
  readonly status: string | null;
  readonly game_json_bytes: number | null;
  readonly hostname: string | null;
  readonly port: number | null;
  readonly quic_cert_sha256: string;
  readonly password_required: number;
  readonly last_seen: number;
}

interface PendingBuild {
  readonly token: string;
  readonly revision: number;
  readonly generation: number;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly modelSha256: string;
}

interface BuilderState {
  readonly version: 1;
  readonly highWaterGeneration: number;
  readonly pending: PendingBuild | null;
  readonly cleanupCursor: string | null;
}

interface DirectoryModelBase {
  readonly revision: number;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly modelSha256: string;
  readonly hasPendingOutbox: boolean;
}

type DirectoryModel = DirectoryModelBase & (
  | {
      readonly profile: "classic-v1";
      readonly servers: readonly ClassicDirectoryServer[];
    }
  | {
      readonly profile: "game-v1";
      readonly servers: readonly GameDirectoryServer[];
    }
);

interface ManifestArtifact {
  readonly path: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly strongEtag: string;
}

interface RenderedObject {
  readonly format: "html" | "json" | "manifest" | "xml";
  readonly path: string;
  readonly contentType: string;
  readonly bodyBytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
  readonly strongEtag: string;
}

interface RetentionResult {
  readonly deleted: number;
  readonly deferred: boolean;
}

interface RetentionSweepResult extends RetentionResult {
  readonly nextCursor: string | null;
}

export interface DirectoryBuildResult {
  readonly profile: DirectoryProfile;
  readonly outcome: "current" | "published";
  readonly generation: number;
  readonly revision: number;
}

class SupersededBuildError extends Error {}
class ImmutableGenerationConflictError extends Error {}
class DirectoryObjectConflictError extends Error {}

/**
 * One private, profile-named object serializes static directory publication.
 * D1 revisions/outbox remain authoritative; the object only persists bounded
 * retry intent across R2 awaits, alarms, hibernation, and deployment.
 */
export class DirectoryBuilder extends DurableObject<CoreEnv> {
  private readonly initialized: Promise<void>;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      directoryProfile(ctx.id.name);
      const existing = await ctx.storage.get<unknown>(BUILDER_STATE_KEY);
      if (existing === undefined) {
        await ctx.storage.put(BUILDER_STATE_KEY, initialBuilderState());
      } else {
        exactBuilderState(existing);
      }
    });
  }

  async reconcile(): Promise<DirectoryBuildResult> {
    const startedAt = Date.now();
    const profile = directoryProfile(this.ctx.id.name);
    let retention: RetentionResult = { deleted: 0, deferred: false };
    try {
      const result = await this.serialize(async () => {
        await this.initialized;
        await this.ctx.storage.delete(BUILDER_NUDGE_KEY);
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        try {
          return await this.reconcileNow(Math.floor(Date.now() / 1_000));
        } finally {
          retention = await this.pruneImmutableGenerations(profile);
          await this.honorConcurrentNudge();
        }
      });
      this.recordMetric(profile, result.outcome, startedAt, retention);
      return result;
    } catch (error) {
      this.recordMetric(profile, "failed", startedAt, retention);
      throw error;
    }
  }

  /** Coalesce visible state changes into the single persistent alarm. */
  async nudge(): Promise<void> {
    await this.initialized;
    await this.ctx.storage.put(BUILDER_NUDGE_KEY, true);
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  async alarm(): Promise<void> {
    const startedAt = Date.now();
    const profile = directoryProfile(this.ctx.id.name);
    let retention: RetentionResult = { deleted: 0, deferred: false };
    try {
      const result = await this.serialize(async () => {
        await this.initialized;
        await this.ctx.storage.delete(BUILDER_NUDGE_KEY);
        try {
          return await this.reconcileNow(Math.floor(Date.now() / 1_000));
        } finally {
          retention = await this.pruneImmutableGenerations(profile);
          await this.honorConcurrentNudge();
        }
      });
      this.recordMetric(profile, result.outcome, startedAt, retention);
    } catch (error) {
      this.recordMetric(profile, "failed", startedAt, retention);
      throw error;
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async reconcileNow(now: number): Promise<DirectoryBuildResult> {
    const profile = directoryProfile(this.ctx.id.name);
    const configuration = directoryArtifactConfiguration(this.env);
    await expireDirectoryEntries(
      this.env.DB,
      profile,
      directoryExpiryCutoff(now, configuration.listingTtlSeconds),
      now,
    );

    for (let attempt = 0; attempt < MAX_BUILD_COALESCE_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.buildCurrent(profile, now);
        return result;
      } catch (error) {
        if (!(error instanceof SupersededBuildError)) {
          throw error;
        }
      }
    }
    throw new Error("Directory build changed too frequently to converge");
  }

  private async buildCurrent(
    profile: DirectoryProfile,
    now: number,
  ): Promise<DirectoryBuildResult> {
    const configuration = directoryArtifactConfiguration(this.env);
    const [model, checkpoint] = await Promise.all([
      this.readModel(
        profile,
        now,
        configuration.listingTtlSeconds,
        configuration.artifactLifetimeSeconds,
      ),
      readDirectoryArtifactPublication(this.env.DB, profile),
    ]);
    if (model.revision < checkpoint.publishedRevision) {
      throw new Error("Directory revision regressed behind its publication");
    }

    if (
      checkpoint.generation > 0 &&
      model.revision === checkpoint.publishedRevision &&
      model.modelSha256 !== checkpoint.modelSha256
    ) {
      throw new Error("Directory model changed without a visible revision");
    }
    await this.rememberCommittedCheckpoint(checkpoint);

    const revisionChanged = model.revision > checkpoint.publishedRevision;
    const refreshDue = checkpoint.generation === 0 ||
      now >= checkpoint.expiresAt - configuration.refreshLeadSeconds;
    const leaseExtended = model.expiresAt > checkpoint.expiresAt;
    const publicBucket = profile === "classic-v1"
      ? this.env.CLASSIC_DIRECTORY_PUBLIC
      : this.env.GAME_DIRECTORY_PUBLIC;
    if (!revisionChanged && checkpoint.generation > 0 &&
      (!refreshDue || !leaseExtended)) {
      const aliasesCurrent = await publishedAliasesMatch(
        publicBucket,
        profile,
        checkpoint,
      );
      if (!aliasesCurrent) {
        // A missing or corrupt alias is repaired under a new generation. The
        // same generation identifier is never assigned different bytes.
      } else {
        const latest = await readDirectoryRevision(this.env.DB, profile);
        if (latest.revision !== model.revision) {
          throw new SupersededBuildError();
        }
        if (model.hasPendingOutbox) {
          await commitDirectoryArtifactPublication(this.env.DB, {
            profile,
            ...checkpoint,
          });
        }
        await this.clearCommittedPending(checkpoint);
        await this.scheduleAlarm(
          refreshDue ? checkpoint.expiresAt :
            checkpoint.expiresAt - configuration.refreshLeadSeconds,
          now,
        );
        return Object.freeze({
          profile,
          outcome: "current",
          generation: checkpoint.generation,
          revision: checkpoint.publishedRevision,
        });
      }
    }

    const observedGeneration = await readPublicGeneration(publicBucket);
    const pending = await this.reserveBuild(
      profile,
      model,
      checkpoint,
      observedGeneration,
      now,
    );
    const snapshot = directorySnapshot(profile, model, pending);
    const rendered = await renderDirectoryArtifacts(snapshot);
    await this.assertPending(pending);

    const objects = await renderedObjects(rendered);
    try {
      for (const object of objects) {
        await putImmutableGeneration(
          this.env.DIRECTORY_GENERATIONS,
          immutableObjectKey(profile, pending.generation, object.path),
          object,
          profile,
          pending,
        );
        await this.assertPending(pending);
      }
    } catch (error) {
      if (error instanceof ImmutableGenerationConflictError) {
        await this.abandonPending(pending);
        throw new SupersededBuildError();
      }
      throw error;
    }

    const currentRevision = await readDirectoryRevision(this.env.DB, profile);
    if (currentRevision.revision !== pending.revision) {
      await this.abandonPending(pending);
      throw new SupersededBuildError();
    }
    const aliasStart = Math.floor(Date.now() / 1_000);
    if (
      aliasStart + MIN_ALIAS_PUBLICATION_LIFETIME_SECONDS >= pending.expiresAt
    ) {
      await this.abandonPending(pending);
      await this.scheduleAlarm(pending.expiresAt + 1, aliasStart);
      return Object.freeze({
        profile,
        outcome: "current",
        generation: checkpoint.generation,
        revision: checkpoint.publishedRevision,
      });
    }

    try {
      const ordered = aliasPublicationOrder(profile, objects);
      for (const object of ordered) {
        await this.assertFresh(pending);
        await putPublicAlias(
          publicBucket,
          object.path.slice(1),
          object,
          profile,
          pending,
        );
        await this.assertPending(pending);
      }
      await verifyPublishedObjects(publicBucket, objects, profile, pending);
      await this.assertPending(pending);
    } catch (error) {
      if (error instanceof DirectoryObjectConflictError) {
        await this.abandonPending(pending);
        throw new SupersededBuildError();
      }
      throw error;
    }
    const verifiedRevision = await readDirectoryRevision(this.env.DB, profile);
    if (verifiedRevision.revision !== pending.revision) {
      await this.abandonPending(pending);
      throw new SupersededBuildError();
    }

    const publishedAt = Math.max(
      pending.generatedAt,
      Math.floor(Date.now() / 1_000),
    );
    if (publishedAt >= pending.expiresAt) {
      await this.abandonPending(pending);
      throw new Error("Directory build expired before it could commit");
    }
    const manifest = objects.find((object) => object.format === "manifest");
    if (manifest === undefined) {
      throw new Error("Directory build omitted its manifest");
    }
    const commit = {
      profile,
      publishedRevision: pending.revision,
      generation: pending.generation,
      generatedAt: pending.generatedAt,
      expiresAt: pending.expiresAt,
      modelSha256: pending.modelSha256,
      htmlSha256: rendered.artifacts.html.sha256,
      xmlSha256: rendered.artifacts.xml.sha256,
      jsonSha256: rendered.artifacts.json.sha256,
      manifestSha256: manifest.sha256,
      htmlBytes: rendered.artifacts.html.byteLength,
      xmlBytes: rendered.artifacts.xml.byteLength,
      jsonBytes: rendered.artifacts.json.byteLength,
      manifestBytes: manifest.byteLength,
      publishedAt,
    } as const;
    try {
      await commitDirectoryArtifactPublication(this.env.DB, commit);
    } catch (error) {
      const persisted = await readDirectoryArtifactPublication(
        this.env.DB,
        profile,
      );
      if (!artifactPublicationMatches(persisted, commit)) {
        const latestRevision = await readDirectoryRevision(this.env.DB, profile);
        if (latestRevision.revision > pending.revision) {
          await this.abandonPending(pending);
          throw new SupersededBuildError();
        }
        throw error;
      }
    }

    await this.completePending(pending);
    const latest = await readDirectoryRevision(this.env.DB, profile);
    await this.scheduleAlarm(
      latest.revision > pending.revision
        ? now + 1
        : pending.expiresAt - configuration.refreshLeadSeconds,
      now,
    );
    return Object.freeze({
      profile,
      outcome: "published",
      generation: pending.generation,
      revision: pending.revision,
    });
  }

  private async readModel(
    profile: DirectoryProfile,
    generatedAt: number,
    listingTtlSeconds: number,
    artifactLifetimeSeconds: number,
  ): Promise<DirectoryModel> {
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `SELECT revision, updated_at FROM directory_revisions
          WHERE profile = ?`,
      ).bind(profile),
      this.env.DB.prepare(
        `SELECT entries.server_id, entries.name, entries.players_count,
                entries.version, entries.text_comment, entries.description,
                entries.region, entries.protocol_major, entries.protocol_minor,
                entries.content_id, entries.content_revision_sha256,
                entries.players_online, entries.players_capacity, entries.status,
                entries.game_json_bytes, entries.hostname,
                entries.port, entries.quic_cert_sha256,
                entries.password_required, presence.last_seen
           FROM directory_entries AS entries
           JOIN server_presence AS presence
             ON presence.profile = entries.profile
            AND presence.server_id = entries.server_id
          WHERE entries.profile = ?
          ORDER BY entries.server_id`,
      ).bind(profile),
      this.env.DB.prepare(
        `SELECT count(*) AS pending FROM directory_outbox
          WHERE profile = ?`,
      ).bind(profile),
    ]);
    if (
      results.length !== 3 || results.some((result) => !result.success) ||
      results[0].results.length !== 1 ||
      results[1].results.length > MAX_DIRECTORY_ENTRIES_PER_PROFILE ||
      results[2].results.length !== 1
    ) {
      throw new Error("Directory snapshot query returned invalid state");
    }
    const revisionRecord = results[0].results[0] as {
      revision?: unknown;
      updated_at?: unknown;
    };
    if (
      !Number.isSafeInteger(revisionRecord.revision) ||
      (revisionRecord.revision as number) < 0 ||
      !Number.isSafeInteger(revisionRecord.updated_at) ||
      (revisionRecord.updated_at as number) < 0
    ) {
      throw new Error("Directory snapshot revision is invalid");
    }
    const rows = results[1].results as unknown as DirectoryEntryRecord[];
    const pendingOutbox = (results[2].results[0] as { pending?: unknown }).pending;
    if (!Number.isSafeInteger(pendingOutbox) || (pendingOutbox as number) < 0) {
      throw new Error("Directory outbox state is invalid");
    }
    const modelGeneratedAt = Math.max(
      generatedAt,
      revisionRecord.updated_at as number,
    );
    let expiresAt = modelGeneratedAt + artifactLifetimeSeconds;
    const servers = profile === "classic-v1"
      ? rows.map((row) => {
        if (!Number.isSafeInteger(row.last_seen) || row.last_seen < 0) {
          throw new Error("Directory presence timestamp is invalid");
        }
        expiresAt = Math.min(expiresAt, row.last_seen + listingTtlSeconds);
        const endpoint = row.hostname === null && row.port === null
          ? {}
          : { endpoint: { hostname: row.hostname, port: row.port } };
        return {
          serverId: row.server_id,
          name: row.name,
          playersCount: row.players_count,
          version: row.version,
          textComment: row.text_comment,
          certificateSha256: row.quic_cert_sha256,
          passwordRequired: row.password_required === 1,
          ...endpoint,
        } as ClassicDirectoryServer;
      })
      : rows.map((row) => {
        if (!Number.isSafeInteger(row.last_seen) || row.last_seen < 0) {
          throw new Error("Directory presence timestamp is invalid");
        }
        expiresAt = Math.min(expiresAt, row.last_seen + listingTtlSeconds);
        const endpoint = row.hostname === null && row.port === null
          ? {}
          : { endpoint: { hostname: row.hostname, port: row.port } };
        const server = {
          serverId: row.server_id,
          certificateSha256: row.quic_cert_sha256,
          name: row.name,
          description: row.description,
          ...(row.region === null ? {} : { region: row.region }),
          protocol: {
            major: row.protocol_major,
            minor: row.protocol_minor,
          },
          content: {
            id: row.content_id,
            revisionSha256: row.content_revision_sha256,
          },
          players: {
            online: row.players_online,
            capacity: row.players_capacity,
          },
          status: row.status,
          passwordRequired: row.password_required === 1,
          ...endpoint,
        } as GameDirectoryServer;
        if (
          !Number.isSafeInteger(row.game_json_bytes) ||
          row.game_json_bytes !== gameDirectoryServerJsonByteLength(server)
        ) {
          throw new Error("Game directory JSON accounting is invalid");
        }
        return server;
      });
    expiresAt = Math.floor(expiresAt / PUBLIC_EXPIRY_QUANTUM_SECONDS) *
      PUBLIC_EXPIRY_QUANTUM_SECONDS;
    if (expiresAt <= modelGeneratedAt) {
      throw new Error("Directory snapshot contains expired presence");
    }
    const modelSha256 = await sha256Hex(JSON.stringify({ profile, servers }));
    const model = {
      revision: revisionRecord.revision as number,
      generatedAt: modelGeneratedAt,
      expiresAt,
      modelSha256,
      hasPendingOutbox: (pendingOutbox as number) > 0,
    } as const;
    return profile === "classic-v1"
      ? Object.freeze({
          ...model,
          profile,
          servers: Object.freeze(servers as ClassicDirectoryServer[]),
        })
      : Object.freeze({
          ...model,
          profile,
          servers: Object.freeze(servers as GameDirectoryServer[]),
        });
  }

  private async reserveBuild(
    _profile: DirectoryProfile,
    model: DirectoryModel,
    checkpoint: DirectoryArtifactPublication,
    publicGeneration: number,
    now: number,
  ): Promise<PendingBuild> {
    const state = exactBuilderState(
      await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
    );
    if (
      state.pending !== null &&
      state.pending.revision === model.revision &&
      state.pending.modelSha256 === model.modelSha256 &&
      model.expiresAt >= state.pending.expiresAt &&
      state.pending.expiresAt > now &&
      state.pending.generation > checkpoint.generation &&
      state.pending.generation >= publicGeneration
    ) {
      return state.pending;
    }
    const generation = Math.max(
      state.highWaterGeneration,
      checkpoint.generation,
      publicGeneration,
    ) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error("Directory artifact generation exhausted");
    }
    const pending = Object.freeze({
      token: randomToken(),
      revision: model.revision,
      generation,
      generatedAt: model.generatedAt,
      expiresAt: model.expiresAt,
      modelSha256: model.modelSha256,
    });
    await this.ctx.storage.put(BUILDER_STATE_KEY, {
      version: BUILDER_STATE_VERSION,
      highWaterGeneration: generation,
      pending,
      cleanupCursor: state.cleanupCursor,
    } satisfies BuilderState);
    return pending;
  }

  private async assertPending(pending: PendingBuild): Promise<void> {
    const state = exactBuilderState(
      await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
    );
    if (state.pending?.token !== pending.token) {
      throw new SupersededBuildError();
    }
  }

  private async assertFresh(pending: PendingBuild): Promise<void> {
    await this.assertPending(pending);
    if (
      Math.floor(Date.now() / 1_000) +
          MIN_ALIAS_PUBLICATION_LIFETIME_SECONDS >= pending.expiresAt
    ) {
      await this.abandonPending(pending);
      throw new Error("Directory build expired before alias publication");
    }
  }

  private async abandonPending(pending: PendingBuild): Promise<void> {
    const state = exactBuilderState(
      await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
    );
    if (state.pending?.token === pending.token) {
      await this.ctx.storage.put(BUILDER_STATE_KEY, {
        ...state,
        pending: null,
      } satisfies BuilderState);
    }
  }

  private async completePending(pending: PendingBuild): Promise<void> {
    const state = exactBuilderState(
      await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
    );
    if (state.pending?.token !== pending.token) {
      throw new Error("Directory build lost its durable completion state");
    }
    await this.ctx.storage.put(BUILDER_STATE_KEY, {
      ...state,
      pending: null,
    } satisfies BuilderState);
  }

  private async rememberCommittedCheckpoint(
    checkpoint: DirectoryArtifactPublication,
  ): Promise<void> {
    if (checkpoint.generation === 0) {
      return;
    }
    const state = exactBuilderState(
      await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
    );
    if (state.highWaterGeneration >= checkpoint.generation) {
      return;
    }
    await this.ctx.storage.put(BUILDER_STATE_KEY, {
      ...state,
      highWaterGeneration: Math.max(
        state.highWaterGeneration,
        checkpoint.generation,
      ),
    } satisfies BuilderState);
  }

  private async clearCommittedPending(
    checkpoint: DirectoryArtifactPublication,
  ): Promise<void> {
    const state = exactBuilderState(
      await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
    );
    if (
      state.pending !== null &&
      state.pending.generation === checkpoint.generation &&
      state.pending.revision === checkpoint.publishedRevision &&
      state.pending.modelSha256 === checkpoint.modelSha256
    ) {
      await this.ctx.storage.put(BUILDER_STATE_KEY, {
        ...state,
        pending: null,
      } satisfies BuilderState);
    }
  }

  private async scheduleAlarm(atSeconds: number, now: number): Promise<void> {
    const bounded = Math.max(now + 1, Math.floor(atSeconds));
    await this.ctx.storage.setAlarm(bounded * 1_000);
  }

  private async honorConcurrentNudge(): Promise<void> {
    if (await this.ctx.storage.get<unknown>(BUILDER_NUDGE_KEY) === true) {
      await this.ctx.storage.setAlarm(Date.now() + 1);
    }
  }

  private async pruneImmutableGenerations(
    profile: DirectoryProfile,
  ): Promise<RetentionResult> {
    let state: BuilderState | null = null;
    try {
      state = exactBuilderState(
        await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
      );
      const [checkpoint, acknowledgedGenerations] = await Promise.all([
        readDirectoryArtifactPublication(this.env.DB, profile),
        readDirectoryArtifactHistory(this.env.DB, profile),
      ]);
      const retained = new Set(acknowledgedGenerations);
      if (checkpoint.generation > 0) {
        retained.add(checkpoint.generation);
      }
      if (state.pending !== null) {
        retained.add(state.pending.generation);
      }
      const result = await pruneImmutableGenerationPage(
        this.env.DIRECTORY_GENERATIONS,
        profile,
        retained,
        state.cleanupCursor,
      );
      const current = exactBuilderState(
        await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
      );
      await this.ctx.storage.put(BUILDER_STATE_KEY, {
        ...current,
        cleanupCursor: result.nextCursor,
      } satisfies BuilderState);
      return result;
    } catch {
      if (state?.cleanupCursor !== null && state?.cleanupCursor !== undefined) {
        try {
          const current = exactBuilderState(
            await this.ctx.storage.get<unknown>(BUILDER_STATE_KEY),
          );
          if (current.cleanupCursor === state.cleanupCursor) {
            await this.ctx.storage.put(BUILDER_STATE_KEY, {
              ...current,
              cleanupCursor: null,
            } satisfies BuilderState);
          }
        } catch {
          // Retention is non-authoritative and will be retried by lifecycle.
        }
      }
      return { deleted: 0, deferred: true };
    }
  }

  private recordMetric(
    profile: DirectoryProfile,
    outcome: DirectoryBuildOutcome,
    startedAt: number,
    retention: RetentionResult,
  ): void {
    try {
      writeDirectoryBuildMetric(this.env.DIRECTORY_METRICS, {
        profile,
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt),
        cleanupDeleted: retention.deleted,
        cleanupDeferred: retention.deferred,
      });
    } catch {
      // Observability is deliberately non-authoritative. A metrics outage must
      // not alter alias publication, retries, or durable checkpoints.
    }
  }
}

function directoryProfile(value: string | undefined): DirectoryProfile {
  if (value === undefined || !DIRECTORY_PROFILES.includes(
    value as DirectoryProfile,
  )) {
    throw new Error("Directory builder identity is invalid");
  }
  return value as DirectoryProfile;
}

function directoryExpiryCutoff(now: number, listingTtlSeconds: number): number {
  const nextBoundary = (Math.floor(now / PUBLIC_EXPIRY_QUANTUM_SECONDS) + 1) *
    PUBLIC_EXPIRY_QUANTUM_SECONDS;
  if (!Number.isSafeInteger(nextBoundary)) {
    throw new Error("Directory expiry boundary is invalid");
  }
  return Math.max(0, nextBoundary - 1 - listingTtlSeconds);
}

function initialBuilderState(): BuilderState {
  return Object.freeze({
    version: BUILDER_STATE_VERSION,
    highWaterGeneration: 0,
    pending: null,
    cleanupCursor: null,
  });
}

function exactBuilderState(value: unknown): BuilderState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Directory builder state is invalid");
  }
  const state = value as Partial<BuilderState>;
  if (
    state.version !== BUILDER_STATE_VERSION ||
    !Number.isSafeInteger(state.highWaterGeneration) ||
    (state.highWaterGeneration as number) < 0 ||
    (state.pending !== null && !isPendingBuild(state.pending)) ||
    (isPendingBuild(state.pending) &&
      state.pending.generation > (state.highWaterGeneration as number)) ||
    !isCleanupCursor(state.cleanupCursor)
  ) {
    throw new Error("Directory builder state is invalid");
  }
  return state as BuilderState;
}

function isCleanupCursor(value: unknown): value is string | null {
  return value === null ||
    (typeof value === "string" && value.length > 0 &&
      TEXT_ENCODER.encode(value).byteLength <= MAX_R2_LIST_CURSOR_BYTES);
}

function isPendingBuild(value: unknown): value is PendingBuild {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const pending = value as Partial<PendingBuild>;
  return typeof pending.token === "string" && SHA256_HEX.test(pending.token) &&
    Number.isSafeInteger(pending.revision) && (pending.revision as number) >= 0 &&
    Number.isSafeInteger(pending.generation) &&
    (pending.generation as number) >= 1 &&
    Number.isSafeInteger(pending.generatedAt) &&
    (pending.generatedAt as number) >= 0 &&
    Number.isSafeInteger(pending.expiresAt) &&
    (pending.expiresAt as number) > (pending.generatedAt as number) &&
    typeof pending.modelSha256 === "string" &&
    SHA256_HEX.test(pending.modelSha256);
}

function directorySnapshot(
  profile: DirectoryProfile,
  model: DirectoryModel,
  pending: PendingBuild,
): DirectorySnapshot {
  if (profile === "classic-v1") {
    if (model.profile !== profile) {
      throw new Error("Directory model profile is invalid");
    }
    return {
      profile,
      revision: model.revision,
      generation: String(pending.generation),
      generatedAt: pending.generatedAt,
      expiresAt: pending.expiresAt,
      servers: model.servers,
    };
  }
  if (model.profile !== profile) {
    throw new Error("Directory model profile is invalid");
  }
  return {
    profile,
    revision: model.revision,
    generation: String(pending.generation),
    generatedAt: pending.generatedAt,
    expiresAt: pending.expiresAt,
    servers: model.servers,
  };
}

async function readPublicGeneration(bucket: R2Bucket): Promise<number> {
  const heads = await Promise.all(
    ["index.html", "index.xml", "index.json", "manifest.json"].map((key) =>
      bucket.head(key)
    ),
  );
  return heads.reduce(
    (maximum, head) => Math.max(
      maximum,
      head === null ? 0 : observedGeneration(head.customMetadata),
    ),
    0,
  );
}

async function publishedAliasesMatch(
  bucket: R2Bucket,
  profile: DirectoryProfile,
  checkpoint: DirectoryArtifactPublication,
): Promise<boolean> {
  const pending = Object.freeze({
    token: "0".repeat(64),
    revision: checkpoint.publishedRevision,
    generation: checkpoint.generation,
    generatedAt: checkpoint.generatedAt,
    expiresAt: checkpoint.expiresAt,
    modelSha256: checkpoint.modelSha256,
  });
  const objects = checkpointObjects(profile, checkpoint);
  for (const object of objects) {
    const head = await bucket.head(object.path.slice(1));
    if (head === null) {
      return false;
    }
    try {
      verifyObjectHead(
        head,
        object,
        profile,
        pending,
        publicHttpMetadata(object, pending),
      );
    } catch {
      return false;
    }
  }
  return true;
}

function checkpointObjects(
  profile: DirectoryProfile,
  checkpoint: DirectoryArtifactPublication,
): readonly RenderedObject[] {
  const schema = profile === "classic-v1"
    ? CLASSIC_DIRECTORY_SCHEMA
    : GAME_DIRECTORY_SCHEMA;
  const descriptors = [
    ["html", "/index.html", "text/html; charset=utf-8",
      checkpoint.htmlSha256, checkpoint.htmlBytes],
    ["xml", "/index.xml", "application/xml; charset=utf-8",
      checkpoint.xmlSha256, checkpoint.xmlBytes],
    ["json", "/index.json", "application/json; charset=utf-8",
      checkpoint.jsonSha256, checkpoint.jsonBytes],
    ["manifest", "/manifest.json", "application/json; charset=utf-8",
      checkpoint.manifestSha256, checkpoint.manifestBytes],
  ] as const;
  return descriptors.map(([format, path, contentType, sha256, byteLength]) => {
    const namespace = format === "manifest"
      ? MANIFEST_SCHEMA
      : profile === "game-v1" && format === "json"
      ? schema
      : `${schema}-${format}`;
    return {
      format,
      path,
      contentType,
      bodyBytes: new Uint8Array(),
      byteLength,
      sha256,
      strongEtag: `"${namespace}-sha256-${sha256}"`,
    } satisfies RenderedObject;
  });
}

async function renderedObjects(
  rendered: RenderedDirectoryGeneration,
): Promise<readonly RenderedObject[]> {
  const artifacts = [
    rendered.artifacts.html,
    rendered.artifacts.xml,
    rendered.artifacts.json,
  ];
  const manifestBody = JSON.stringify({
    schema: MANIFEST_SCHEMA,
    profile: rendered.profile,
    directorySchema: rendered.schema,
    generation: rendered.generation,
    generatedAt: rendered.generatedAt,
    expiresAt: rendered.expiresAt,
    serverCount: rendered.serverCount,
    artifacts: artifacts.map(manifestArtifact),
  }) + "\n";
  const manifestBytes = TEXT_ENCODER.encode(manifestBody);
  const manifestSha256 = await sha256Bytes(manifestBytes);
  return Object.freeze([
    ...artifacts.map((artifact) => ({
      format: artifact.format,
      path: artifact.path,
      contentType: artifact.contentType,
      bodyBytes: artifact.bodyBytes,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      strongEtag: artifact.strongEtag,
    } as RenderedObject)),
    {
      format: "manifest",
      path: "/manifest.json",
      contentType: "application/json; charset=utf-8",
      bodyBytes: manifestBytes,
      byteLength: manifestBytes.byteLength,
      sha256: manifestSha256,
      strongEtag: `"${MANIFEST_SCHEMA}-sha256-${manifestSha256}"`,
    } satisfies RenderedObject,
  ]);
}

function manifestArtifact(
  artifact: DirectoryArtifactDescriptor,
): ManifestArtifact {
  return {
    path: artifact.path,
    contentType: artifact.contentType,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    strongEtag: artifact.strongEtag,
  };
}

function aliasPublicationOrder(
  profile: DirectoryProfile,
  objects: readonly RenderedObject[],
): readonly RenderedObject[] {
  const order = profile === "classic-v1"
    ? ["html", "json", "xml", "manifest"]
    : ["html", "xml", "json", "manifest"];
  return order.map((format) => {
    const object = objects.find((candidate) => candidate.format === format);
    if (object === undefined) {
      throw new Error("Directory build omitted a required artifact");
    }
    return object;
  });
}

function immutableObjectKey(
  profile: DirectoryProfile,
  generation: number,
  path: string,
): string {
  return `v1/${profile}/${generation}/${path.slice(1)}`;
}

async function putImmutableGeneration(
  bucket: R2Bucket,
  key: string,
  object: RenderedObject,
  profile: DirectoryProfile,
  pending: PendingBuild,
): Promise<void> {
  const httpMetadata = immutableHttpMetadata(object);
  const existing = await bucket.head(key);
  if (existing !== null) {
    try {
      await verifyObject(
        bucket,
        key,
        existing,
        object,
        profile,
        pending,
        httpMetadata,
      );
    } catch (error) {
      if (!(error instanceof DirectoryObjectConflictError)) {
        throw error;
      }
      throw new ImmutableGenerationConflictError(
        "Immutable directory generation already has different bytes",
        { cause: error },
      );
    }
    return;
  }
  const created = await bucket.put(key, object.bodyBytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata,
    customMetadata: objectMetadata(object, profile, pending),
    sha256: hexBytes(object.sha256),
  });
  const persisted = created ?? await bucket.head(key);
  if (persisted === null) {
    throw new Error("Immutable directory artifact was not persisted");
  }
  try {
    await verifyObject(
      bucket,
      key,
      persisted,
      object,
      profile,
      pending,
      httpMetadata,
    );
  } catch (error) {
    if (!(error instanceof DirectoryObjectConflictError)) {
      throw error;
    }
    throw new ImmutableGenerationConflictError(
      "Immutable directory generation did not preserve its bytes",
      { cause: error },
    );
  }
}

async function putPublicAlias(
  bucket: R2Bucket,
  key: string,
  object: RenderedObject,
  profile: DirectoryProfile,
  pending: PendingBuild,
): Promise<void> {
  const httpMetadata = publicHttpMetadata(object, pending);
  const existing = await bucket.head(key);
  const existingGeneration = existing === null
    ? 0
    : observedGeneration(existing.customMetadata);
  if (existingGeneration > pending.generation) {
    throw new DirectoryObjectConflictError(
      "A newer directory alias is already public",
    );
  }
  if (existingGeneration === pending.generation && existing !== null) {
    await verifyObject(
      bucket,
      key,
      existing,
      object,
      profile,
      pending,
      httpMetadata,
    );
    return;
  }
  const published = await bucket.put(key, object.bodyBytes, {
    onlyIf: existing === null
      ? { etagDoesNotMatch: "*" }
      : { etagMatches: existing.etag },
    httpMetadata,
    customMetadata: objectMetadata(object, profile, pending),
    sha256: hexBytes(object.sha256),
  });
  const persisted = published ?? await bucket.head(key);
  if (persisted === null) {
    throw new Error("Directory alias compare-and-swap failed");
  }
  if (observedGeneration(persisted.customMetadata) > pending.generation) {
    throw new DirectoryObjectConflictError(
      "A newer directory alias won publication",
    );
  }
  await verifyObject(
    bucket,
    key,
    persisted,
    object,
    profile,
    pending,
    httpMetadata,
  );
}

function immutableHttpMetadata(object: RenderedObject): R2HTTPMetadata {
  return {
    contentType: object.contentType,
    cacheControl: "private, max-age=31536000, immutable, no-transform",
  };
}

function publicHttpMetadata(
  object: RenderedObject,
  pending: PendingBuild,
): R2HTTPMetadata {
  return {
    contentType: object.contentType,
    // An absolute expiry is required: a relative max-age on a late cache fill
    // could remain fresh beyond the freshness timestamp inside the body.
    cacheControl: "public, must-revalidate, stale-if-error=0, no-transform",
    cacheExpiry: new Date(pending.expiresAt * 1_000),
  };
}

function objectMetadata(
  object: RenderedObject,
  profile: DirectoryProfile,
  pending: PendingBuild,
): Record<string, string> {
  return {
    schema: MANIFEST_SCHEMA,
    profile,
    format: object.format,
    generation: String(pending.generation),
    "generated-at": String(pending.generatedAt),
    "expires-at": String(pending.expiresAt),
    "model-sha256": pending.modelSha256,
    "body-sha256": object.sha256,
    "strong-etag": object.strongEtag,
  };
}

async function verifyObject(
  bucket: R2Bucket,
  key: string,
  head: R2Object,
  object: RenderedObject,
  profile: DirectoryProfile,
  pending: PendingBuild,
  expectedHttpMetadata: R2HTTPMetadata,
): Promise<void> {
  const body = await bucket.get(key, {
    onlyIf: { etagMatches: head.etag },
  });
  if (
    body === null || !("arrayBuffer" in body) || body.etag !== head.etag
  ) {
    throw new DirectoryObjectConflictError(
      "Directory artifact metadata verification failed",
    );
  }
  verifyObjectHead(body, object, profile, pending, expectedHttpMetadata);
  const actual = new Uint8Array(await body.arrayBuffer());
  if (await sha256Bytes(actual) !== object.sha256) {
    throw new DirectoryObjectConflictError(
      "Directory artifact body verification failed",
    );
  }
}

function verifyObjectHead(
  head: R2Object,
  object: RenderedObject,
  profile: DirectoryProfile,
  pending: PendingBuild,
  expectedHttpMetadata: R2HTTPMetadata,
): void {
  const checksum = head.checksums.sha256;
  if (
    head.size !== object.byteLength ||
    checksum === undefined || bytesHex(new Uint8Array(checksum)) !== object.sha256 ||
    !httpMetadataEquals(head.httpMetadata, expectedHttpMetadata) ||
    !metadataEquals(head.customMetadata, objectMetadata(object, profile, pending))
  ) {
    throw new DirectoryObjectConflictError(
      "Directory artifact metadata verification failed",
    );
  }
}

async function verifyPublishedObjects(
  bucket: R2Bucket,
  objects: readonly RenderedObject[],
  profile: DirectoryProfile,
  pending: PendingBuild,
): Promise<void> {
  for (const object of objects) {
    const key = object.path.slice(1);
    const head = await bucket.head(key);
    if (head === null) {
      throw new DirectoryObjectConflictError(
        "Directory alias disappeared before checkpoint",
      );
    }
    await verifyObject(
      bucket,
      key,
      head,
      object,
      profile,
      pending,
      publicHttpMetadata(object, pending),
    );
  }
}

function httpMetadataEquals(
  actual: R2HTTPMetadata | undefined,
  expected: R2HTTPMetadata,
): boolean {
  return actual !== undefined &&
    actual.contentType === expected.contentType &&
    actual.cacheControl === expected.cacheControl &&
    (actual.cacheExpiry?.getTime() ?? null) ===
      (expected.cacheExpiry?.getTime() ?? null);
}

function metadataEquals(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key, index) =>
      actualKeys[index] === key && actual[key] === expected[key]
    );
}

function metadataGeneration(metadata: Record<string, string> | undefined): number {
  const value = metadata?.generation;
  if (value === undefined || !GENERATION.test(value)) {
    throw new Error("Directory alias generation metadata is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Directory alias generation metadata is invalid");
  }
  return parsed;
}

function observedGeneration(
  metadata: Record<string, string> | undefined,
): number {
  try {
    return metadataGeneration(metadata);
  } catch {
    // Invalid metadata is not a valid published generation. The following R2
    // compare-and-swap still pins the exact corrupt ETag before replacement.
    return 0;
  }
}

function artifactPublicationMatches(
  actual: DirectoryArtifactPublication,
  expected: Omit<DirectoryArtifactPublication, never>,
): boolean {
  return actual.publishedRevision === expected.publishedRevision &&
    actual.generation === expected.generation &&
    actual.generatedAt === expected.generatedAt &&
    actual.expiresAt === expected.expiresAt &&
    actual.modelSha256 === expected.modelSha256 &&
    actual.htmlSha256 === expected.htmlSha256 &&
    actual.xmlSha256 === expected.xmlSha256 &&
    actual.jsonSha256 === expected.jsonSha256 &&
    actual.manifestSha256 === expected.manifestSha256 &&
    actual.htmlBytes === expected.htmlBytes &&
    actual.xmlBytes === expected.xmlBytes &&
    actual.jsonBytes === expected.jsonBytes &&
    actual.manifestBytes === expected.manifestBytes &&
    actual.publishedAt === expected.publishedAt;
}

async function pruneImmutableGenerationPage(
  bucket: R2Bucket,
  profile: DirectoryProfile,
  retained: ReadonlySet<number>,
  cursor: string | null,
): Promise<RetentionSweepResult> {
  const prefix = `v1/${profile}/`;
  const page = await bucket.list({
    prefix,
    limit: 1_000,
    ...(cursor === null ? {} : { cursor }),
  });
  if (page.truncated && !isCleanupCursor(page.cursor)) {
    throw new Error("Immutable retention cursor is invalid");
  }
  const obsolete = page.objects.flatMap((object) => {
    const relative = object.key.slice(prefix.length);
    const separator = relative.indexOf("/");
    if (separator < 1) {
      return [];
    }
    const value = relative.slice(0, separator);
    const filename = relative.slice(separator + 1);
    if (
      !GENERATION.test(value) ||
      !IMMUTABLE_GENERATION_FILENAMES.includes(
        filename as typeof IMMUTABLE_GENERATION_FILENAMES[number],
      )
    ) {
      return [];
    }
    const generation = Number(value);
    return Number.isSafeInteger(generation) && !retained.has(generation)
      ? [object.key]
      : [];
  });
  const selected = obsolete.slice(0, MAX_IMMUTABLE_DELETES_PER_RECONCILIATION);
  if (selected.length > 0) {
    await bucket.delete(selected);
  }
  const pageHasMoreObsolete = obsolete.length > selected.length;
  return {
    deleted: selected.length,
    deferred: pageHasMoreObsolete || page.truncated,
    nextCursor: pageHasMoreObsolete
      ? cursor
      : page.truncated
      ? page.cursor
      : null,
  };
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  if (!SHA256_HEX.test(value)) {
    throw new Error("Invalid directory artifact digest");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Bytes(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesHex(input: Uint8Array): string {
  return Array.from(
    input,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
