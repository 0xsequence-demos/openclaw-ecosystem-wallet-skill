/// <reference types="vite/client" />

export const walletUrl = (import.meta.env.VITE_WALLET_URL ?? 'https://wallet.polygon.technology').replace(/\/+$/, '')
export const dappOrigin = import.meta.env.VITE_DAPP_ORIGIN || window.location.origin
export const projectAccessKey = import.meta.env.VITE_PROJECT_ACCESS_KEY ?? ''
export const relayerUrl: string | undefined = import.meta.env.VITE_RELAYER_URL || undefined
export const nodesUrl: string = import.meta.env.VITE_NODES_URL ?? 'https://nodes.sequence.app'
export const indexerAccessKey: string = import.meta.env.VITE_INDEXER_ACCESS_KEY ?? ''
