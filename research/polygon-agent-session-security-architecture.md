# Polygon Agent Session Protocol — Security Architecture

**Document classification:** Internal — Security Review
**Version:** 1.0 draft
**Date:** 2026-03-24
**Author:** Taylan Pince, SVP Engineering
**Review audience:** Security engineering, cryptography review, infrastructure security

---

## 1. Problem Statement

The Polygon Wallet Agent Session Protocol enables a local AI agent CLI to
receive delegated smart session credentials from a browser-based Ecosystem
Wallet. The browser and CLI run on the same user's machine but in different
execution contexts (browser tab vs. terminal process) with no shared memory,
no shared storage, and no pre-established trust relationship.

The protocol must transfer session material — specifically a secp256k1 private
key scoped to a smart session with bounded permissions and expiry — from the
browser to the CLI without:

1. Exposing session material to any intermediary in plaintext
2. Requiring a persistent server that holds or can derive secrets
3. Being vulnerable to man-in-the-middle substitution at the relay
4. Requiring the user to manually copy large opaque data blobs

The design targets a non-custodial security model: the user's master wallet
key never leaves the browser, and the delegated session key is scoped by
on-chain smart session contracts that enforce spending limits, allowed
contract interactions, and time-bound expiry.

---

## 2. Architecture Overview

Three participants:

```
CLI (local)  ←——→  Relay (Cloudflare Worker + Durable Object)  ←——→  Browser Wallet (local)
```

The relay is a stateless encrypted mailbox. It stores opaque ciphertext for a
bounded time window and enforces rate limits on retrieval attempts. It has no
access to plaintext session material at any point in the protocol.

The browser wallet is the Sequence Ecosystem Wallet running in a standard
browser context. It holds the user's master wallet credentials (passkey-based)
and can create scoped smart sessions.

The CLI is a Node.js process running on the same machine. It generates
ephemeral key material, receives encrypted session data via the relay, and
stores decrypted session credentials in the OS keychain.

---

## 3. Cryptographic Primitives

| Primitive | Algorithm | Library | Justification |
|-----------|-----------|---------|---------------|
| Key agreement | X25519 (Curve25519 ECDH) | `@noble/curves` | Standard elliptic curve Diffie-Hellman. 128-bit security level. Pure JS, audited, no native dependencies. Runs identically in Node.js and Cloudflare Workers. |
| Key derivation | HKDF-SHA-256 (RFC 5869) | `@noble/hashes` | Standard two-stage extract-and-expand KDF. Used to derive a 256-bit symmetric key from the ECDH shared secret combined with the out-of-band code. |
| Authenticated encryption | XChaCha20-Poly1305 | `@noble/ciphers` | AEAD cipher with 192-bit nonce (safe for random nonce generation without birthday-bound concerns). 256-bit key. Poly1305 provides authentication. Chosen over AES-256-GCM due to nonce size safety margin and absence of timing side-channel concerns in pure JS implementations. |
| Hashing | SHA-256 | `@noble/hashes` | Used for code hashing (relay-side comparison) and HKDF salt derivation. |
| Random generation | `crypto.getRandomValues()` | Web Crypto API / Node.js `crypto` | CSPRNG for nonce generation, code generation, and ephemeral key generation. |

All cryptographic operations use the `@noble/*` library family (author:
Paul Miller). These libraries are:

- Audited by Cure53 (audit report publicly available)
- Zero runtime dependencies
- Pure JavaScript (no native bindings, no WASM)
- Constant-time where required (scalar multiplication, MAC comparison)
- Compatible with both Node.js and Cloudflare Workers runtime

No Web Crypto API is used for the core protocol. This avoids subtle
cross-platform behavioral differences in key import/export formats and
ensures identical codepaths in browser and CLI.

---

## 4. Protocol Specification

### 4.1 Constants

```
PROTOCOL_VERSION    = "polygon-agent-session-v1"   // domain separator
CODE_DIGITS         = 6                             // 10^6 = 1,000,000 possibilities
MAX_CODE_ATTEMPTS   = 3                             // relay-enforced
REQUEST_TTL         = 300 seconds                   // 5 minutes
REQUEST_ID_LENGTH   = 8 characters                  // nanoid, alphanumeric lowercase
```

### 4.2 Phase 1 — Request Initialization (CLI → Relay)

