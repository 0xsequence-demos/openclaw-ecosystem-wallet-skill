import { SessionRelay } from './relay/session-relay.js'
import { handleRelayRequest } from './relay/handler.js'
import type { Env } from './env.js'

export { SessionRelay }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    if (url.pathname.startsWith('/api/relay/')) {
      const response = await handleRelayRequest(request, env, url)
      response.headers.set('Access-Control-Allow-Origin', '*')
      return response
    }

    return env.ASSETS.fetch(request)
  },
}
