# Classic directory protocol 5

Classic protocol 5 is the public projection of accepted
`atrinik-classic-publish-v2` state. It is a new contract, not a reinterpretation
of protocol 4. The canonical JSON constants are
`schema="atrinik-classic-directory-v5"` and `protocol=5`; XML uses the same
schema and `protocol="5"`.

The server order and common fields remain certificate identity, name, player
count, version, comment, certificate fingerprint, and an optional explicit DNS
hostname/UDP port. The policy field is exactly `accessCodeRequired` in JSON and
`AccessCodeRequired` in XML, in the corresponding protocol-4 field position.
HTML labels it `Access code` and renders only `open` or `protected`. Protocol 5
never emits `passwordRequired`, `PasswordRequired`, a password label, a raw
access code, invite, proof, token, signature, nonce, or source address.

A public protected server may still expose its signed endpoint; protection is
an authorization policy, not endpoint concealment. A private publication is
absent from every artifact and retains no display, endpoint, or access-policy
field. Exact reviewed examples live in
`test/fixtures/classic-directory-v5/index.{json,xml,html}`.

## Publication and cutover

The builder writes immutable objects under the profile-qualified private
generation prefix. Public aliases are selected by the required
`CLASSIC_DIRECTORY_CUTOVER_MODE`:

- `v4-production` keeps protocol 4 at root `index.*` and writes protocol 5 only
  under `canary-v5/`;
- `v5-production` puts protocol 5 at root `index.*` and moves any remaining
  protocol-4 reconciliation under `precutover-v4/`.

The checked-in value is `v4-production`. Changing it is a one-way human gate,
not a time-, traffic-, publish-, or deployment-triggered transition. Before
selecting `v5-production`, validate the isolated v5 origin with
`scripts/static_origin_canary.py --profile classic-v2 --alias-prefix canary-v5`, record exact
generation/schema/representation checksums, and obtain explicit human
acceptance. After production alias convergence is accepted, use the separate
global v1 retirement procedure; never switch the configuration back to expose
v4 at the production aliases.