```
1. CLI generates an ephemeral X25519 keypair:
     cli_sk ← random 32 bytes (CSPRNG)
     cli_pk = X25519.scalarMultBase(cli_sk)          // 32 bytes

2. CLI registers with relay:
     POST /api/relay/request { cli_pk: hex(cli_pk) }
     ← { request_id: "a7b3x9k2" }

3. Relay creates a Durable Object keyed by request_id:
     Stores: { cli_pk, status: "pending", attempts_remaining: 3 }
     Sets alarm: delete all state after REQUEST_TTL

4. CLI opens browser:
     open("https://{relay_domain}/agent?rid={request_id}")
```

**Security properties at this stage:**

- `cli_sk` exists only in CLI process memory
- `cli_pk` is a public value; its exposure is not a security concern
- `request_id` is not secret; it is an opaque lookup key
- The relay stores only the public key; no secret material is present

### 4.3 Phase 2 — Wallet Connection + Session Approval (Browser)

```
5. Browser SPA fetches cli_pk from relay:
     GET /api/relay/request/{request_id}
     ← { cli_pk: hex(cli_pk) }

6. User creates or connects their Ecosystem Wallet (passkey auth).

7. User reviews and approves a smart session:
     - Scoped permissions (spending limits, allowed contracts)
     - Time-bound expiry
     The wallet SDK produces session material:
       session_payload = { wallet_address, chain_id, session_private_key,
                           session_address, permissions, expiry, ... }
```

**Security properties at this stage:**

- The smart session approval is a standard Ecosystem Wallet flow with
  user-facing consent UI
- Session permissions are enforced on-chain by the smart session module,
  independent of this protocol
- `session_private_key` is the high-value secret that must be protected
  during transfer

### 4.4 Phase 3 — Encryption + Code Generation (Browser)

```
8. Browser generates an ephemeral X25519 keypair:
     wallet_sk ← random 32 bytes (CSPRNG)
     wallet_pk = X25519.scalarMultBase(wallet_sk)

9. ECDH key agreement:
     shared = X25519(wallet_sk, cli_pk)               // 32-byte shared secret

10. Browser generates a random 6-digit code:
      code_int = CSPRNG_uint32() mod 1,000,000
      code_str = zero_pad(code_int, 6)                // e.g. "047291"

11. Key derivation (HKDF-SHA-256):
      enc_key = HKDF(
        hash  = SHA-256,
        ikm   = shared,                               // 32 bytes, ECDH output
        salt  = SHA-256(UTF8(code_str)),               // 32 bytes, hashed code
        info  = UTF8(hex(cli_pk) || hex(wallet_pk) || PROTOCOL_VERSION),
        len   = 32                                     // 256-bit output key
      )

12. Authenticated encryption (XChaCha20-Poly1305):
      nonce = random 24 bytes (CSPRNG)
      aad   = cli_pk || wallet_pk                      // 64 bytes, raw
      ciphertext || tag = XChaCha20-Poly1305.encrypt(
        key       = enc_key,
        nonce     = nonce,
        plaintext = UTF8(JSON.stringify(session_payload)),
        aad       = aad
      )

13. Code hash for relay-side rate limiting:
      code_hash = SHA-256(UTF8(request_id || code_str))

14. Browser posts to relay:
      POST /api/relay/session/{request_id}
      { wallet_pk: hex(wallet_pk),
        nonce: hex(nonce),
        ciphertext: base64url(ciphertext || tag),
        code_hash: hex(code_hash) }

15. Browser displays to user:
      "Enter this code in your terminal: 047291"
```

**Security properties at this stage:**

- `enc_key` depends on TWO independent secrets:
  - The ECDH shared secret (`shared`): computationally hard, requires
    knowledge of either `cli_sk` or `wallet_sk`
  - The 6-digit code (`code_str`): information-theoretically weak alone
    (20 bits), but carried out-of-band (human visual channel → keyboard)
- The code is mixed into the HKDF **salt**, not merely appended to plaintext.
  This means the code participates in key derivation itself, not just
  in a post-hoc verification step
- `wallet_sk` is zeroed from memory after ECDH computation
- The relay receives `code_hash` but cannot invert it without brute-forcing
  SHA-256 over 1M candidates (see Section 5.3 for analysis)

### 4.5 Phase 4 — Retrieval + Decryption (CLI)

