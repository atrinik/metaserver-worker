import type {
  DirectoryArtifactConfigurationInput,
  PublisherCoordinatorConfigurationInput,
  RendezvousCoordinatorConfigurationInput,
  RendezvousPolicyConfigurationInput,
  ScheduledMaintenanceConfigurationInput,
} from "./config";
import type { DirectoryCachePurgeEnvironment } from "./directory-cache-purge";
import type { DirectoryBuilder } from "./directory-builder";
import type { SourceTagKeyEnvironment } from "./privacy";
import type { RendezvousRoom } from "./rendezvous-room";

/**
 * Explicit capability surface owned by the stateful core Worker.
 *
 * Keeping this module-local prevents stateless edge projects from loading the
 * generated core `Cloudflare.Env` augmentation merely to resolve named
 * Service Binding entrypoint types.
 */
export type CoreEnv =
  & DirectoryArtifactConfigurationInput
  & PublisherCoordinatorConfigurationInput
  & RendezvousCoordinatorConfigurationInput
  & RendezvousPolicyConfigurationInput
  & ScheduledMaintenanceConfigurationInput
  & SourceTagKeyEnvironment
  & DirectoryCachePurgeEnvironment
  & {
    readonly DB: D1Database;
    readonly DIRECTORY_GENERATIONS: R2Bucket;
    readonly CLASSIC_DIRECTORY_PUBLIC: R2Bucket;
    readonly GAME_DIRECTORY_PUBLIC: R2Bucket;
    readonly RENDEZVOUS_METRICS: AnalyticsEngineDataset;
    readonly DIRECTORY_METRICS: AnalyticsEngineDataset;
    readonly PUBLISH_IDENTITY_RATE_LIMITER: RateLimit;
    readonly RENDEZVOUS_SERVER_RATE_LIMITER: RateLimit;
    readonly RENDEZVOUS: DurableObjectNamespace<RendezvousRoom>;
    readonly DIRECTORY_BUILDER: DurableObjectNamespace<DirectoryBuilder>;
    readonly RENDEZVOUS_HOSTNAME: string;
    readonly PUBLISH_ENABLED?: string;
    readonly GAME_PUBLISH_ENABLED?: string;
    readonly RENDEZVOUS_ENABLED?: string;
  };
