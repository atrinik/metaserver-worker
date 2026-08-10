import type {
  DirectoryArtifactConfigurationInput,
  PublisherCoordinatorConfigurationInput,
  RendezvousCoordinatorConfigurationInput,
  RendezvousPolicyConfigurationInput,
  RequestControlConfigurationInput,
} from "./config";
import type { SourceTagKeyEnvironment } from "./privacy";
import type { DirectoryBuilder } from "./directory-builder";
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
  & RequestControlConfigurationInput
  & SourceTagKeyEnvironment
  & {
    readonly DB: D1Database;
    readonly DIRECTORY_GENERATIONS: R2Bucket;
    readonly CLASSIC_DIRECTORY_PUBLIC: R2Bucket;
    readonly GAME_DIRECTORY_PUBLIC: R2Bucket;
    readonly RENDEZVOUS_METRICS: AnalyticsEngineDataset;
    readonly DIRECTORY_METRICS: AnalyticsEngineDataset;
    readonly GLOBAL_RATE_LIMITER: RateLimit;
    readonly DIRECTORY_RATE_LIMITER: RateLimit;
    readonly OTP_RATE_LIMITER: RateLimit;
    readonly UPDATE_RATE_LIMITER: RateLimit;
    readonly PUBLISH_IDENTITY_RATE_LIMITER: RateLimit;
    readonly RENDEZVOUS_CLIENT_RATE_LIMITER: RateLimit;
    readonly RENDEZVOUS_SERVER_RATE_LIMITER: RateLimit;
    readonly RENDEZVOUS: DurableObjectNamespace<RendezvousRoom>;
    readonly DIRECTORY_BUILDER: DurableObjectNamespace<DirectoryBuilder>;
    readonly COMPAT_HOSTNAME: string;
    readonly COMPAT_STATUS_ENABLED?: string;
    readonly COMPAT_DIRECTORY_ENABLED?: string;
    readonly COMPAT_OTP_ENABLED?: string;
    readonly COMPAT_UPDATE_ENABLED?: string;
    readonly PUBLISH_ENABLED?: string;
    readonly GAME_PUBLISH_ENABLED?: string;
    readonly RENDEZVOUS_ENABLED?: string;
    readonly COMPAT_RENDEZVOUS_ENABLED?: string;
  };