```
16. CLI polls relay:
      GET /api/relay/status/{request_id}
      ← { status: "ready" }

17. User enters the 6-digit code in the terminal.

18. CLI submits code hash to relay:
      POST /api/relay/retrieve/{request_id}
      { code_hash: hex(SHA-256(UTF8(request_id || user_code))) }

19. Relay verifies (constant-time comparison):
      If code_hash matches stored code_hash:
        Return { wallet_pk, nonce, ciphertext }
        Delete all state for this request_id
      If code_hash does not match:
        Decrement attempts_remaining
        If attempts_remaining == 0:
          Delete all state, return HTTP 410
        Else:
          Return HTTP 403 with attempts_remaining

20. CLI decrypts:
      shared = X25519(cli_sk, wallet_pk)

      enc_key = HKDF(
        hash  = SHA-256,
        ikm   = shared,
        salt  = SHA-256(UTF8(user_code)),
        info  = UTF8(hex(cli_pk) || hex(wallet_pk) || PROTOCOL_VERSION),
        len   = 32
      )

      aad = cli_pk || wallet_pk

      session_payload = XChaCha20-Poly1305.decrypt(
        key        = enc_key,
        nonce      = nonce,
        ciphertext = ciphertext,
        aad        = aad
      )

      If Poly1305 tag verification fails → abort (wrong code or tampering)

21. CLI stores session_payload in OS keychain (macOS Keychain / Linux
    libsecret) and zeros all intermediate key material from memory.
```

**Security properties at this stage:**

- The relay only releases the ciphertext after a correct `code_hash` is
  submitted (see Section 5.2 for why this matters)
- Even if the CLI receives the ciphertext, decryption requires both the
  correct ECDH shared secret AND the correct code to derive `enc_key`
- Poly1305 tag verification provides ciphertext authentication: any
  tampering with the ciphertext, nonce, or AAD causes decryption failure
- After successful decryption, `cli_sk`, `shared`, and `enc_key` are
  zeroed from process memory (best-effort in JavaScript: TypedArray.fill(0))

---

## 5. Threat Analysis

### 5.1 Passive Network Eavesdropper

**Attacker capability:** Observes all traffic between CLI ↔ Relay and
Browser ↔ Relay (TLS terminated, attacker has cleartext HTTP payloads).

**What attacker sees:**
- `cli_pk` (Phase 1)
- `wallet_pk`, `nonce`, `ciphertext`, `code_hash` (Phase 3)
- `code_hash` submitted by CLI (Phase 4)

**What attacker does NOT have:**
- `cli_sk` or `wallet_sk` (never transmitted)
- `code_str` (transmitted only via human visual channel)
- `shared` (requires ECDH with a private key)
- `enc_key` (derived from `shared` + `code_str`)

**Result:** Attacker cannot derive `enc_key`. Ciphertext is indistinguishable
from random. **No information leakage.**

Note: In practice, all relay communication uses TLS, so an eavesdropper
would not see cleartext payloads. This analysis assumes a worst-case
TLS compromise to demonstrate defense in depth.

### 5.2 Compromised Relay

**Attacker capability:** Full control of the relay. Can read and modify all
stored state, intercept all API calls, and execute arbitrary code.

**What attacker has:**
- `cli_pk`, `wallet_pk` (public keys)
- `nonce`, `ciphertext` (encrypted payload)
- `code_hash` = SHA-256(request_id || code_str)

**Attack 1 — Decrypt the ciphertext directly:**
Requires `enc_key`, which requires `shared` + `code_str`.
Computing `shared` requires `cli_sk` or `wallet_sk`. The relay has neither.
**Fails.**

**Attack 2 — Brute-force the code from `code_hash`:**
`code_hash` = SHA-256(request_id || code_str), where `code_str` has 10^6
possibilities. SHA-256 at ~10M hashes/sec on commodity hardware: 0.1 seconds
to enumerate all candidates. **The relay can learn the code.**

However, knowing the code alone is insufficient. `enc_key` derivation
requires `HKDF(shared, SHA-256(code_str), ...)` where `shared` is the ECDH
output. The relay does not have either private key and therefore cannot
compute `shared`. **Knowing the code without the ECDH secret is useless.**

