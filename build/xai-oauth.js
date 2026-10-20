/**
 * Grok's sign-in, as DSH's own xAI route performs it: an OAuth device code
 * against auth.x.ai with the pi-ai client, a refresh by refresh token, and the
 * grant written back as the credential record `llm-pi-ai/xai` — the record
 * `dsh-llm-pi-ai` reads. Nothing here imports a DSH package, and the fetch is
 * passed in, so the whole flow runs in a test against a stand-in server.
 */

/** The client and endpoints DSH's built-in sign-in uses (pi-ai's xai OAuth). */
export const XAI_OAUTH = Object.freeze({
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  scope: 'openid profile email offline_access grok-cli:access api:access',
  deviceCodeUrl: 'https://auth.x.ai/oauth2/device/code',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  /** A token this close to its end is renewed before it is used. */
  skewMs: 5 * 60 * 1000,
  pollMs: 5000,
})

const DEFAULT_TIMEOUT_MS = 15000

function need(body, field) {
  const value = body?.[field]
  if (typeof value !== 'string' || value === '') throw new Error(`the xAI sign-in reply is missing ${field}`)
  return value
}

async function postForm(url, fields, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: composed,
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(`auth.x.ai did not answer in ${timeoutMs} ms`)
    throw new Error(`cannot reach auth.x.ai: ${String(error?.cause?.code ?? error?.message ?? error)}`)
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`auth.x.ai answered ${response.status} with something that is not JSON`)
  }
  return { ok: response.ok, status: response.status, body: body && typeof body === 'object' ? body : {} }
}

/**
 * A grant as `dsh-llm-pi-ai` stores it: `expires` is an epoch millisecond time,
 * set back by the same margin pi-ai uses so a token is never used at its edge.
 */
export function grantFromToken(body, previousRefresh, now = Date.now()) {
  const access = need(body, 'access_token')
  const refresh = typeof body.refresh_token === 'string' && body.refresh_token !== ''
    ? body.refresh_token
    : previousRefresh
  if (typeof refresh !== 'string' || refresh === '') throw new Error('the xAI sign-in reply is missing refresh_token')
  const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
  return { type: 'oauth', access, refresh, expires: now + lifetime * 1000 - XAI_OAUTH.skewMs }
}

/** Ask auth.x.ai for a device code the human approves in their browser. */
export async function startDeviceFlow(io = {}) {
  const started = await postForm(
    XAI_OAUTH.deviceCodeUrl,
    { client_id: XAI_OAUTH.clientId, scope: XAI_OAUTH.scope, referrer: 'pi' },
    io,
  )
  if (!started.ok) {
    const detail = [started.body.error, started.body.error_description].filter(Boolean).join(': ')
    throw new Error(`the xAI sign-in was refused (HTTP ${started.status})${detail ? `: ${detail}` : ''}`)
  }
  const uri = typeof started.body.verification_uri_complete === 'string' && started.body.verification_uri_complete !== ''
    ? started.body.verification_uri_complete
    : need(started.body, 'verification_uri')
  return {
    deviceCode: need(started.body, 'device_code'),
    userCode: need(started.body, 'user_code'),
    verificationUri: typeof started.body.verification_uri === 'string' ? started.body.verification_uri : uri,
    verificationUriComplete: uri,
    interval: typeof started.body.interval === 'number' && started.body.interval > 0 ? started.body.interval : XAI_OAUTH.pollMs / 1000,
    expiresIn: typeof started.body.expires_in === 'number' && started.body.expires_in > 0 ? started.body.expires_in : 1800,
  }
}

/**
 * One poll of the device code. `status` is `pending` while the human has not
 * approved yet, `done` once a grant came back, and `failed` for a refusal, an
 * expiry, or a vendor error worth telling the human about.
 */
export async function pollDeviceFlow(device, io = {}) {
  const polled = await postForm(
    XAI_OAUTH.tokenUrl,
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: XAI_OAUTH.clientId,
      device_code: device.deviceCode,
    },
    io,
  )
  if (polled.ok) {
    try {
      return { status: 'done', grant: grantFromToken(polled.body, undefined, io.now?.() ?? Date.now()) }
    } catch (error) {
      return { status: 'failed', error: String(error.message ?? error) }
    }
  }
  const error = String(polled.body.error ?? '')
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') {
    const next = polled.body.interval
    return { status: 'pending', interval: typeof next === 'number' && next > 0 ? next : device.interval + 5 }
  }
  if (error === 'access_denied' || error === 'authorization_denied') return { status: 'failed', error: 'the sign-in was declined in the browser' }
  if (error === 'expired_token') return { status: 'failed', error: 'the device code expired; start the sign-in again' }
  const detail = [error, polled.body.error_description].filter(Boolean).join(': ')
  return { status: 'failed', error: `the xAI token request failed (HTTP ${polled.status})${detail ? `: ${detail}` : ''}` }
}

/** Renew a grant by its refresh token; `undefined` when xAI refused. */
export async function refreshGrant(grant, io = {}) {
  if (typeof grant?.refresh !== 'string' || grant.refresh === '') return undefined
  const polled = await postForm(
    XAI_OAUTH.tokenUrl,
    { grant_type: 'refresh_token', client_id: XAI_OAUTH.clientId, refresh_token: grant.refresh },
    io,
  )
  if (!polled.ok) return undefined
  try {
    return grantFromToken(polled.body, grant.refresh, io.now?.() ?? Date.now())
  } catch {
    return undefined
  }
}

/** A grant that is still good, renewed first when it is close to its end. */
export async function usableGrant(grant, io = {}) {
  if (typeof grant?.access !== 'string' || grant.access === '') return undefined
  const now = io.now?.() ?? Date.now()
  if (typeof grant.expires === 'number' && grant.expires - now > XAI_OAUTH.skewMs) return { grant, renewed: false }
  const renewed = await refreshGrant(grant, io)
  if (renewed) return { grant: renewed, renewed: true }
  if (typeof grant.expires === 'number' && grant.expires > now) return { grant, renewed: false }
  return undefined
}

/** The account a token names: its email, else its subject. Read, never verified. */
export function accountOf(access) {
  try {
    const part = String(access).split('.')[1]
    if (!part) return undefined
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (typeof claims?.email === 'string' && claims.email !== '') return claims.email
    if (typeof claims?.sub === 'string' && claims.sub !== '') return claims.sub
  } catch {
    return undefined
  }
  return undefined
}
