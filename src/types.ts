export interface DirectoryServerRecord {
  server_id: string;
  name: string;
  players_count: number;
  version: string;
  text_comment: string;
  hostname: string | null;
  port: number | null;
  quic_cert_sha256: string;
  password_required: number;
}

export interface RendezvousServerRecord {
  password_required: number;
  rendezvous_token_hash: string;
  rendezvous_generation: string;
}

export interface OwnerAuthRecord {
  auth_key: string;
  authentication_kind: "compat-key-v1" | "signed-certificate-v1";
}

export interface UpdatePayload {
  serverId: string;
  name: string;
  playersCount: number;
  version: string;
  textComment: string;
  otp: string;
  cotp: string;
  key: string;
  registration: boolean;
  isPublic: boolean;
  quicHost: string | null;
  quicPort: number;
  quicCertSha256: string;
  passwordRequired: boolean;
}