**Attack 3 — Release ciphertext without code verification:**
A compromised relay could skip the code_hash check and return the ciphertext
to any requester. This would expose the ciphertext to an attacker who also
controls the network. However, decryption still requires `enc_key`, which
requires both `shared` AND the code. An attacker with the ciphertext but
without either the ECDH secret or the code cannot decrypt.

The code_hash gate serves a different purpose: it prevents a **MITM attacker**
(Section 5.3) from obtaining the ciphertext to mount an offline brute-force
attack. If the relay is itself the MITM, this defense is moot — but the relay
cannot be a MITM without also controlling the ECDH (see Section 5.3).

**Result:** A compromised relay can learn the 6-digit code but cannot decrypt
the session material. **No information leakage of session secrets.**

### 5.3 Man-in-the-Middle (MITM) at the Relay

This is the primary threat the protocol is designed to resist.

**Attacker capability:** Controls the relay. Can substitute public keys and
intercept payloads.

**Attack scenario:**

```
CLI                    Attacker (relay)              Browser Wallet
 |                          |                              |
 | POST cli_pk ----------> |                              |
 |                          | [stores cli_pk, generates    |
 |                          |  attacker_sk, attacker_pk]   |
 |                          |                              |
 |                          | GET cli_pk?rid=...           |
 |                          | → returns attacker_pk        | ← substitution
 |                          |  (instead of cli_pk)         |
 |                          |                              |
 |                          |    [wallet does ECDH with    |
 |                          |     attacker_pk, not cli_pk] |
 |                          |                              |
 |                          | ← POST { wallet_pk, nonce,  |
 |                          |   ciphertext_A, code_hash }  |
 |                          |                              |
 |                          | [attacker computes           |
 |                          |  shared_A = X25519(          |
 |                          |    attacker_sk, wallet_pk)]  |
 |                          |                              |
 |                          | [attacker needs code to      |
 |                          |  derive enc_key_A and        |
 |                          |  decrypt ciphertext_A]       |
```

**The attacker's problem:** The wallet encrypted the session payload with
`enc_key_A = HKDF(shared_A, SHA-256(code_str), ...)`. The attacker knows
`shared_A` (they have `attacker_sk` and `wallet_pk`). But they do NOT know
`code_str`.

**Can the attacker brute-force the code?**

The attacker has `shared_A` and `ciphertext_A`. They could enumerate all
10^6 possible codes, derive a candidate `enc_key` for each, and attempt
XChaCha20-Poly1305 decryption. If the Poly1305 tag verifies, they found
the correct code.

Computational cost: 10^6 × (1 HKDF + 1 XChaCha20-Poly1305 decrypt)
≈ 10^6 × ~1μs ≈ **1 second on commodity hardware.**

**This is feasible.** Therefore, the relay-side code gate (Section 4.5,
step 19) is essential. The relay does not release `ciphertext_A` until
a correct `code_hash` is submitted. The MITM attacker does not have the
code (it's on the user's screen), so they cannot submit the correct
`code_hash`. They get at most 3 guesses (out of 10^6 possibilities;
probability of success: 3 × 10^-6).

**Wait — if the attacker IS the relay, can't they skip the code gate?**

Yes. If the attacker controls the relay, they can access `ciphertext_A`
directly without the code gate. In this case, the 1-second offline
brute-force described above becomes possible.

**This is the residual risk.** A MITM who fully controls the relay can:
1. Substitute `cli_pk` with `attacker_pk`
2. Receive the ciphertext (they control the storage)
3. Brute-force the 6-digit code in ~1 second
4. Decrypt the session material
5. Re-encrypt it for the real `cli_pk` and serve it to the CLI

**Mitigation — Hardened KDF option:**

To make offline brute-force expensive, replace the HKDF salt derivation with
a memory-hard function:

```
salt = Argon2id(
  password = code_str,
  salt     = request_id,
  time     = 3,          // 3 iterations
  memory   = 65536,      // 64 MB
  len      = 32
)
enc_key = HKDF(SHA-256, shared, salt, info, 32)
```

Cost per candidate: ~500ms (Argon2id with 64MB memory).
Cost of full brute-force: 10^6 × 0.5s = **~5.8 days on a single core.**
With a 16-core machine: ~8.7 hours.
With a GPU cluster (100 GPUs): Argon2id is memory-hard, so GPU parallelism
is limited. Realistic estimate: **~2-4 hours** for a well-resourced attacker.

