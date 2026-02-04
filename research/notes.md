# Ecosystem Wallet + OpenClaw (initial notes)

## Decisions
- Start with **Polygon only**
- Session transfer: **copy/paste encrypted blob** (same sealed-box pattern as WaaS)

## Sources
- demo dapp: `0xsequence/demo-dapp-v3` (private)
- SDK: `@0xsequence/dapp-client@3.0.0-beta.5`
- sequence.js v3 (beta): https://github.com/0xsequence/sequence.js (packages tagged `3.0.0-beta.*`)

## Key finding: Explicit Session material is exportable
In `@0xsequence/dapp-client`, explicit session data is stored by `WebStorage` in IndexedDB:
- DB: **`SequenceDappStorage`**
- store: **`userKeys`**
- key: **`SequenceExplicitSession`**

`ExplicitSessionData` shape includes:
- `pk: Hex` (session private key)
- `walletAddress`
- `chainId`
- optional: `loginMethod`, `userEmail`, `guard`

So we can export **pk + walletAddress + chainId** to headless.

## ExplicitSessionConfig model
`demo-dapp-v3` builds explicit sessions with:
- `chainId`
- `valueLimit`
- `deadline` (unix seconds)
- `permissions` (PermissionBuilder rules)

This maps well to a "smart session" with spend limits + contract/function restrictions.

## Open question
How to use the exported explicit session `pk` with **sequence.js v3** headlessly to send transactions (native + ERC20) via relayer.

Next step: identify the minimal sequence.js v3 wallet + signer construction that accepts an explicit session signer.
