export interface DirectoryServerRecord {
  server_id: string;
  name: string;
  players_count: number;
  version: string;
  text_comment: string;
  quic_host: string;
  quic_port: number;
  quic_cert_sha256: string;
  password_required: number;
}

export interface RendezvousServerRecord {
  is_public: number;
  password_required: number;
  rendezvous_token_hash: string;
}

export interface OwnerAuthRecord {
  auth_key: string;
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