**Assessment:** Argon2id hardening raises the cost of a relay-MITM attack from
trivial (1 second) to operationally meaningful (hours). Combined with the
5-minute TTL on relay state and the fact that the session material itself has
a time-bound expiry (default 24h, max 7d), this shifts the attack from
"easy" to "expensive and time-bounded."

**Recommendation:** Implement Argon2id hardening for v1 if the browser-side
performance budget allows. Argon2id at 64MB / 3 iterations takes ~500ms in
a browser — noticeable but acceptable as a one-time cost during session setup.
In the CLI (Node.js), the same operation is comparable. If browser performance
is unacceptable, fall back to HKDF-only for v1 and add Argon2id when the
Smart Sessions API (Section 8) eliminates the relay entirely.

### 5.4 Brute-Force Code at Relay (Without MITM)

**Attacker capability:** Can submit code guesses to the relay's retrieve
endpoint but does NOT control the relay and did NOT substitute public keys.

**Constraint:** The relay enforces MAX_CODE_ATTEMPTS = 3. After 3 incorrect
submissions, the request is permanently deleted.

**Probability of success:** 3 / 1,000,000 = **0.0003%.**

The code_hash comparison uses constant-time equality to prevent timing
side-channels.

**Result:** Negligible risk.

### 5.5 Replay Attack

**Attacker capability:** Captures a valid `{ wallet_pk, nonce, ciphertext }`
payload and attempts to replay it.

**Mitigations:**
- Each `request_id` is single-use: once retrieved, the Durable Object
  deletes all state
- Ephemeral X25519 keypairs: even if the same relay were reused, new keypairs
  produce a new shared secret
- 5-minute TTL: state is auto-deleted regardless of retrieval

**Result:** Replay provides no value. **No risk.**

### 5.6 Session Material Compromise (Post-Protocol)

**Attacker capability:** Gains access to the user's machine after the
protocol completes.

**What attacker can access:**
- OS keychain entry containing `session_payload` (encrypted at rest by
  macOS Keychain / Linux libsecret)
- Accessing keychain contents requires OS-level authentication (user
  password, biometric, or root access)

**What attacker CANNOT access:**
- The user's master wallet key (stored in the browser's WebAuthn credential
  store, bound to the wallet domain origin)
- Session material beyond the approved scope (spending limits, allowed
  contracts, and expiry are enforced on-chain by the smart session module)

**Worst-case impact:** Attacker can use the delegated session within its
approved scope until expiry. They cannot escalate privileges, extract the
master wallet key, or bypass on-chain permission boundaries.

**Mitigations:**
- Short default session expiry (24 hours)
- User can revoke sessions via the wallet UI at any time
- On-chain permission enforcement is independent of client-side security

### 5.7 Malicious Browser Extension / Compromised Browser

**Attacker capability:** Can read all browser-side state including the
session material before encryption, the 6-digit code, and the wallet's
master credentials.

**Assessment:** This is outside the protocol's threat model. A compromised
browser can steal the master wallet credentials directly (passkey exfiltration
or session hijacking), making the agent session protocol irrelevant. This is
a general wallet security concern, not specific to this protocol.

**Mitigation:** Standard browser security hygiene. The Ecosystem Wallet's
passkey-based authentication provides hardware-bound credential protection
on devices that support platform authenticators.

---

## 6. Relay Security Properties

### 6.1 State Lifecycle

```
CREATE  → POST /api/relay/request
           Stores: { cli_pk, status: "pending", attempts: 3 }
           Starts: TTL alarm (5 minutes)

FILL    → POST /api/relay/session/{rid}
           Adds: { wallet_pk, nonce, ciphertext, code_hash }
           Sets: status = "ready"
           Constraint: single-write (409 if already filled)

RETRIEVE → POST /api/relay/retrieve/{rid}
           If code matches: return payload, DELETE all state
           If code fails: decrement attempts
           If attempts = 0: DELETE all state

EXPIRE  → Alarm fires after 5 minutes
           DELETE all state unconditionally
```

**Invariants:**
- State exists for at most 5 minutes
- Ciphertext is released at most once
- Maximum 3 code attempts per request
- No state survives beyond the TTL alarm

### 6.2 Data at Rest

