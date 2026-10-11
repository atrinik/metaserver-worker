declare const rendezvous: RendezvousEnv;
declare const ambientRendezvous: Cloudflare.Env;

rendezvous.COORDINATOR;
rendezvous.GLOBAL_RATE_LIMITER;
rendezvous.RENDEZVOUS_CLIENT_RATE_LIMITER;

// @ts-expect-error The public rendezvous edge owns no database.
rendezvous.DB;
// @ts-expect-error The public rendezvous edge owns no Durable Object namespace.
rendezvous.RENDEZVOUS;
// @ts-expect-error The public rendezvous edge owns no object storage.
rendezvous.CLASSIC_DIRECTORY_PUBLIC;

// @ts-expect-error The rendezvous project's ambient Env is also state-free.
ambientRendezvous.DB;

// @ts-expect-error Signing secrets belong only to the core.
rendezvous.SOURCE_TAG_KEY_CURRENT;
// @ts-expect-error Replay key IDs belong only to the core.
rendezvous.SOURCE_TAG_KEY_CURRENT_ID;

export {};
