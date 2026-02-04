# React Native SDK (Sequence) notes

Source: https://github.com/0xsequence/react-native-sdk/blob/master/src/setup.ts

Key takeaway: the RN SDK wires `DappClient` with injectable storage + keygen.

It passes options:
- `transportMode: TransportMode.REDIRECT`
- `sequenceStorage: storage` (custom implementation)
- `sequenceSessionStorage: sequenceSessionStorage` (MMKV-backed KV)
- `randomPrivateKeyFn: reactNativeRandomPrivateKey` (generates a new session pk)
- `redirectActionHandler: (url) => WebBrowser.openBrowserAsync(url)`
- `canUseIndexedDb: false`

Implication for a Node CLI:
- we can likely re-use DappClient headlessly by providing:
  - `sequenceStorage` (file/Keychain-backed)
  - `sequenceSessionStorage` (file/Keychain-backed)
  - `randomPrivateKeyFn`
  - `redirectActionHandler` (open a browser / print URL)
  - `canUseIndexedDb: false`

Open question: DappClient uses browser constructs (`window`, `fetch`) in places; we may need shims or run in a minimal browser context.
