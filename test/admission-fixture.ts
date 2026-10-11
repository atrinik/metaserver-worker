import vector from "./fixtures/rendezvous-admission-v1.json";

// Independently generated Python vector: never mine proof-of-work in tests.
export const admissionVector = vector;
export const admissionProof = `${vector.token}.${vector.solution}`;
export const admissionKeys = {
  SOURCE_TAG_KEY_CURRENT_ID: vector.keyId,
  SOURCE_TAG_KEY_CURRENT: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  SOURCE_TAG_KEY_PREVIOUS_ID: "previous",
  SOURCE_TAG_KEY_PREVIOUS: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
};
export function admissionHeaders(protectedClient = false): Record<string, string> {
  return {
    Upgrade: "websocket",
    "X-Atrinik-Rendezvous-Admission": admissionProof,
    ...(protectedClient ? {
      Authorization: `Bearer ${vector.ticket}`,
      "X-Atrinik-Access-Client-Nonce": "b".repeat(64),
      "Sec-WebSocket-Protocol": "atrinik-access-rendezvous-v1",
    } : { "X-Atrinik-Rendezvous-Ticket": vector.ticket }),
  };
}
