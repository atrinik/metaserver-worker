import { DurableObject } from "cloudflare:workers";

import {
  RENDEZVOUS_POLICY_MAXIMUMS,
  rendezvousPolicyConfiguration,
} from "./config";
import type { RendezvousPolicyConfiguration } from "./config";
import { HttpError, httpErrorResponse } from "./http";
import {
  requiredSourceTagKeyRing,
} from "./privacy";
import type { SourceTagKeyRing } from "./privacy";
import { sha256Hex } from "./protocol";
import { RendezvousAdmissionStore } from "./rendezvous-admission";
import {
  ATTACHMENT_VERSION,
  MAX_RETAINED_TICKETS,
  readAttachment,
  readClientAttachment,
  readServerAttachment,
  tryWriteAttachment,
  writeAttachment,
} from "./rendezvous-attachments";
import type {
  ClientAttachment,
  RendezvousAttachment,
  ServerAttachment,
  TicketState,
} from "./rendezvous-attachments";
import { writeRendezvousTerminalMetric } from "./rendezvous-metrics";
import {
  MAX_CLIENT_CANDIDATES,
  MAX_CLIENT_AUTHORIZATION_FRAMES,
  MAX_COMPLETIONS,
  MAX_RENDEZVOUS_CLIENT_SOCKETS,
  MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES,
  MAX_SERVER_CANDIDATES,
  MAX_SERVER_AUTHORIZATION_FRAMES,
  MAX_TERMINAL_CLOSE_ATTEMPTS,
  INTERNAL_DIRECTORY_CHANGED_HEADER,
  NORMAL_RENDEZVOUS_CLOSE,
  parseRendezvousSignal,
  RENDEZVOUS_CLOSE,
  TERMINAL_CLOSE_RETRY_OFFSETS_MS,
  INTERNAL_RENDEZVOUS_PUBLISH_URL,
  validateInternalRendezvousUpgrade,
  validateInternalRendezvousPublication,
} from "./rendezvous-contract";
import { CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL } from "./routes";
import type {
  CompleteSignal,
  RendezvousTerminalOutcome,
  RendezvousSignalParseResult,
  ServerCandidateSignal,
} from "./rendezvous-contract";
import type { InternalRendezvousPublication } from "./rendezvous-contract";
import {
  persistRendezvousPublication,
  readPublishedGeneration,
  readPublisherReplayState,
  rendezvousPublicationMatches,
} from "./rendezvous-publication";

const MAX_CLIENT_PENDING_MESSAGES =
  MAX_CLIENT_AUTHORIZATION_FRAMES + MAX_CLIENT_CANDIDATES + 1;
const MAX_SERVER_PENDING_MESSAGES =
  RENDEZVOUS_POLICY_MAXIMUMS.rendezvousActiveClientLimit *
    (MAX_SERVER_AUTHORIZATION_FRAMES + MAX_SERVER_CANDIDATES +
      MAX_COMPLETIONS) + 1;
const MAX_EPHEMERAL_CONNECTION_IDS =
  (MAX_RENDEZVOUS_CLIENT_SOCKETS + 1) * 2;
const TEARDOWN_RECOVERY_KEY = "rendezvous:teardown-recovery-required";
const TOKEN_GENERATION_KEY = "rendezvous:token-generation";
const TOKEN_GENERATION = /^[0-9a-f]{64}$/;

interface ActiveServer {
  readonly socket: WebSocket;
  readonly attachment: ServerAttachment;
}

interface ServerRetirement {
  readonly server: ActiveServer;
  readonly durablyDemoted: boolean;
  readonly transportRetired: boolean;
}

interface MessageQueue {
  pending: number;
  tail: Promise<void>;
}

const ROOM_ERROR_DEFINITIONS = {
  forbidden: {
    status: 403,
    body: "Forbidden\n",
  },
  server_unavailable: {
    status: 503,
    body: "Rendezvous server unavailable\n",
    retryAfterSeconds: 5,
  },
  room_full: {
    status: 503,
    body: "Rendezvous room is full\n",
    retryAfterSeconds: 15,
  },
  room_unavailable: {
    status: 503,
    body: "Rendezvous room unavailable\n",
    retryAfterSeconds: 60,
  },
  publication_conflict: {
    status: 409,
    body: "Rendezvous publication conflict\n",
  },
} as const;

type RoomErrorCode = keyof typeof ROOM_ERROR_DEFINITIONS;

/**
 * One signaling-only room per published server identity. All state that may
 * contain a raw ticket is bounded and attached to hibernatable WebSockets.
 * SQLite contains the exact rolling admissions and purpose-separated replay
 * tags, but never raw tickets or candidate endpoints.
 */
export class RendezvousRoom extends DurableObject<Env> {
  private readonly admissions: RendezvousAdmissionStore;
  private readonly initialized: Promise<void>;
  private readonly finalizedConnections = new Set<string>();
  private readonly inactiveControls = new Set<string>();
  private readonly messageQueues = new WeakMap<WebSocket, MessageQueue>();
  private readonly pendingClientOutcomes = new WeakMap<
    WebSocket,
    RendezvousTerminalOutcome
  >();
  private readonly pendingServerOutcomes = new WeakMap<
    WebSocket,
    RendezvousTerminalOutcome
  >();
  private admissionsInitialized = false;
  private initializationFailed = false;
  private teardownRecoveryPersisted = false;
  private teardownRecoveryRequired = false;
  private currentGeneration: string | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private publicationPersister = persistRendezvousPublication;
  private publicationMatcher = rendezvousPublicationMatches;
  private replayTagKeys!: SourceTagKeyRing;
  private terminalMetricWriter = writeRendezvousTerminalMetric;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.admissions = new RendezvousAdmissionStore(ctx.storage);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      try {
        if (await ctx.storage.get<boolean>(TEARDOWN_RECOVERY_KEY) === true) {
          this.teardownRecoveryPersisted = true;
          this.teardownRecoveryRequired = true;
          if (this.closeSocketsForTeardownRecovery()) {
            await ctx.storage.delete(TEARDOWN_RECOVERY_KEY);
            this.teardownRecoveryPersisted = false;
            this.teardownRecoveryRequired = false;
          } else {
            await this.scheduleTeardownRetryAlarm();
          }
        }
        const generation = await ctx.storage.get<string>(TOKEN_GENERATION_KEY);
        if (generation !== undefined && !TOKEN_GENERATION.test(generation)) {
          throw new Error("Invalid rendezvous token generation");
        }
        this.currentGeneration = generation ?? null;
        this.admissions.initialize();
        this.admissionsInitialized = true;
        this.replayTagKeys = await requiredSourceTagKeyRing(env);
      } catch {
        // A rejected blockConcurrencyWhile callback prevents fetch() from
        // returning our fixed fail-closed response. Preserve the failure on
        // this instance and let every event gate itself after initialization.
        this.initializationFailed = true;
        const stateSanitized = this.closeSocketsForInitializationFailure();
        if (stateSanitized && this.admissionsInitialized) {
          const now = Date.now();
          try {
            this.admissions.prune(now);
            await this.scheduleAdmissionAlarm(now);
          } catch {
            // An existing session/admission alarm remains the fail-closed
            // recovery path when maintenance cannot be rescheduled here.
          }
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.url === INTERNAL_RENDEZVOUS_PUBLISH_URL) {
      let publication: InternalRendezvousPublication | null = null;
      try {
        publication = await validateInternalRendezvousPublication(request);
      } catch {
        // Body stream failures are indistinguishable from other malformed
        // private requests and must not enter the publication queue.
      }
      if (
        publication === null ||
        publication.directoryProfile !== "classic-v1" ||
        this.ctx.id.name !== publication.serverId
      ) {
        return roomError("forbidden");
      }
      return this.serializeRoomOperation(async () => {
        try {
          await this.ensureInitialized();
          return await this.commitPublication(publication);
        } catch (error) {
          if (error instanceof RendezvousTeardownIntegrityError) {
            await this.rethrowTeardownFailure(error);
          }
          return roomError("room_unavailable");
        }
      });
    }

    const upgrade = validateInternalRendezvousUpgrade(request);
    if (upgrade === null) {
      return roomError("forbidden");
    }

    return this.serializeRoomOperation(async () => {
      try {
        await this.ensureInitialized();
        await this.reconcileUpgradeGeneration(upgrade.generation);
        const policy = rendezvousPolicyConfiguration(this.env);
        const now = Date.now();
        this.expireClients(now);
        this.pruneServerTickets(now);

        return upgrade.role === "server"
          ? await this.acceptServer(
            now,
            upgrade.inviteProtocol,
            upgrade.generation,
          )
          : await this.acceptClient(
            now,
            policy,
            upgrade.authorizationRequired,
            upgrade.inviteProtocol,
            upgrade.generation,
          );
      } catch (error) {
        if (error instanceof RendezvousTeardownIntegrityError) {
          await this.rethrowTeardownFailure(error);
        }
        return roomError("room_unavailable");
      }
    });
  }

