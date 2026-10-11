declare const publisher: PublisherEnv;
declare const ambientPublisher: Cloudflare.Env;

publisher.COORDINATOR;
publisher.GLOBAL_RATE_LIMITER;

// @ts-expect-error The public publisher edge owns no database.
publisher.DB;
// @ts-expect-error The public publisher edge owns no Durable Object namespace.
publisher.RENDEZVOUS;
// @ts-expect-error The public publisher edge owns no object storage.
publisher.DIRECTORY_GENERATIONS;

// @ts-expect-error The publisher project's ambient Env is also state-free.
ambientPublisher.DB;

// @ts-expect-error Signing secrets belong only to the core.
publisher.SOURCE_TAG_KEY_CURRENT;
// @ts-expect-error Replay key IDs belong only to the core.
publisher.SOURCE_TAG_KEY_CURRENT_ID;

export {};