The Durable Object stores:
- `cli_pk`: public value, no confidentiality requirement
- `wallet_pk`: public value, no confidentiality requirement
- `nonce`: public value (nonces are not secret in AEAD schemes)
- `ciphertext`: encrypted, indecipherable without `enc_key`
- `code_hash`: SHA-256 of a low-entropy value; invertible by the relay
  operator but useless without the ECDH secret (see Section 5.2)

**No secret material is stored in the relay at any point in the protocol.**

### 6.3 Rate Limiting

| Endpoint | Limit | Scope |
|----------|-------|-------|
| POST /api/relay/request | 10/min | Per IP |
| GET /api/relay/status/{rid} | 60/min | Per IP |
| POST /api/relay/retrieve/{rid} | 3 attempts | Per request_id (Durable Object enforced) |

### 6.4 Constant-Time Comparison

The code_hash comparison in the Durable Object MUST use constant-time
equality to prevent timing side-channels:

```typescript
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i]
  }
  return result === 0
}
```

Although the code_hash is derived from a low-entropy input (6 digits),
a timing oracle could reduce the brute-force space from 10^6 to
significantly fewer attempts by leaking byte-by-byte match information.
Constant-time comparison prevents this.

---

## 7. Channel Binding and Domain Separation

### 7.1 HKDF Info String

The HKDF `info` parameter includes both public keys and a protocol version
string:

```
info = hex(cli_pk) || hex(wallet_pk) || "polygon-agent-session-v1"
```

This provides:
- **Session binding:** The derived key is unique to this specific pair of
  ephemeral keys. Reusing a code with different keys produces a different
  `enc_key`.
- **Protocol versioning:** Future protocol changes use a different `info`
  string, preventing cross-version key reuse.

### 7.2 Additional Authenticated Data (AAD)

The XChaCha20-Poly1305 AAD includes both raw public keys:

```
aad = cli_pk || wallet_pk    // 64 bytes, raw binary
```

This binds the ciphertext to the specific key exchange. If an attacker
modifies either public key after encryption, the Poly1305 tag will fail
during decryption.

### 7.3 Nonce Safety

XChaCha20-Poly1305 uses a 192-bit nonce. With random nonce generation,
the birthday bound for nonce collision is ~2^96 encryptions under the
same key. Since each `enc_key` is used for exactly one encryption (ephemeral
keys guarantee this), nonce collision is not a concern even with random
generation.

---

## 8. Future Architecture — Smart Sessions API

When the Smart Sessions API becomes available (estimated April 2026), the
protocol changes fundamentally:

```
CLI                                API                    Browser Wallet
 |                                  |                          |
 | [generate session keypair]      |                          |
 | POST /sessions/create           |                          |
 |   { session_pubkey, perms }     |                          |
 | ← { session_id }               |                          |
 |                                  |                          |
 | [open browser to approve URL]  |                          |
 |                                  | ← user approves         |
 |                                  |    session_id            |
 |                                  |                          |
 | GET /sessions/{id}/status       |                          |
 | ← { status: "approved" }       |                          |
 |                                  |                          |
 | [CLI already holds session_sk] |                          |
```

In this model:
- **No relay** is needed
- **No key transfer** occurs (the CLI generates the session key locally)
- **No encrypted handoff** (the session private key never leaves the CLI)
- **No code** (session approval is the only user interaction)
- **The API sees only the session public key** (cannot derive the private key)

This eliminates the entire relay trust model and the associated MITM risk.
The relay-based protocol (this document) is designed as a transitional
solution that will be replaced by the API-based flow. The CLI's external
interface (SKILL.md, command syntax) remains identical across both
implementations.

---

## 9. Key Material Lifecycle

| Material | Created | Used | Destroyed |
|----------|---------|------|-----------|
| `cli_sk` (X25519 private) | CLI process start | ECDH computation (Phase 4) | Zeroed after ECDH; CLI process memory only |
| `cli_pk` (X25519 public) | CLI process start | Sent to relay (Phase 1) | Not secret; discarded with process |
| `wallet_sk` (X25519 private) | Browser, Phase 3 | ECDH computation (Phase 3) | Zeroed after ECDH; browser JS heap only |
| `wallet_pk` (X25519 public) | Browser, Phase 3 | Sent to relay (Phase 3) | Not secret; discarded with page |
| `shared` (ECDH output) | Both sides independently | HKDF input | Zeroed immediately after HKDF |
| `code_str` (6-digit code) | Browser, Phase 3 | HKDF salt (browser); HKDF salt (CLI) | Browser: displayed then discarded. CLI: discarded after HKDF. Never stored or logged. |
| `enc_key` (symmetric) | Both sides independently | XChaCha20-Poly1305 encrypt/decrypt | Zeroed immediately after use |
| `session_private_key` | Wallet SDK, Phase 2 | Stored in OS keychain (Phase 4) | Deleted on session disconnect or expiry |