  private serializeRoomOperation(
    operation: () => Promise<Response>,
  ): Promise<Response> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async commitPublication(
    publication: InternalRendezvousPublication,
  ): Promise<Response> {
    if (publication.publisherAuthentication === "signed-certificate-v1") {
      const conflict = await this.signedPublicationConflict(publication);
      if (conflict !== null) {
        return publishReplayResponse(conflict);
      }
    }
    const publishedGeneration = await this.reconcilePublishedGeneration(
      publication.serverId,
    );
    if (publishedGeneration !== publication.expectedGeneration) {
      return roomError("publication_conflict");
    }

    await this.rotateTokenGeneration(publication.generation);
    let visibleChanged = false;
    try {
      const persisted = await this.publicationPersister(
        this.env.DB,
        publication,
      );
      if (!persisted.accepted) {
        await this.reconcilePublishedGeneration(publication.serverId);
        const conflict = await this.signedPublicationConflict(publication);
        if (conflict === null) {
          throw new Error("Publisher replay state did not explain rejection");
        }
        return publishReplayResponse(conflict);
      }
      visibleChanged = persisted.visibleChanged;
    } catch (error) {
      if (await this.publicationMatcher(this.env.DB, publication)) {
        // The exact matcher proves the required outbox when the mutation was
        // visible. Conservatively nudging after an ambiguous-but-committed
        // neutral mutation avoids adding another fallible D1 read after the
        // transaction is already authoritative.
        return publicationCommittedResponse(true);
      }
      // D1 is authoritative after an ambiguous batch result. Re-read it rather
      // than assuming whether the transaction committed, then make the room
      // fail closed on exactly that generation before returning an error.
      await this.reconcilePublishedGeneration(publication.serverId);
      throw error;
    }
    return publicationCommittedResponse(visibleChanged);
  }

  private async signedPublicationConflict(
    publication: InternalRendezvousPublication,
  ): Promise<string | null> {
    const sequence = publication.publisherSequence;
    const nonce = publication.publisherNonce;
    if (sequence === null || nonce === null) {
      throw new Error("Signed publication omitted replay metadata");
    }
    const state = await readPublisherReplayState(
      this.env.DB,
      publication.serverId,
      publication.directoryProfile,
      nonce,
    );
    if (
      state === null ||
      (!state.nonceSeen && comparePublishSequences(
        sequence,
        state.lastSequence,
      ) > 0)
    ) {
      return null;
    }
    return minimumNextPublishSequence(state.lastSequence);
  }

  private async reconcileUpgradeGeneration(generation: string): Promise<void> {
    if (this.currentGeneration === generation) {
      return;
    }
    const serverId = this.ctx.id.name;
    if (serverId === undefined || !TOKEN_GENERATION.test(serverId)) {
      return;
    }
    await this.reconcilePublishedGeneration(serverId);
  }

  private async reconcilePublishedGeneration(
    serverId: string,
  ): Promise<string | null> {
    const generation = await readPublishedGeneration(
      this.env.DB,
      "classic-v1",
      serverId,
    );
    await this.rotateTokenGeneration(generation);
    return generation;
  }

  webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.initializationFailed || this.teardownRecoveryRequired) {
      // Constructor cleanup has already scrubbed every decodable attachment.
      // Do not let a peer turn a permanently unavailable room into an
      // unbounded stream of parsing or teardown attempts.
      return Promise.resolve();
    }

    // Parse before a promise closure captures the frame. This keeps the FIFO's
    // retained memory bounded by the 512-byte protocol contract even while an
    // earlier digest is awaiting Web Crypto.
    const parsed = parseRendezvousSignal(message);
    if (!parsed.ok) {
      try {
        this.failProtocolViolation(socket);
        return Promise.resolve();
      } catch (error) {
        return error instanceof RendezvousTeardownIntegrityError
          ? this.rethrowTeardownFailure(error)
          : Promise.reject(error);
      }
    }

    const maximumPending = this.taggedSocketRole(socket) === "server"
      ? MAX_SERVER_PENDING_MESSAGES
      : MAX_CLIENT_PENDING_MESSAGES;
    const queue = this.messageQueues.get(socket) ?? {
      pending: 0,
      tail: Promise.resolve(),
    };
    if (queue.pending >= maximumPending) {
      try {
        this.failProtocolViolation(socket);
        return Promise.resolve();
      } catch (error) {
        return error instanceof RendezvousTeardownIntegrityError
          ? this.rethrowTeardownFailure(error)
          : Promise.reject(error);
      }
    }
    queue.pending += 1;

    const process = (): Promise<void> =>
      this.processWebSocketMessage(socket, parsed);
    const processing = queue.tail.then(process, process);
    let settled: Promise<void>;
    settled = processing.finally(() => {
      queue.pending -= 1;
      if (queue.pending === 0 && queue.tail === settled) {
        this.messageQueues.delete(socket);
      }
    });
    queue.tail = settled;
    this.messageQueues.set(socket, queue);
    return settled;
  }

  private async processWebSocketMessage(
    socket: WebSocket,
    parsed: Extract<RendezvousSignalParseResult, { ok: true }>,
  ): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      await this.ensureInitialized();
      const attachment = this.readTaggedAttachment(socket);
      if (attachment === null) {
        if (
          this.ctx.getTags(socket).includes("server") &&
          !this.closeAllClients(
            "internal_error",
            RENDEZVOUS_CLOSE.internalError,
          )
        ) {
          throw new RendezvousTeardownIntegrityError(
            "Rendezvous invalid-server clients were not retired",
          );
        }
        closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
        return;
      }

      if (attachment.generation !== this.currentGeneration) {
        if (attachment.role === "server") {
          this.failServer(
            socket,
            attachment,
            "server_replaced",
            RENDEZVOUS_CLOSE.serverReplaced,
          );
        } else {
          this.failClient(
            socket,
            attachment,
            "server_replaced",
            RENDEZVOUS_CLOSE.serverReplaced,
          );
        }
        return;
      }

      if (attachment.role === "client") {
        await this.handleClientMessage(socket, attachment, parsed);
      } else {
        await this.handleServerMessage(socket, attachment, parsed);
      }
    } catch (error) {
      if (error instanceof RendezvousTeardownIntegrityError) {
        await this.rethrowTeardownFailure(error);
      }
      try {
        const attachment = this.readTaggedAttachment(socket);
        if (attachment?.role === "server") {
          this.failServer(
            socket,
            attachment,
            "internal_error",
            RENDEZVOUS_CLOSE.internalError,
          );
        } else if (attachment?.role === "client") {
          this.failClient(
            socket,
            attachment,
            "internal_error",
            RENDEZVOUS_CLOSE.internalError,
          );
        } else {
          closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
        }
      } catch (cleanupError) {
        if (cleanupError instanceof RendezvousTeardownIntegrityError) {
          await this.rethrowTeardownFailure(cleanupError);
        }
        throw cleanupError;
      }
    }
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    try {
      await this.handleSocketGone(socket, code, reason, wasClean);
    } catch (error) {
      if (error instanceof RendezvousTeardownIntegrityError) {
        await this.rethrowTeardownFailure(error);
      }
      closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
    }
  }

  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    try {
      await this.ensureInitialized();
      const attachment = this.readTaggedAttachment(socket);
      if (attachment?.role === "server") {
        this.failServer(
          socket,
          attachment,
          "internal_error",
          RENDEZVOUS_CLOSE.internalError,
        );
      } else if (attachment?.role === "client") {
        this.failClient(
          socket,
          attachment,
          "internal_error",
          RENDEZVOUS_CLOSE.internalError,
        );
      } else {
        if (
          this.ctx.getTags(socket).includes("server") &&
          !this.closeAllClients(
            "internal_error",
            RENDEZVOUS_CLOSE.internalError,
          )
        ) {
          throw new RendezvousTeardownIntegrityError(
            "Rendezvous invalid-server clients were not retired",
          );
        }
        closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
      }
      await this.scheduleNextAlarm(Date.now());
    } catch (error) {
      if (error instanceof RendezvousTeardownIntegrityError) {
        await this.rethrowTeardownFailure(error);
      }
      closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
    }
  }

  async alarm(): Promise<void> {
    await this.initialized;
    if (this.teardownRecoveryRequired) {
      if (!this.closeSocketsForTeardownRecovery()) {
        throw new RendezvousTeardownIntegrityError(
          "Rendezvous recovery quarantine could not be completed",
        );
      }
      await this.ctx.storage.delete(TEARDOWN_RECOVERY_KEY);
      this.teardownRecoveryPersisted = false;
      this.teardownRecoveryRequired = false;
    }
    if (this.initializationFailed) {
      if (!this.closeSocketsForInitializationFailure()) {
        // Do not install a replacement alarm. The current alarm is retried by
        // Cloudflare with bounded exponential backoff when both durable
        // sanitization and transport close fail.
        throw new RendezvousTeardownIntegrityError(
          "Rendezvous initialization teardown was not persisted",
        );
      }
      if (this.admissionsInitialized) {
        const now = Date.now();
        this.admissions.prune(now);
        await this.scheduleAdmissionAlarm(now);
      }
      return;
    }
    const now = Date.now();
    let teardownError: RendezvousTeardownIntegrityError | null = null;
    try {
      this.retryPendingServerTeardowns();
    } catch (error) {
      if (!(error instanceof RendezvousTeardownIntegrityError)) {
        throw error;
      }
      teardownError = error;
    }
    try {
      this.expireClients(now);
    } catch (error) {
      if (!(error instanceof RendezvousTeardownIntegrityError)) {
        throw error;
      }
      teardownError ??= error;
    }
    try {
      this.pruneServerTickets(now);
    } catch (error) {
      if (!(error instanceof RendezvousTeardownIntegrityError)) {
        throw error;
      }
      teardownError ??= error;
    }
    this.admissions.prune(now);
    if (teardownError !== null) {
      // Do not install a replacement alarm from inside a failed alarm. The
      // platform retries this delivery with a bounded exponential backoff.
      throw teardownError;
    }
    if (this.teardownRecoveryPersisted) {
      await this.ctx.storage.delete(TEARDOWN_RECOVERY_KEY);
      this.teardownRecoveryPersisted = false;
    }
    await this.scheduleNextAlarm(now);
  }

  private async acceptServer(
    now: number,
    inviteProtocol: boolean,
    generation: string,
  ): Promise<Response> {
    try {
      if (this.currentGeneration === null) {
        await this.ctx.storage.put(TOKEN_GENERATION_KEY, generation);
        this.currentGeneration = generation;
      } else if (this.currentGeneration !== generation) {
        return roomError("room_unavailable");
      }
      await this.scheduleNextAlarm(now);
    } catch {
      return roomError("room_unavailable");
    }

    const previousServers = this.ctx.getWebSockets("server")
      .flatMap((socket) => {
        const previous = readServerAttachment(socket);
        return previous?.current
          ? [{ socket, attachment: previous }]
          : [];
      })
      .sort(compareActiveServersNewestFirst);
    const retirements: ServerRetirement[] = [];
    let unsafePreviousRemainsCurrent = false;
    for (const previous of previousServers) {
      const retirement = this.prepareServerRetirement(
        previous,
        RENDEZVOUS_CLOSE.serverReplaced,
      );
      if (retirement === null) {
        unsafePreviousRemainsCurrent = true;
        continue;
      }
      retirements.push(retirement);
    }
    if (unsafePreviousRemainsCurrent) {
      for (const retirement of retirements) {
        this.finishServerRetirement(
          retirement,
          RENDEZVOUS_CLOSE.internalError,
        );
      }
      return roomError("room_unavailable");
    }

    // Malformed controls cannot be made durably inactive. Do not expose the
    // replacement unless every such transport is already retired.
    let malformedControlRemainsOpen = false;
    for (const socket of this.ctx.getWebSockets("server")) {
      if (
        readServerAttachment(socket) === null &&
        !closeSocket(socket, RENDEZVOUS_CLOSE.internalError)
      ) {
        malformedControlRemainsOpen = true;
      }
    }
    if (malformedControlRemainsOpen) {
      if (!this.restorePreviousServer(retirements)) {
        if (!this.closeAllClients(
          "server_unavailable",
          RENDEZVOUS_CLOSE.serverUnavailable,
        )) {
          await this.persistTeardownRecoveryRequired();
        }
      }
      return roomError("room_unavailable");
    }

    let clientSocket: WebSocket | null = null;
    let room: WebSocket | null = null;
    let attachment: ServerAttachment | null = null;
    let response: Response;
    try {
      const pair = new WebSocketPair();
      clientSocket = pair[0];
      room = pair[1];
      attachment = {
        v: ATTACHMENT_VERSION,
        role: "server",
        current: false,
        inviteProtocol,
        controlId: crypto.randomUUID(),
        generation,
        openedAt: now,
        tickets: [],
      };
      response = this.createUpgradeResponse(clientSocket, inviteProtocol);
      this.ctx.acceptWebSocket(room, ["server"]);
      writeAttachment(room, attachment);
      attachment.current = true;
      writeAttachment(room, attachment);
      if (room.readyState !== WebSocket.OPEN) {
        throw new Error("Prepared replacement server is not open");
      }
    } catch {
      if (attachment !== null && room !== null) {
        attachment.current = false;
        tryWriteAttachment(room, attachment);
      }
      if (room !== null) {
        closeSocket(room, RENDEZVOUS_CLOSE.internalError);
      }
      if (clientSocket !== null) {
        closeSocket(clientSocket, RENDEZVOUS_CLOSE.internalError);
      }
      if (!this.restorePreviousServer(retirements)) {
        if (!this.closeAllClients(
          "server_unavailable",
          RENDEZVOUS_CLOSE.serverUnavailable,
        )) {
          await this.persistTeardownRecoveryRequired();
        }
      }
      return roomError("room_unavailable");
    }

    const clientsRetired = this.closeAllClients(
      "server_replaced",
      RENDEZVOUS_CLOSE.serverReplaced,
    );
    for (const retirement of retirements) {
      this.finishServerRetirement(
        retirement,
        RENDEZVOUS_CLOSE.serverReplaced,
      );
    }
    for (const socket of this.ctx.getWebSockets("server")) {
      if (socket === room || previousServers.some(({ socket: previous }) =>
        previous === socket
      )) {
        continue;
      }
      closeSocket(socket, RENDEZVOUS_CLOSE.serverReplaced);
    }
    if (!clientsRetired) {
      await this.persistTeardownRecoveryRequired();
    }

    return response;
  }

  private async rotateTokenGeneration(generation: string | null): Promise<void> {
    if (this.currentGeneration === generation) {
      return;
    }

    // Persist the new generation before retiring old transports. Even if a
    // close and its attachment write both fail, all subsequent admissions and
    // message handlers fail the old generation closed after reconstruction.
    if (generation === null) {
      await this.ctx.storage.delete(TOKEN_GENERATION_KEY);
    } else {
      await this.ctx.storage.put(TOKEN_GENERATION_KEY, generation);
    }
    this.currentGeneration = generation;

    let teardownError: RendezvousTeardownIntegrityError | null = null;
    for (const socket of this.ctx.getWebSockets("server")) {
      const attachment = readServerAttachment(socket);
      try {
        if (attachment === null) {
          if (!closeSocket(socket, RENDEZVOUS_CLOSE.internalError)) {
            throw new RendezvousTeardownIntegrityError(
              "Rendezvous invalid generation control was not retired",
            );
          }
        } else if (attachment.generation !== generation) {
          this.failServer(
            socket,
            attachment,
            "server_replaced",
            RENDEZVOUS_CLOSE.serverReplaced,
          );
        }
      } catch (error) {
        if (error instanceof RendezvousTeardownIntegrityError) {
          teardownError ??= error;
          continue;
        }
        throw error;
      }
    }

    // A malformed/non-current control may not have owned every client. Sweep
    // all old-generation clients independently and aggregate teardown faults.
    for (const socket of this.ctx.getWebSockets("client")) {
      const attachment = readClientAttachment(socket);
      try {
        if (attachment === null) {
          if (!closeSocket(socket, RENDEZVOUS_CLOSE.internalError)) {
            throw new RendezvousTeardownIntegrityError(
              "Rendezvous invalid generation client was not retired",
            );
          }
        } else if (attachment.generation !== generation) {
          this.failClient(
            socket,
            attachment,
            "server_replaced",
            RENDEZVOUS_CLOSE.serverReplaced,
          );
        }
      } catch (error) {
        if (error instanceof RendezvousTeardownIntegrityError) {
          teardownError ??= error;
          continue;
        }
        throw error;
      }
    }

    if (teardownError !== null) {
      throw teardownError;
    }
    await this.scheduleNextAlarm(Date.now());
  }

  private async acceptClient(
    now: number,
    policy: RendezvousPolicyConfiguration,
    authorizationRequired: boolean,
    inviteProtocol: boolean,
    generation: string,
  ): Promise<Response> {
    if (this.currentGeneration !== generation) {
      return roomError("server_unavailable");
    }
    const server = this.reconcileActiveServer();
    if (server === null) {
      return roomError("server_unavailable");
    }
    if (authorizationRequired && !server.attachment.inviteProtocol) {
      return roomError("server_unavailable");
    }
    if (server.attachment.generation !== generation) {
      return roomError("server_unavailable");
    }

    const clients = this.ctx.getWebSockets("client");
    if (clients.length >= MAX_RENDEZVOUS_CLIENT_SOCKETS) {
      return roomError("room_full");
    }
    if (
      countActiveClients(
        clients,
        server.attachment.controlId,
        server.attachment.generation,
        now,
      ) >=
        policy.rendezvousActiveClientLimit
    ) {
      return roomError("room_full");
    }

    const admission = this.admissions.consume(
      now,
      policy.rendezvousClientRollingLimit,
    );
    if (!admission.accepted) {
      return httpErrorResponse(new HttpError("rate_limited", {
        rateLimitReason: "rendezvous_server_sessions_rolling",
        retryAfterSeconds: admission.retryAfterSeconds,
      }));
    }

    let room: WebSocket | null = null;
    try {
      const pair = new WebSocketPair();
      const client = pair[0];
      room = pair[1];
      const attachment: ClientAttachment = {
        v: ATTACHMENT_VERSION,
        role: "client",
        controlId: server.attachment.controlId,
        generation,
        connectionId: crypto.randomUUID(),
        admissionId: admission.admissionId,
        openedAt: now,
        expiresAt: now + policy.rendezvousClientSessionSeconds * 1_000,
        ticket: null,
        ticketDigest: null,
        stage: "awaiting_candidate",
        authorization: authorizationRequired
          ? "awaiting_init"
          : "not_required",
        clientAuthorizationFrames: 0,
        serverAuthorizationFrames: 0,
        clientCandidates: 0,
        serverCandidates: 0,
        completionCount: 0,
        signalBytes: 0,
        framesForwarded: 0,
        // Suppress terminal telemetry until every admission step succeeds and
        // this request is ready to return the accepted WebSocket.
        summaryEmitted: true,
        terminalOutcome: null,
        terminalCloseAttempts: 0,
      };
      this.ctx.acceptWebSocket(room, ["client"]);
      writeAttachment(room, attachment);
      await this.scheduleNextAlarm(now);
      const activeServer = this.reconcileActiveServer();
      if (
        activeServer === null ||
        activeServer.socket !== server.socket ||
        activeServer.attachment.controlId !== attachment.controlId ||
        activeServer.attachment.generation !== attachment.generation ||
        this.currentGeneration !== attachment.generation ||
        room.readyState !== WebSocket.OPEN
      ) {
        throw new Error("Server control changed during admission");
      }
      const response = this.createUpgradeResponse(client, inviteProtocol);
      attachment.summaryEmitted = false;
      writeAttachment(room, attachment);
      return response;
    } catch (error) {
      if (room !== null) {
        closeSocket(room, RENDEZVOUS_CLOSE.serverUnavailable);
      }
      try {
        this.admissions.release(admission.admissionId);
      } catch {
        // Retaining an unclaimed admission is the safe storage-failure mode.
      }
      if (error instanceof RendezvousTeardownIntegrityError) {
        await this.rethrowTeardownFailure(error);
      }
      return roomError("server_unavailable");
    }
  }

  private async handleClientMessage(
    socket: WebSocket,
    attachment: ClientAttachment,
    parsed: Extract<RendezvousSignalParseResult, { ok: true }>,
  ): Promise<void> {
    const now = Date.now();
    if (attachment.expiresAt <= now) {
      this.failClient(
        socket,
        attachment,
        "session_expired",
        RENDEZVOUS_CLOSE.sessionExpired,
      );
      return;
    }

    if (
      parsed.signal.type === "auth_init" &&
      attachment.authorization === "awaiting_init" &&
      attachment.stage === "awaiting_candidate"
    ) {
      await this.beginClientTicket(socket, attachment, parsed, true);
      return;
    }
    if (
      parsed.signal.type === "auth_proof" &&
      attachment.authorization === "awaiting_proof" &&
      attachment.stage === "awaiting_candidate"
    ) {
      await this.forwardClientProof(
        socket,
        attachment,
        parsed.signal,
        parsed.serialized,
        parsed.bytes,
      );
      return;
    }
    if (
      parsed.signal.type === "client_candidate" &&
      attachment.stage === "awaiting_candidate" &&
      (attachment.authorization === "not_required" ||
        attachment.authorization === "authorized")
    ) {
      if (attachment.authorization === "not_required") {
        await this.beginClientTicket(socket, attachment, parsed, false);
      } else {
        this.forwardAuthorizedClientCandidate(
          socket,
          attachment,
          parsed.signal,
          parsed.serialized,
          parsed.bytes,
        );
      }
      return;
    }

    this.failClient(
      socket,
      attachment,
      "protocol_error",
      RENDEZVOUS_CLOSE.protocolError,
    );
  }

  private async beginClientTicket(
    socket: WebSocket,
    attachment: ClientAttachment,
    parsed: Extract<RendezvousSignalParseResult, { ok: true }>,
    authorizationRequired: boolean,
  ): Promise<void> {
    if (
      (authorizationRequired && parsed.signal.type !== "auth_init") ||
      (!authorizationRequired && parsed.signal.type !== "client_candidate")
    ) {
      this.failClient(
        socket,
        attachment,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    const [ticketDigest, replayTags] = await Promise.all([
      this.digestTicket(parsed.signal.ticket),
      this.replayTagKeys.rendezvousReplayTags(
        this.env.COMPAT_HOSTNAME,
        this.ctx.id.toString(),
        parsed.signal.ticket,
      ),
    ]);

    const current = readClientAttachment(socket);
    const server = this.reconcileActiveServer();
    const currentNow = Date.now();
    if (current === null) {
      closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      this.failClient(
        socket,
        current,
        "client_disconnected",
        NORMAL_RENDEZVOUS_CLOSE,
      );
      return;
    }
    if (current.connectionId !== attachment.connectionId) {
      this.failClient(
        socket,
        current,
        "internal_error",
        RENDEZVOUS_CLOSE.internalError,
      );
      return;
    }
    const expectedAuthorization = authorizationRequired
      ? "awaiting_init"
      : "not_required";
    if (
      current.stage !== "awaiting_candidate" ||
      current.authorization !== expectedAuthorization
    ) {
      this.failClient(
        socket,
        current,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }
    if (current.expiresAt <= currentNow) {
      this.failClient(
        socket,
        current,
        "session_expired",
        RENDEZVOUS_CLOSE.sessionExpired,
      );
      return;
    }
    if (
      server === null ||
      server.attachment.controlId !== current.controlId ||
      server.attachment.generation !== current.generation
    ) {
      this.failClient(
        socket,
        current,
        "server_unavailable",
        RENDEZVOUS_CLOSE.serverUnavailable,
      );
      return;
    }

    pruneTicketList(server.attachment, currentNow);
    if (
      server.attachment.tickets.some(
        ({ ticketDigest: used }) => used === ticketDigest,
      ) ||
      server.attachment.tickets.length >= MAX_RETAINED_TICKETS
    ) {
      this.failClient(
        socket,
        current,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    const claim = this.admissions.claimReplayTags(
      current.admissionId,
      replayTags,
    );
    if (!claim.claimed) {
      const replay = claim.reason === "replay";
      this.failClient(
        socket,
        current,
        replay ? "protocol_error" : "internal_error",
        replay
          ? RENDEZVOUS_CLOSE.protocolError
          : RENDEZVOUS_CLOSE.internalError,
      );
      return;
    }

    current.ticket = parsed.signal.ticket;
    current.ticketDigest = ticketDigest;
    current.authorization = authorizationRequired
      ? "awaiting_challenge"
      : "not_required";
    current.clientAuthorizationFrames = authorizationRequired ? 1 : 0;
    current.stage = authorizationRequired
      ? "awaiting_candidate"
      : "candidate_exchange";
    current.clientCandidates = authorizationRequired
      ? 0
      : MAX_CLIENT_CANDIDATES;
    current.signalBytes = parsed.bytes;
    server.attachment.tickets.push({
      ticketDigest,
      clientConnectionId: current.connectionId,
      openedAt: current.openedAt,
      expiresAt: current.expiresAt,
      stage: "active",
      authorization: authorizationRequired
        ? "awaiting_challenge"
        : "not_required",
      clientAuthorizationFrames: authorizationRequired ? 1 : 0,
      serverAuthorizationFrames: 0,
      serverCandidates: 0,
      completionCount: 0,
      signalBytes: parsed.bytes,
    });
    writeAttachment(socket, current);
    writeAttachment(server.socket, server.attachment);

    try {
      server.socket.send(parsed.serialized);
    } catch {
      this.failServer(
        server.socket,
        server.attachment,
        "server_unavailable",
        RENDEZVOUS_CLOSE.serverUnavailable,
      );
      return;
    }
    current.framesForwarded += 1;
    try {
      writeAttachment(socket, current);
    } catch {
      this.failClient(
        socket,
        current,
        "internal_error",
        RENDEZVOUS_CLOSE.internalError,
      );
    }
  }

  private async forwardClientProof(
    socket: WebSocket,
    attachment: ClientAttachment,
    signal: { readonly type: "auth_proof"; readonly ticket: string },
    serialized: string,
    bytes: number,
  ): Promise<void> {
    const ticketDigest = await this.digestTicket(signal.ticket);
    const current = readClientAttachment(socket);
    const server = this.reconcileActiveServer();
    const now = Date.now();
    const expired = (current ?? attachment).expiresAt <= now;
    if (
      current === null ||
      socket.readyState !== WebSocket.OPEN ||
      current.connectionId !== attachment.connectionId ||
      current.controlId !== attachment.controlId ||
      current.generation !== attachment.generation ||
      current.expiresAt <= now ||
      current.stage !== "awaiting_candidate" ||
      current.authorization !== "awaiting_proof" ||
      current.ticket !== signal.ticket ||
      current.ticketDigest !== ticketDigest ||
      server === null ||
      server.attachment.controlId !== current.controlId ||
      server.attachment.generation !== current.generation
    ) {
      this.failClient(
        socket,
        current ?? attachment,
        expired
          ? "session_expired"
          : "protocol_error",
        expired
          ? RENDEZVOUS_CLOSE.sessionExpired
          : RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }
    const ticket = server.attachment.tickets.find(({ ticketDigest: digest,
      clientConnectionId }) =>
      digest === ticketDigest && clientConnectionId === current.connectionId
    );
    if (
      ticket === undefined ||
      ticket.stage !== "active" ||
      ticket.authorization !== "awaiting_proof" ||
      ticket.signalBytes + bytes > MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES
    ) {
      this.failClient(
        socket,
        current,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    current.authorization = "awaiting_result";
    current.clientAuthorizationFrames = 2;
    current.signalBytes += bytes;
    ticket.authorization = "awaiting_result";
    ticket.clientAuthorizationFrames = 2;
    ticket.signalBytes += bytes;
    writeAttachment(socket, current);
    writeAttachment(server.socket, server.attachment);
    try {
      server.socket.send(serialized);
    } catch {
      this.failServer(
        server.socket,
        server.attachment,
        "server_unavailable",
        RENDEZVOUS_CLOSE.serverUnavailable,
      );
      return;
    }
    current.framesForwarded += 1;
    writeAttachment(socket, current);
  }

  private forwardAuthorizedClientCandidate(
    socket: WebSocket,
    attachment: ClientAttachment,
    signal: { readonly type: "client_candidate"; readonly ticket: string },
    serialized: string,
    bytes: number,
  ): void {
    const server = this.reconcileActiveServer();
    const now = Date.now();
    const ticket = server?.attachment.tickets.find(({ ticketDigest,
      clientConnectionId }) =>
      ticketDigest === attachment.ticketDigest &&
      clientConnectionId === attachment.connectionId
    );
    if (
      server === null ||
      server.attachment.controlId !== attachment.controlId ||
      server.attachment.generation !== attachment.generation ||
      ticket === undefined ||
      ticket.stage !== "active" ||
      ticket.authorization !== "authorized" ||
      attachment.ticket !== signal.ticket ||
      attachment.expiresAt <= now ||
      ticket.signalBytes + bytes > MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES
    ) {
      this.failClient(
        socket,
        attachment,
        attachment.expiresAt <= now ? "session_expired" : "protocol_error",
        attachment.expiresAt <= now
          ? RENDEZVOUS_CLOSE.sessionExpired
          : RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    attachment.stage = "candidate_exchange";
    attachment.clientCandidates = MAX_CLIENT_CANDIDATES;
    attachment.signalBytes += bytes;
    ticket.signalBytes += bytes;
    writeAttachment(socket, attachment);
    writeAttachment(server.socket, server.attachment);
    try {
      server.socket.send(serialized);
    } catch {
      this.failServer(
        server.socket,
        server.attachment,
        "server_unavailable",
        RENDEZVOUS_CLOSE.serverUnavailable,
      );
      return;
    }
    attachment.framesForwarded += 1;
    writeAttachment(socket, attachment);
  }

  private async handleServerMessage(
    socket: WebSocket,
    attachment: ServerAttachment,
    parsed: Extract<RendezvousSignalParseResult, { ok: true }>,
  ): Promise<void> {
    if (
      parsed.signal.type === "client_candidate" ||
      parsed.signal.type === "auth_init" ||
      parsed.signal.type === "auth_proof"
    ) {
      this.failServer(
        socket,
        attachment,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    const ticketDigest = await this.digestTicket(parsed.signal.ticket);
    const current = readServerAttachment(socket);
    const active = this.reconcileActiveServer();
    const now = Date.now();
    if (
      socket.readyState !== WebSocket.OPEN ||
      current === null ||
      !current.current ||
      current.controlId !== attachment.controlId ||
      current.generation !== attachment.generation ||
      active === null ||
      active.socket !== socket ||
      active.attachment.controlId !== current.controlId ||
      active.attachment.generation !== current.generation
    ) {
      closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
      return;
    }

    pruneTicketList(current, now);
    const ticket = current.tickets.find(
      ({ ticketDigest: used }) => used === ticketDigest,
    );
    if (ticket === undefined) {
      this.failServer(
        socket,
        current,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    if (
      (parsed.signal.type === "server_candidate" ||
        parsed.signal.type === "complete") &&
      ((ticket.authorization !== "not_required" &&
        ticket.authorization !== "authorized") ||
        !applyServerFrameBudget(ticket, parsed.signal, parsed.bytes))
    ) {
      this.failServer(
        socket,
        current,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    const target = this.findTicketClient(
      current,
      ticket,
      parsed.signal.ticket,
      now,
    );
    if (target === null) {
      if (parsed.signal.type === "auth_challenge") {
        if (
          ticket.authorization !== "awaiting_challenge" ||
          ticket.signalBytes + parsed.bytes >
            MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES
        ) {
          this.failServer(
            socket,
            current,
            "protocol_error",
            RENDEZVOUS_CLOSE.protocolError,
          );
          return;
        }
        ticket.serverAuthorizationFrames = 1;
        ticket.signalBytes += parsed.bytes;
        ticket.authorization = "awaiting_proof";
      } else if (parsed.signal.type === "auth_result") {
        if (
          ticket.authorization !== "awaiting_result" ||
          ticket.signalBytes + parsed.bytes >
            MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES
        ) {
          this.failServer(
            socket,
            current,
            "protocol_error",
            RENDEZVOUS_CLOSE.protocolError,
          );
          return;
        }
        ticket.serverAuthorizationFrames = 2;
        ticket.signalBytes += parsed.bytes;
        ticket.authorization = parsed.signal.authorized
          ? "authorized"
          : "denied";
      }
      ticket.stage = "terminal";
      writeAttachment(socket, current);
      return;
    }

    if (parsed.signal.type === "auth_challenge") {
      if (
        ticket.stage !== "active" ||
        ticket.authorization !== "awaiting_challenge" ||
        target.attachment.stage !== "awaiting_candidate" ||
        target.attachment.authorization !== "awaiting_challenge" ||
        ticket.signalBytes + parsed.bytes >
          MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES
      ) {
        this.failServer(
          socket,
          current,
          "protocol_error",
          RENDEZVOUS_CLOSE.protocolError,
        );
        return;
      }
      ticket.authorization = "awaiting_proof";
      ticket.serverAuthorizationFrames = 1;
      ticket.signalBytes += parsed.bytes;
      copyTicketBudgetToClient(target.attachment, ticket);
      target.attachment.authorization = "awaiting_proof";
      writeAttachment(socket, current);
      writeAttachment(target.socket, target.attachment);
      try {
        target.socket.send(parsed.serialized);
      } catch {
        this.failClient(
          target.socket,
          target.attachment,
          "internal_error",
          RENDEZVOUS_CLOSE.internalError,
        );
        return;
      }
      target.attachment.framesForwarded += 1;
      writeAttachment(target.socket, target.attachment);
      return;
    }

    if (parsed.signal.type === "auth_result") {
      if (
        ticket.stage !== "active" ||
        ticket.authorization !== "awaiting_result" ||
        target.attachment.stage !== "awaiting_candidate" ||
        target.attachment.authorization !== "awaiting_result" ||
        ticket.signalBytes + parsed.bytes >
          MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES
      ) {
        this.failServer(
          socket,
          current,
          "protocol_error",
          RENDEZVOUS_CLOSE.protocolError,
        );
        return;
      }
      ticket.serverAuthorizationFrames = 2;
      ticket.signalBytes += parsed.bytes;
      ticket.authorization = parsed.signal.authorized
        ? "authorized"
        : "denied";
      if (!parsed.signal.authorized) {
        ticket.stage = "terminal";
      }
      copyTicketBudgetToClient(target.attachment, ticket);
      target.attachment.authorization = parsed.signal.authorized
        ? "authorized"
        : "awaiting_result";
      writeAttachment(socket, current);
      if (parsed.signal.authorized) {
        writeAttachment(target.socket, target.attachment);
      }
      try {
        target.socket.send(parsed.serialized);
      } catch {
        this.failClient(
          target.socket,
          target.attachment,
          "internal_error",
          RENDEZVOUS_CLOSE.internalError,
        );
        return;
      }
      target.attachment.framesForwarded += 1;
      if (!parsed.signal.authorized) {
        this.failClient(
          target.socket,
          target.attachment,
          "authorization_failed",
          RENDEZVOUS_CLOSE.authorizationFailed,
        );
      } else {
        writeAttachment(target.socket, target.attachment);
      }
      return;
    }

    if (
      target.attachment.stage !== "candidate_exchange"
    ) {
      this.failServer(
        socket,
        current,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
      return;
    }

    if (parsed.signal.type === "complete") {
      ticket.stage = "terminal";
    } else {
      copyTicketBudgetToClient(target.attachment, ticket);
    }
    writeAttachment(socket, current);
    if (parsed.signal.type !== "complete") {
      writeAttachment(target.socket, target.attachment);
    }

    try {
      target.socket.send(parsed.serialized);
    } catch {
      copyTicketBudgetToClient(target.attachment, ticket);
      this.failClient(
        target.socket,
        target.attachment,
        "internal_error",
        RENDEZVOUS_CLOSE.internalError,
      );
      return;
    }

    copyTicketBudgetToClient(target.attachment, ticket);
    target.attachment.framesForwarded += 1;
    if (parsed.signal.type === "complete") {
      this.failClient(
        target.socket,
        target.attachment,
        "completed",
        NORMAL_RENDEZVOUS_CLOSE,
      );
    } else {
      writeAttachment(target.socket, target.attachment);
    }
  }

  private findTicketClient(
    server: ServerAttachment,
    ticket: TicketState,
    rawTicket: string,
    now: number,
  ): { socket: WebSocket; attachment: ClientAttachment } | null {
    if (ticket.stage !== "active" || ticket.expiresAt <= now) {
      return null;
    }
    for (const socket of this.ctx.getWebSockets("client")) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = readClientAttachment(socket);
      if (
        attachment !== null &&
        attachment.controlId === server.controlId &&
        attachment.generation === server.generation &&
        attachment.connectionId === ticket.clientConnectionId &&
        attachment.stage !== "terminal" &&
        attachment.expiresAt > now &&
        attachment.ticketDigest === ticket.ticketDigest &&
        attachment.ticket === rawTicket
      ) {
        return { socket, attachment };
      }
    }
    return null;
  }

  private digestTicket(ticket: string): Promise<string> {
    return sha256Hex(ticket);
  }

  private createUpgradeResponse(
    socket: WebSocket,
    inviteProtocol: boolean,
  ): Response {
    const headers = inviteProtocol
      ? { "Sec-WebSocket-Protocol": CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL }
      : undefined;
    return new Response(null, { status: 101, headers, webSocket: socket });
  }

  private prepareServerRetirement(
    server: ActiveServer,
    close: { readonly code: number; readonly reason: string },
  ): ServerRetirement | null {
    server.attachment.current = false;
    if (tryWriteAttachment(server.socket, server.attachment)) {
      this.pendingServerOutcomes.delete(server.socket);
      return {
        server,
        durablyDemoted: true,
        transportRetired: false,
      };
    }

    // The serialized attachment is still current. Only a completed transport
    // close is an eviction-safe substitute for durable demotion.
    server.attachment.current = true;
    rememberBounded(
      this.inactiveControls,
      server.attachment.controlId,
      MAX_EPHEMERAL_CONNECTION_IDS,
    );
    if (closeSocket(server.socket, close)) {
      this.pendingServerOutcomes.delete(server.socket);
      return {
        server,
        durablyDemoted: false,
        transportRetired: true,
      };
    }
    this.inactiveControls.delete(server.attachment.controlId);
    return null;
  }

  private finishServerRetirement(
    retirement: ServerRetirement,
    close: { readonly code: number; readonly reason: string },
  ): void {
    if (retirement.durablyDemoted && !retirement.transportRetired) {
      closeSocket(retirement.server.socket, close);
    }
  }

  private restorePreviousServer(
    retirements: readonly ServerRetirement[],
  ): boolean {
    let restored: ServerRetirement | null = null;
    for (const retirement of retirements) {
      if (
        restored === null &&
        retirement.durablyDemoted &&
        retirement.server.socket.readyState === WebSocket.OPEN
      ) {
        retirement.server.attachment.current = true;
        if (tryWriteAttachment(
          retirement.server.socket,
          retirement.server.attachment,
        )) {
          restored = retirement;
          continue;
        }
        retirement.server.attachment.current = false;
      }
      this.finishServerRetirement(
        retirement,
        RENDEZVOUS_CLOSE.internalError,
      );
    }
    return restored !== null;
  }

  private retireServerImmediately(
    server: ActiveServer,
    close: { readonly code: number; readonly reason: string },
  ): boolean {
    const retirement = this.prepareServerRetirement(server, close);
    if (retirement === null) {
      return false;
    }
    this.finishServerRetirement(retirement, close);
    return true;
  }

  private currentOpenServers(ignoredSocket?: WebSocket): ActiveServer[] {
    const active: ActiveServer[] = [];
    for (const socket of this.ctx.getWebSockets("server")) {
      if (socket === ignoredSocket || socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = readServerAttachment(socket);
      if (
        attachment?.current &&
        attachment.generation === this.currentGeneration
      ) {
        active.push({ socket, attachment });
      }
    }
    return active;
  }

  private reconcileActiveServer(ignoredSocket?: WebSocket): ActiveServer | null {
    // A prior event may have been unable to persist retirement or close a
    // control. Retry that bounded intent before considering any server active.
    this.retryPendingServerTeardowns();

    const active = this.currentOpenServers(ignoredSocket);
    if (active.length <= 1) {
      return active[0] ?? null;
    }

    if (
      new Set(active.map(({ attachment }) => attachment.controlId)).size !==
      active.length
    ) {
      // Control IDs are the ownership boundary for tickets and clients. Two
      // live controls with the same ID cannot be ordered safely, so fail the
      // corrupted room closed instead of accidentally keeping both alive.
      const clientsRetired = this.closeAllClients(
        "internal_error",
        RENDEZVOUS_CLOSE.internalError,
      );
      let retirementFailed = false;
      for (const server of active) {
        const retired = this.retireServerImmediately(
          server,
          RENDEZVOUS_CLOSE.internalError,
        );
        if (!retired) {
          this.pendingServerOutcomes.set(server.socket, "internal_error");
        }
        retirementFailed = !retired || retirementFailed;
      }
      if (retirementFailed) {
        // The shared ID prevents choosing one of the still-current controls.
        // Keep the entire identity inactive in this instance; reconstruction
        // re-runs the same deterministic fail-closed reconciliation.
        rememberBounded(
          this.inactiveControls,
          active[0]!.attachment.controlId,
          MAX_EPHEMERAL_CONNECTION_IDS,
        );
      }
      if (retirementFailed || !clientsRetired) {
        throw new RendezvousTeardownIntegrityError(
          "Rendezvous duplicate controls were not retired",
        );
      }
      return null;
    }

    // A process termination can occur after a replacement is persisted as
    // current but before the previous control is demoted. Select the same
    // winner after every reconstruction and finish the interrupted teardown.
    active.sort(compareActiveServersNewestFirst);
    let winner = active[0];
    if (winner === undefined) {
      return null;
    }
    for (const previous of active.slice(1)) {
      if (!this.retireServerImmediately(
        previous,
        RENDEZVOUS_CLOSE.serverReplaced,
      )) {
        // The previous control is still durably current and transport-live.
        // Prefer it only if the winner established so far can be made safely
        // inactive. Continue through every remaining control before admitting
        // a client so three-way interrupted replacements cannot leave a
        // hidden second winner.
        if (this.retireServerImmediately(
          winner,
          RENDEZVOUS_CLOSE.serverReplaced,
        )) {
          winner = previous;
          continue;
        }
        rememberBounded(
          this.inactiveControls,
          winner.attachment.controlId,
          MAX_EPHEMERAL_CONNECTION_IDS,
        );
        rememberBounded(
          this.inactiveControls,
          previous.attachment.controlId,
          MAX_EPHEMERAL_CONNECTION_IDS,
        );
        this.pendingServerOutcomes.set(winner.socket, "internal_error");
        this.pendingServerOutcomes.set(previous.socket, "internal_error");
        this.closeAllClients(
          "internal_error",
          RENDEZVOUS_CLOSE.internalError,
        );
        throw new RendezvousTeardownIntegrityError(
          "Rendezvous server ownership could not be reconciled",
        );
      }
    }
    if (!this.closeAllClients(
      "server_replaced",
      RENDEZVOUS_CLOSE.serverReplaced,
    )) {
      throw new RendezvousTeardownIntegrityError(
        "Rendezvous reconciled clients were not retired",
      );
    }
    return winner;
  }

  private expireClients(now: number): void {
    let teardownError: RendezvousTeardownIntegrityError | null = null;
    for (const socket of this.ctx.getWebSockets("client")) {
      try {
        const attachment = readClientAttachment(socket);
        if (attachment === null) {
          if (!closeSocket(socket, RENDEZVOUS_CLOSE.internalError)) {
            throw new RendezvousTeardownIntegrityError(
              "Rendezvous invalid client teardown did not complete",
            );
          }
          continue;
        }

        const pendingOutcome = this.pendingClientOutcomes.get(socket);
        if (pendingOutcome !== undefined) {
          this.failClient(
            socket,
            attachment,
            pendingOutcome,
            rendezvousCloseForOutcome(pendingOutcome),
          );
          continue;
        }

        if (attachment.expiresAt <= now) {
          if (attachment.stage === "terminal") {
            const attemptAt = terminalCloseAttemptAt(attachment);
            if (attemptAt !== null && attemptAt <= now) {
              // Persist the attempt before close(). A repeatedly faulting
              // socket receives only the fixed, exponentially spaced budget.
              attachment.terminalCloseAttempts += 1;
              const persisted = tryWriteAttachment(socket, attachment);
              const closed = closeSocket(
                socket,
                RENDEZVOUS_CLOSE.internalError,
              );
              if (!persisted && !closed) {
                // Do not self-schedule the same unpersisted attempt. The
                // alarm handler delegates the double failure to Cloudflare's
                // bounded retry policy after processing every client.
                throw new RendezvousTeardownIntegrityError(
                  "Rendezvous terminal teardown state was not persisted",
                );
              }
            }
          } else {
            this.failClient(
              socket,
              attachment,
              "session_expired",
              RENDEZVOUS_CLOSE.sessionExpired,
            );
          }
        }
      } catch (error) {
        if (error instanceof RendezvousTeardownIntegrityError) {
          teardownError ??= error;
          continue;
        }
        throw error;
      }
    }
    if (teardownError !== null) {
      throw teardownError;
    }
  }

  private pruneServerTickets(now: number): void {
    const hasActiveServer = this.reconcileActiveServer() !== null;
    let invalidatedClients = false;
    let teardownFailed = false;
    for (const socket of this.ctx.getWebSockets("server")) {
      const attachment = readServerAttachment(socket);
      if (attachment === null) {
        if (!hasActiveServer && !invalidatedClients) {
          invalidatedClients = true;
          teardownFailed = !this.closeAllClients(
            "internal_error",
            RENDEZVOUS_CLOSE.internalError,
          ) || teardownFailed;
        }
        teardownFailed = !closeSocket(
          socket,
          RENDEZVOUS_CLOSE.internalError,
        ) || teardownFailed;
        continue;
      }
      if (pruneTicketList(attachment, now)) {
        writeAttachment(socket, attachment);
      }
    }
    if (teardownFailed) {
      throw new RendezvousTeardownIntegrityError(
        "Rendezvous invalid server teardown did not complete",
      );
    }
  }

  private failClient(
    socket: WebSocket,
    attachment: ClientAttachment,
    outcome: RendezvousTerminalOutcome,
    close: { readonly code: number; readonly reason: string },
  ): void {
    const pendingOutcome = this.pendingClientOutcomes.get(socket);
    const canonicalOutcome = attachment.terminalOutcome ??
      pendingOutcome ?? outcome;
    const canonicalClose = pendingOutcome === undefined
      ? close
      : rendezvousCloseForOutcome(canonicalOutcome);
    this.pendingClientOutcomes.set(socket, canonicalOutcome);

    let terminalPersisted =
      attachment.stage === "terminal" && pendingOutcome === undefined;
    if (attachment.stage !== "terminal") {
      this.transitionClientTerminal(attachment, canonicalOutcome);
    }
    if (!terminalPersisted) {
      terminalPersisted = tryWriteAttachment(socket, attachment);
    }
    let summaryPersisted = false;
    if (attachment.terminalOutcome !== null) {
      summaryPersisted = this.emitTerminalMetric(
        socket,
        attachment,
        attachment.terminalOutcome,
      );
    }
    if (terminalPersisted || summaryPersisted) {
      this.pendingClientOutcomes.delete(socket);
    }
    const closed = closeSocket(socket, canonicalClose);
    if (!terminalPersisted && !summaryPersisted && !closed) {
      throw new RendezvousTeardownIntegrityError(
        "Rendezvous client teardown was not persisted",
      );
    }
  }

  private failServer(
    socket: WebSocket,
    attachment: ServerAttachment,
    outcome: RendezvousTerminalOutcome,
    close: { readonly code: number; readonly reason: string },
  ): void {
    const pendingOutcome = this.pendingServerOutcomes.get(socket);
    const canonicalOutcome = pendingOutcome ?? outcome;
    const canonicalClose = pendingOutcome === undefined
      ? close
      : rendezvousCloseForOutcome(canonicalOutcome);
    this.pendingServerOutcomes.set(socket, canonicalOutcome);

    const ownsClients = attachment.current || pendingOutcome !== undefined;
    let retirementPersisted =
      !attachment.current && pendingOutcome === undefined;
    let clientTeardownFailed = false;
    if (attachment.current) {
      rememberBounded(
        this.inactiveControls,
        attachment.controlId,
        MAX_EPHEMERAL_CONNECTION_IDS,
      );
      attachment.current = false;
    }
    if (!retirementPersisted) {
      retirementPersisted = tryWriteAttachment(socket, attachment);
    }
    if (ownsClients) {
      clientTeardownFailed = !this.closeAllClients(
        canonicalOutcome,
        canonicalClose,
      );
    }
    const closed = closeSocket(socket, canonicalClose);
    if (retirementPersisted || closed) {
      this.pendingServerOutcomes.delete(socket);
    }
    if (
      clientTeardownFailed ||
      (!retirementPersisted && !closed)
    ) {
      throw new RendezvousTeardownIntegrityError(
        "Rendezvous server teardown was not persisted",
      );
    }
  }

  private retryPendingServerTeardowns(): void {
    let teardownError: RendezvousTeardownIntegrityError | null = null;
    for (const socket of this.ctx.getWebSockets("server")) {
      const outcome = this.pendingServerOutcomes.get(socket);
      if (outcome === undefined) {
        continue;
      }
      try {
        const attachment = readServerAttachment(socket);
        if (attachment === null) {
          if (!closeSocket(socket, RENDEZVOUS_CLOSE.internalError)) {
            throw new RendezvousTeardownIntegrityError(
              "Rendezvous pending server teardown did not complete",
            );
          }
          this.pendingServerOutcomes.delete(socket);
        } else {
          this.failServer(
            socket,
            attachment,
            outcome,
            rendezvousCloseForOutcome(outcome),
          );
        }
      } catch (error) {
        if (error instanceof RendezvousTeardownIntegrityError) {
          teardownError ??= error;
          continue;
        }
        throw error;
      }
    }
    if (teardownError !== null) {
      throw teardownError;
    }
  }

  private failProtocolViolation(socket: WebSocket): void {
    const attachment = this.readTaggedAttachment(socket);
    if (attachment?.role === "server") {
      this.failServer(
        socket,
        attachment,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
    } else if (attachment?.role === "client") {
      this.failClient(
        socket,
        attachment,
        "protocol_error",
        RENDEZVOUS_CLOSE.protocolError,
      );
    } else {
      if (
        this.ctx.getTags(socket).includes("server") &&
        !this.closeAllClients(
          "internal_error",
          RENDEZVOUS_CLOSE.internalError,
        )
      ) {
        throw new RendezvousTeardownIntegrityError(
          "Rendezvous invalid-server clients were not retired",
        );
      }
      closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
    }
  }

  private markTicketTerminal(client: ClientAttachment): void {
    if (client.ticketDigest === null) {
      return;
    }
    for (const socket of this.ctx.getWebSockets("server")) {
      const server = readServerAttachment(socket);
      if (
        server === null ||
        server.controlId !== client.controlId ||
        server.generation !== client.generation
      ) {
        continue;
      }
      const ticket = server.tickets.find(
        ({ ticketDigest, clientConnectionId }) =>
          ticketDigest === client.ticketDigest &&
          clientConnectionId === client.connectionId,
      );
      if (ticket !== undefined && ticket.stage !== "terminal") {
        ticket.stage = "terminal";
        tryWriteAttachment(socket, server);
      }
    }
  }

  private transitionClientTerminal(
    attachment: ClientAttachment,
    outcome: RendezvousTerminalOutcome,
  ): void {
    if (attachment.stage === "terminal") {
      return;
    }
    this.markTicketTerminal(attachment);
    attachment.stage = "terminal";
    attachment.authorization = "terminal";
    // Terminal callbacks and metrics need only bounded counters. Removing the
    // raw ticket and routing digest prevents a failed transport close from
    // extending their attachment lifetime past the signaling session.
    attachment.ticket = null;
    attachment.ticketDigest = null;
    attachment.terminalOutcome = outcome;
    attachment.terminalCloseAttempts = 0;
  }

  private emitTerminalMetric(
    socket: WebSocket,
    attachment: ClientAttachment,
    outcome: RendezvousTerminalOutcome,
  ): boolean {
    if (
      attachment.summaryEmitted ||
      this.finalizedConnections.has(attachment.connectionId)
    ) {
      return true;
    }
    attachment.summaryEmitted = true;
    if (!tryWriteAttachment(socket, attachment)) {
      // At-most-one is more important than completeness: without a durable
      // marker, a reconstruction could repeat the Analytics Engine write.
      attachment.summaryEmitted = false;
      return false;
    }
    rememberBounded(
      this.finalizedConnections,
      attachment.connectionId,
      MAX_EPHEMERAL_CONNECTION_IDS,
    );
    try {
      this.terminalMetricWriter(this.env.RENDEZVOUS_METRICS, {
        outcome,
        clientFramesAccepted:
          attachment.clientAuthorizationFrames + attachment.clientCandidates,
        serverFramesMatched:
          attachment.serverAuthorizationFrames + attachment.serverCandidates +
            attachment.completionCount,
        framesForwarded: attachment.framesForwarded,
        signalBytes: attachment.signalBytes,
        durationMs: Date.now() - attachment.openedAt,
      });
    } catch {
      // Metrics are best-effort and must never change rendezvous teardown.
    }
    return true;
  }

  private closeAllClients(
    outcome: RendezvousTerminalOutcome,
    close: { readonly code: number; readonly reason: string },
  ): boolean {
    let teardownFailed = false;
    for (const socket of this.ctx.getWebSockets("client")) {
      const attachment = readClientAttachment(socket);
      if (attachment !== null) {
        try {
          this.failClient(socket, attachment, outcome, close);
        } catch (error) {
          if (error instanceof RendezvousTeardownIntegrityError) {
            teardownFailed = true;
          } else {
            throw error;
          }
        }
      } else if (!closeSocket(socket, RENDEZVOUS_CLOSE.internalError)) {
        teardownFailed = true;
      }
    }
    return !teardownFailed;
  }

  private async handleSocketGone(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.ensureInitialized();
    this.messageQueues.delete(socket);
    const attachment = this.readTaggedAttachment(socket);
    if (attachment?.role === "server") {
      this.pendingServerOutcomes.delete(socket);
      const deliberatelyRetired = this.inactiveControls.delete(
        attachment.controlId,
      );
      if (attachment.current && !deliberatelyRetired) {
        const remaining = this.currentOpenServers(socket)
          .sort(compareActiveServersNewestFirst);
        const newestRemaining = remaining[0];
        if (newestRemaining === undefined) {
          if (!this.closeAllClients(
            "server_unavailable",
            RENDEZVOUS_CLOSE.serverUnavailable,
          )) {
            throw new RendezvousTeardownIntegrityError(
              "Rendezvous disconnected-server clients were not retired",
            );
          }
        } else {
          const departed = { socket, attachment };
          const winnerOrder = compareActiveServersNewestFirst(
            departed,
            newestRemaining,
          );
          if (winnerOrder <= 0) {
            let retirementFailed = false;
            for (const previous of remaining) {
              const retired = this.retireServerImmediately(
                previous,
                RENDEZVOUS_CLOSE.serverUnavailable,
              );
              if (!retired) {
                this.pendingServerOutcomes.set(
                  previous.socket,
                  "server_unavailable",
                );
                rememberBounded(
                  this.inactiveControls,
                  previous.attachment.controlId,
                  MAX_EPHEMERAL_CONNECTION_IDS,
                );
              }
              retirementFailed = !retired || retirementFailed;
            }
            const clientsRetired = this.closeAllClients(
              "server_unavailable",
              RENDEZVOUS_CLOSE.serverUnavailable,
            );
            if (retirementFailed || !clientsRetired) {
              throw new RendezvousTeardownIntegrityError(
                "Rendezvous fallback controls were not retired",
              );
            }
          } else {
            const replacement = this.reconcileActiveServer(socket);
            const clientsRetired = this.closeAllClients(
              "server_replaced",
              RENDEZVOUS_CLOSE.serverReplaced,
            );
            if (replacement === null || !clientsRetired) {
              throw new RendezvousTeardownIntegrityError(
                "Rendezvous replacement ownership was not preserved",
              );
            }
          }
        }
      }
    } else if (attachment?.role === "client") {
      const pendingOutcome = this.pendingClientOutcomes.get(socket);
      try {
        if (pendingOutcome !== undefined) {
          this.failClient(
            socket,
            attachment,
            pendingOutcome,
            rendezvousCloseForOutcome(pendingOutcome),
          );
        } else if (attachment.stage !== "terminal") {
          const locallyInitiatedOutcome = rendezvousOutcomeForClose(
            code,
            reason,
          );
          if (locallyInitiatedOutcome === null) {
            this.failClient(
              socket,
              attachment,
              "client_disconnected",
              NORMAL_RENDEZVOUS_CLOSE,
            );
          } else {
            // A reconstruction loses the ephemeral pending-outcome map. An
            // exact room-owned close signature is enough to scrub the ticket,
            // but not trustworthy telemetry because a peer can copy it.
            this.transitionClientTerminal(
              attachment,
              locallyInitiatedOutcome,
            );
            attachment.summaryEmitted = true;
            tryWriteAttachment(socket, attachment);
          }
        } else if (
          !attachment.summaryEmitted &&
          attachment.terminalOutcome !== null
        ) {
          this.emitTerminalMetric(
            socket,
            attachment,
            attachment.terminalOutcome,
          );
        }
      } finally {
        this.pendingClientOutcomes.delete(socket);
      }
    } else if (this.ctx.getTags(socket).includes("server")) {
      if (!this.closeAllClients(
        "internal_error",
        RENDEZVOUS_CLOSE.internalError,
      )) {
        throw new RendezvousTeardownIntegrityError(
          "Rendezvous invalid-server clients were not retired",
        );
      }
    }
    await this.scheduleNextAlarm(Date.now());
  }

  private taggedSocketRole(socket: WebSocket): "client" | "server" | null {
    const tags = this.ctx.getTags(socket);
    return tags.length === 1 && (tags[0] === "client" || tags[0] === "server")
      ? tags[0]
      : null;
  }

  private readTaggedAttachment(socket: WebSocket): RendezvousAttachment | null {
    const attachment = readAttachment(socket);
    return attachment?.role === this.taggedSocketRole(socket)
      ? attachment
      : null;
  }

  private closeSocketsForInitializationFailure(): boolean {
    let stateSanitized = true;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      let persistedSafeState = false;
      if (attachment?.role === "client") {
        if (attachment.stage === "terminal") {
          // The strict decoder guarantees terminal attachments contain no
          // raw ticket or routing digest and already preserve their outcome.
          persistedSafeState = true;
        } else {
          attachment.stage = "terminal";
          attachment.authorization = "terminal";
          attachment.ticket = null;
          attachment.ticketDigest = null;
          attachment.terminalOutcome = "internal_error";
          attachment.terminalCloseAttempts = 0;
          persistedSafeState = tryWriteAttachment(socket, attachment);
        }
      } else if (attachment?.role === "server") {
        attachment.current = false;
        attachment.tickets = [];
        persistedSafeState = tryWriteAttachment(socket, attachment);
      }

      const closed = closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
      if (!persistedSafeState && !closed) {
        stateSanitized = false;
      }
    }
    return stateSanitized;
  }

  private closeSocketsForTeardownRecovery(): boolean {
    let stateSanitized = true;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      let persistedSafeState = false;
      if (attachment?.role === "client") {
        if (attachment.stage !== "terminal") {
          attachment.stage = "terminal";
          attachment.authorization = "terminal";
          attachment.ticket = null;
          attachment.ticketDigest = null;
          attachment.terminalOutcome = "internal_error";
          attachment.terminalCloseAttempts = 0;
        }
        // The generic recovery marker intentionally carries no per-client
        // outcome. Suppress telemetry instead of guessing after reconstruction.
        attachment.summaryEmitted = true;
        persistedSafeState = tryWriteAttachment(socket, attachment);
      } else if (attachment?.role === "server") {
        attachment.current = false;
        attachment.tickets = [];
        persistedSafeState = tryWriteAttachment(socket, attachment);
      }

      const closed = closeSocket(socket, RENDEZVOUS_CLOSE.internalError);
      if (!persistedSafeState && !closed) {
        stateSanitized = false;
      }
    }
    return stateSanitized;
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
    if (this.initializationFailed || this.teardownRecoveryRequired) {
      throw new Error("Rendezvous room initialization failed");
    }
  }

  private async scheduleNextAlarm(now: number): Promise<void> {
    let next: number | null = null;
    for (const socket of this.ctx.getWebSockets("client")) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = readClientAttachment(socket);
      if (attachment !== null) {
        const attemptAt = attachment.stage === "terminal"
          ? terminalCloseAttemptAt(attachment)
          : attachment.expiresAt;
        if (attemptAt !== null) {
          next = earlier(next, Math.max(now + 1, attemptAt));
        }
      }
    }
    for (const socket of this.ctx.getWebSockets("server")) {
      const attachment = readServerAttachment(socket);
      if (
        attachment === null ||
        !attachment.current ||
        socket.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      for (const ticket of attachment.tickets) {
        next = earlier(next, Math.max(now + 1, ticket.expiresAt));
      }
    }
    const admissionExpiry = this.admissions.earliestRetainedExpiryMs();
    if (admissionExpiry !== null) {
      next = earlier(
        next,
        Math.max(now + 1, admissionExpiry),
      );
    }

    if (next === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private async scheduleAdmissionAlarm(now: number): Promise<void> {
    const admissionExpiry = this.admissions.earliestRetainedExpiryMs();
    if (admissionExpiry === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(now + 1, admissionExpiry));
    }
  }

  private async rethrowTeardownFailure(
    error: RendezvousTeardownIntegrityError,
  ): Promise<never> {
    await this.persistTeardownRecoveryRequired();
    throw error;
  }

  private async persistTeardownRecoveryRequired(): Promise<void> {
    try {
      await this.ctx.storage.put(TEARDOWN_RECOVERY_KEY, true);
      this.teardownRecoveryPersisted = true;
    } catch {
      // The fixed session expiry and transport close remain the last-resort
      // bounds when Durable Object storage itself is unavailable.
    }
    await this.scheduleTeardownRetryAlarm();
  }

  private async scheduleTeardownRetryAlarm(): Promise<void> {
    const retryAt = Date.now() + 1;
    try {
      const scheduled = await this.ctx.storage.getAlarm();
      if (scheduled === null || scheduled > retryAt) {
        await this.ctx.storage.setAlarm(retryAt);
      }
    } catch {
      // Preserve the canonical teardown error when even retry scheduling is
      // unavailable. The session expiry remains a hard 15-second fallback.
    }
  }
}

class RendezvousTeardownIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendezvousTeardownIntegrityError";
  }
}

function applyServerFrameBudget(
  ticket: TicketState,
  signal: ServerCandidateSignal | CompleteSignal,
  bytes: number,
): boolean {
  if (
    ticket.signalBytes + bytes >
      MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES
  ) {
    return false;
  }
  if (signal.type === "server_candidate") {
    if (ticket.serverCandidates >= MAX_SERVER_CANDIDATES) {
      return false;
    }
    ticket.serverCandidates += 1;
  } else {
    if (ticket.completionCount >= MAX_COMPLETIONS) {
      return false;
    }
    ticket.completionCount += 1;
  }
  ticket.signalBytes += bytes;
  return true;
}

function countActiveClients(
  sockets: WebSocket[],
  controlId: string,
  generation: string,
  now: number,
): number {
  let count = 0;
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) {
      continue;
    }
    const attachment = readClientAttachment(socket);
    if (
      attachment !== null &&
      attachment.controlId === controlId &&
      attachment.generation === generation &&
      attachment.stage !== "terminal" &&
      attachment.expiresAt > now
    ) {
      count += 1;
    }
  }
  return count;
}

function copyTicketBudgetToClient(
  client: ClientAttachment,
  ticket: TicketState,
): void {
  client.clientAuthorizationFrames = ticket.clientAuthorizationFrames;
  client.serverAuthorizationFrames = ticket.serverAuthorizationFrames;
  client.serverCandidates = ticket.serverCandidates;
  client.completionCount = ticket.completionCount;
  client.signalBytes = ticket.signalBytes;
}

function pruneTicketList(server: ServerAttachment, now: number): boolean {
  const retained = server.tickets.filter(({ expiresAt }) => expiresAt > now);
  if (retained.length === server.tickets.length) {
    return false;
  }
  server.tickets = retained;
  return true;
}

function compareActiveServersNewestFirst(
  left: ActiveServer,
  right: ActiveServer,
): number {
  if (left.attachment.openedAt !== right.attachment.openedAt) {
    return left.attachment.openedAt > right.attachment.openedAt ? -1 : 1;
  }
  if (left.attachment.controlId === right.attachment.controlId) {
    return 0;
  }
  return left.attachment.controlId > right.attachment.controlId ? -1 : 1;
}

function terminalCloseAttemptAt(client: ClientAttachment): number | null {
  if (client.terminalCloseAttempts >= MAX_TERMINAL_CLOSE_ATTEMPTS) {
    return null;
  }
  const offset = TERMINAL_CLOSE_RETRY_OFFSETS_MS[
    client.terminalCloseAttempts
  ];
  return offset === undefined ? null : client.expiresAt + offset;
}

function rendezvousCloseForOutcome(
  outcome: RendezvousTerminalOutcome,
): { readonly code: number; readonly reason: string } {
  switch (outcome) {
    case "completed":
    case "client_disconnected":
      return NORMAL_RENDEZVOUS_CLOSE;
    case "session_expired":
      return RENDEZVOUS_CLOSE.sessionExpired;
    case "protocol_error":
      return RENDEZVOUS_CLOSE.protocolError;
    case "server_unavailable":
      return RENDEZVOUS_CLOSE.serverUnavailable;
    case "server_replaced":
      return RENDEZVOUS_CLOSE.serverReplaced;
    case "authorization_failed":
      return RENDEZVOUS_CLOSE.authorizationFailed;
    case "internal_error":
      return RENDEZVOUS_CLOSE.internalError;
  }
}

function rendezvousOutcomeForClose(
  code: number,
  reason: string,
): RendezvousTerminalOutcome | null {
  for (const outcome of [
    "completed",
    "session_expired",
    "protocol_error",
    "server_unavailable",
    "server_replaced",
    "authorization_failed",
    "internal_error",
  ] as const) {
    const close = rendezvousCloseForOutcome(outcome);
    if (close.code === code && close.reason === reason) {
      return outcome;
    }
  }
  return null;
}

function closeSocket(
  socket: WebSocket,
  close: { readonly code: number; readonly reason: string },
): boolean {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(close.code, close.reason);
    }
    return socket.readyState !== WebSocket.OPEN;
  } catch {
    // Teardown is already in progress and must not leak peer-controlled data.
    return false;
  }
}

function rememberBounded(
  values: Set<string>,
  value: string,
  maximum: number,
): void {
  if (values.has(value)) {
    return;
  }
  while (values.size >= maximum) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    values.delete(oldest);
  }
  values.add(value);
}

function earlier(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

function comparePublishSequences(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length > right.length ? 1 : -1;
  }
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function minimumNextPublishSequence(lastSequence: string): string {
  const maximum = 18_446_744_073_709_551_615n;
  const next = BigInt(lastSequence) + 1n;
  return (next > maximum ? maximum : next).toString();
}

function publicationCommittedResponse(visibleChanged: boolean): Response {
  return new Response(null, {
    status: 204,
    headers: {
      [INTERNAL_DIRECTORY_CHANGED_HEADER]: visibleChanged ? "1" : "0",
    },
  });
}

function publishReplayResponse(minimumNextSequence: string): Response {
  return Response.json(
    {
      error: {
        code: "publish_replay",
        minimumNextSequence,
      },
    },
    {
      status: 409,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function roomError(code: RoomErrorCode): Response {
  const definition = ROOM_ERROR_DEFINITIONS[code];
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  if ("retryAfterSeconds" in definition) {
    headers.set("Retry-After", String(definition.retryAfterSeconds));
  }
  return new Response(definition.body, {
    status: definition.status,
    headers,
  });
}
