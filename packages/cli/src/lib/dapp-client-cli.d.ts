declare module '@0xsequence/dapp-client-cli/state' {
  export class StateManager {
    constructor(statePath: string, passphrase: string)
    update(fn: (state: any) => void): Promise<void>
  }
}

declare module '@0xsequence/dapp-client-cli/storage' {
  export class FileSequenceStorage {
    constructor(stateManager: any, opts?: { suppressPendingRedirect?: boolean })
    saveExplicitSession(session: any): Promise<void>
    saveImplicitSession(session: any): Promise<void>
    setPendingRedirectRequest(val: boolean): Promise<void>
    savePendingRequest(val: any): Promise<void>
    saveTempSessionPk(val: any): Promise<void>
  }
  export class FileSessionStorage {
    constructor(stateManager: any)
    removeItem(key: string): Promise<void>
  }
}