**JavaScript memory zeroing caveat:** JavaScript does not guarantee memory
zeroing. `TypedArray.fill(0)` overwrites the buffer contents but the
garbage collector may retain copies. For the ephemeral keys (`cli_sk`,
`wallet_sk`, `shared`, `enc_key`), this is acceptable because:
1. The keys are short-lived (seconds)
2. Process memory is not accessible to other processes under standard OS
   isolation
3. The threat model does not include memory forensics on the local machine
   (Section 5.6 addresses physical access separately)

For the `session_private_key`, which is long-lived, storage in the OS
keychain provides hardware-backed or OS-level encryption at rest.

---

## 10. Summary of Security Guarantees

| Property | Guarantee | Mechanism |
|----------|-----------|-----------|
| Confidentiality of session material in transit | Strong | X25519 ECDH + XChaCha20-Poly1305 AEAD |
| Confidentiality against compromised relay | Strong | Relay never possesses ECDH private keys |
| MITM resistance (honest relay) | Strong | 6-digit code mixed into KDF; code travels out-of-band |
| MITM resistance (compromised relay) | Moderate (see 5.3) | Offline brute-force of 6-digit code is feasible in ~1s without Argon2id; ~hours with Argon2id |
| Integrity of session material | Strong | Poly1305 authentication tag + AAD channel binding |
| Replay resistance | Strong | Single-use request IDs, ephemeral keys, TTL auto-deletion |
| Brute-force resistance at relay | Strong | 3 attempts / 10^6 possibilities = 0.0003% success probability |
| Forward secrecy | Strong | Ephemeral X25519 keys; compromise of future keys does not expose past sessions |
| Session scope enforcement | Strong (on-chain) | Smart session contracts enforce limits independent of client |

### 10.1 Residual Risks (Accepted)

1. **Compromised relay MITM with offline brute-force (without Argon2id):**
   An attacker who controls the relay infrastructure can substitute ECDH
   public keys and brute-force the 6-digit code in ~1 second. Mitigation:
   Argon2id hardening or migration to Smart Sessions API.

2. **Compromised local machine:** An attacker with OS-level access can
   extract session material from the keychain. Mitigation: short session
   expiry, on-chain permission bounds, user revocation.

3. **JavaScript memory safety:** Ephemeral key material may persist in
   garbage-collected memory beyond explicit zeroing. Mitigation: short
   key lifetime, standard OS process isolation.

---

## Appendix A: Wire Format Reference

### Relay API Payloads

**POST /api/relay/request**
```json
{ "cli_pk": "<64 hex chars, 32 bytes X25519 public key>" }
```

**POST /api/relay/session/{rid}**
```json
{
  "wallet_pk":   "<64 hex chars, 32 bytes X25519 public key>",
  "nonce":       "<48 hex chars, 24 bytes XChaCha20 nonce>",
  "ciphertext":  "<base64url, XChaCha20-Poly1305 output including 16-byte tag>",
  "code_hash":   "<64 hex chars, 32 bytes SHA-256 output>"
}
```

**POST /api/relay/retrieve/{rid}**
```json
{ "code_hash": "<64 hex chars, 32 bytes SHA-256 output>" }
```

### Session Payload (Plaintext, Pre-Encryption)

```json
{
  "version": 1,
  "wallet_address": "0x...",
  "chain_id": 137,
  "session_private_key": "0x<64 hex chars, 32 bytes secp256k1 private key>",
  "session_address": "0x...",
  "permissions": {
    "native_limit": "<wei string>",
    "erc20_limits": [{ "token_address": "0x...", "limit": "<smallest unit string>" }],
    "contract_calls": [{ "address": "0x...", "functions": ["0x<4-byte selector>"] }]
  },
  "expiry": 1711234567,
  "ecosystem_wallet_url": "https://...",
  "project_access_key": "..."
}
```

Maximum plaintext size: ~2KB. Maximum ciphertext size (with Poly1305 tag and
base64url overhead): ~3KB.
