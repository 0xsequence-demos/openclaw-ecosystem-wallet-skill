export { hexToBytes } from '@polygon-agent/shared'

export function isValidHex(str: string, byteLength: number): boolean {
  return new RegExp(`^[0-9a-f]{${byteLength * 2}}$`).test(str)
}

export function isValidBase64url(str: string, maxBytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return false
  const approxBytes = Math.ceil((str.length * 3) / 4)
  return approxBytes <= maxBytes
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]
  return result === 0
}
