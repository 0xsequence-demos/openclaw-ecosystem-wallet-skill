import { customAlphabet } from 'nanoid'
import { isValidHex, isValidBase64url } from './validation.js'
import type { Env } from '../env.js'

const generateRequestId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)

function getRelayDO(env: Env, requestId: string) {
  const id = env.SESSION_RELAY.idFromName(requestId)
  return env.SESSION_RELAY.get(id)
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleRelayRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const path = url.pathname.replace('/api/relay/', '')
  const method = request.method

  // POST /api/relay/request
  if (method === 'POST' && path === 'request') {
    const body = (await request.json()) as { cli_pk: string }
    if (!body.cli_pk || !isValidHex(body.cli_pk, 32)) {
      return json({ error: 'cli_pk must be 64 hex characters (32 bytes)' }, 400)
    }

    const request_id = generateRequestId()
    const stub = getRelayDO(env, request_id)
    await stub.init(body.cli_pk)

    return json({ request_id }, 201)
  }

  // GET /api/relay/request/:rid
  const getRequestMatch = path.match(/^request\/([a-zA-Z0-9_-]+)$/)
  if (method === 'GET' && getRequestMatch) {
    const rid = getRequestMatch[1]
    const stub = getRelayDO(env, rid)
    const result = await stub.getPublicKey()
    if (!result) return json({ error: 'not_found' }, 404)
    return json(result)
  }

  // POST /api/relay/session/:rid
  const postSessionMatch = path.match(/^session\/([a-zA-Z0-9_-]+)$/)
  if (method === 'POST' && postSessionMatch) {
    const rid = postSessionMatch[1]
    const body = (await request.json()) as {
      wallet_pk: string
      nonce: string
      ciphertext: string
      code_hash: string
    }

    if (!isValidHex(body.wallet_pk, 32)) {
      return json({ error: 'wallet_pk must be 64 hex characters' }, 400)
    }
    if (!isValidHex(body.nonce, 24)) {
      return json({ error: 'nonce must be 48 hex characters' }, 400)
    }
    if (!body.ciphertext || !isValidBase64url(body.ciphertext, 8192)) {
      return json({ error: 'ciphertext must be valid base64url, max 8KB' }, 400)
    }
    if (!isValidHex(body.code_hash, 32)) {
      return json({ error: 'code_hash must be 64 hex characters' }, 400)
    }

    const stub = getRelayDO(env, rid)
    const result = await stub.postSession(
      body.wallet_pk,
      body.nonce,
      body.ciphertext,
      body.code_hash,
    )

    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409
      return json({ error: result.error }, status)
    }
    return json({ ok: true })
  }

  // GET /api/relay/status/:rid
  const statusMatch = path.match(/^status\/([a-zA-Z0-9_-]+)$/)
  if (method === 'GET' && statusMatch) {
    const rid = statusMatch[1]
    const stub = getRelayDO(env, rid)
    const result = await stub.getStatus()
    if (!result) return json({ error: 'not_found' }, 404)
    return json(result)
  }

  // POST /api/relay/retrieve/:rid
  const retrieveMatch = path.match(/^retrieve\/([a-zA-Z0-9_-]+)$/)
  if (method === 'POST' && retrieveMatch) {
    const rid = retrieveMatch[1]
    const body = (await request.json()) as { code_hash: string }

    if (!isValidHex(body.code_hash, 32)) {
      return json({ error: 'code_hash must be 64 hex characters' }, 400)
    }

    const stub = getRelayDO(env, rid)
    const result = await stub.retrieve(body.code_hash)

    if ('error' in result) {
      const status = result.error === 'request_expired' ? 410 : result.error === 'not_found' ? 404 : 403
      return json(result, status)
    }
    return json(result)
  }

  return json({ error: 'not_found' }, 404)
}
