-- A random, non-secret generation binds each live Durable Object control to
-- the rendezvous bearer token issued by the same successful publish. Existing
-- rows receive the inert all-zero generation until their next update rotates
-- both values together.
ALTER TABLE server_owners ADD COLUMN rendezvous_generation TEXT NOT NULL
DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
CHECK (
    length(rendezvous_generation) = 64 AND
    rendezvous_generation NOT GLOB '*[^0-9a-f]*'
);

ALTER TABLE servers ADD COLUMN rendezvous_generation TEXT NOT NULL
DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
CHECK (
    length(rendezvous_generation) = 64 AND
    rendezvous_generation NOT GLOB '*[^0-9a-f]*'
);
