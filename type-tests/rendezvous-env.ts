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

export {};
