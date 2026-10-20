/**
 * `@local/dsh-quota` — the remaining allowance of the providers DSH talks to,
 * on screen, with the two ways a credential gets there: an API key stored
 * through this page, and Grok's own sign-in.
 *
 * The Host half does four things: resolve a provider's credential out of the
 * credential seam, ask the vendor's quota endpoint, hand one snapshot to the
 * Client, and run Grok's device-code sign-in. It stores no secret of its own:
 * keys go to `ctx.credentials` (the same store the Models page writes), and a
 * sign-in writes the `llm-pi-ai/xai` record that `dsh-llm-pi-ai` itself reads,
 * so approving here makes Grok usable in DSH, not only readable here.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PRESETS, readQuota, worstOf } from './providers.js'
import { createUsageStore, usageFile } from './usage.js'
import { XAI_OAUTH, accountOf, pollDeviceFlow, startDeviceFlow, usableGrant } from './xai-oauth.js'

export const name = 'dsh-quota'

/** `webServer` carries the page's requests; `credentials` is read opportunistically. */
export const inject = ['webServer']

const ROUTES = Object.freeze({
  state: '/quota/state',
  refresh: '/quota/refresh',
  key: '/quota/key',
  clear: '/quota/clear',
  providers: '/quota/providers',
  providersRemove: '/quota/providers/remove',
  loginStart: '/quota/login/start',
  loginStatus: '/quota/login/status',
  loginCancel: '/quota/login/cancel',
})

/** The Loader row this bundle inserts — the row a provider is added to. */
const CONFIG_ID = 'dsh-quota'

/** The record Grok's sign-in writes — `dsh-llm-pi-ai`'s own key for xAI. */
const XAI_RECORD = 'llm-pi-ai/xai'

/**
 * What the plugin watches with no configuration: the three providers whose
 * quota DSH does not show. Each is a route the user may already have; a route
 * this profile has not mounted still gets a card, saying what is missing.
 */
const DEFAULT_TARGETS = Object.freeze([
  { id: 'opencode-go', preset: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY' },
  { id: 'grok', preset: 'xai-billing', record: XAI_RECORD },
  { id: 'commandcode', preset: 'commandcode', apiKeyEnv: 'COMMANDCODE_API_KEY' },
  { id: 'deepseek', preset: 'deepseek-api', apiKeyEnv: 'DEEPSEEK_API_KEY' },
])

const DEFAULT_REFRESH_MS = 60_000
const MAX_BODY_BYTES = 16 * 1024

// ---- configuration -------------------------------------------------------------

/** Read a config field from either a plain object or a reactive one. */
function pick(config, key, fallback) {
  const value = config?.[key]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get() ?? fallback
    } catch {
      return fallback
    }
  }
  return value ?? fallback
}

function numberPick(config, key, fallback, min, max) {
  const value = Number(pick(config, key, fallback))
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** `<scope>/<id>` split into the two segments a record key is made of. */
function splitRecord(value) {
  if (typeof value !== 'string') return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { scope: value.slice(0, slash), id: value.slice(slash + 1) }
}

function normalize(config) {
  const enabled = pick(config, 'enabled', true) !== false
  const refreshMs = numberPick(config, 'refreshMs', DEFAULT_REFRESH_MS, 10_000, 3_600_000)
  const timeoutMs = numberPick(config, 'timeoutMs', 8000, 1000, 60_000)
  const configured = pick(config, 'providers', [])
  const list = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_TARGETS
  const providers = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const preset = PRESETS[entry.preset]
    if (!preset) continue
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : entry.preset
    providers.push({
      id,
      preset: entry.preset,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : preset.label,
      baseURL: typeof entry.baseURL === 'string' && entry.baseURL !== '' ? entry.baseURL : preset.baseURL,
      apiKeyEnv: typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv !== '' ? entry.apiKeyEnv : preset.apiKeyEnv,
      record: typeof entry.record === 'string' && entry.record !== '' ? entry.record : preset.record,
    })
  }
  return { enabled, refreshMs, timeoutMs, providers }
}

// ---- diagnostics ---------------------------------------------------------------

/** A log line that can never take the plugin down with it. */
function log(ctx, level, message, ...args) {
  try {
    const logger = ctx?.logger
    const write = logger?.[level]
    if (typeof write === 'function') write.call(logger, message, ...args)
  } catch {}
}

// ---- credentials ---------------------------------------------------------------

async function readCliAuth(relative) {
  try {
    const parsed = JSON.parse(await readFile(join(homedir(), relative), 'utf8'))
    const key = typeof parsed?.apiKey === 'string' ? parsed.apiKey : ''
    if (key === '') return undefined
    const account = typeof parsed?.userName === 'string' && parsed.userName !== ''
      ? parsed.userName
      : typeof parsed?.userId === 'string' && parsed.userId !== '' ? parsed.userId : undefined
    return { key, account }
  } catch {
    return undefined
  }
}

async function saveXaiGrant(credentials, grant) {
  await credentials.modifyRecord(XAI_RECORD, async () => ({
    kind: 'grant',
    payload: { type: 'oauth', access: grant.access, refresh: grant.refresh, expires: grant.expires },
  }))
}

/** What an API-key target resolves to, and where the value came from. */
async function keyCredential(credentials, preset, target, timeoutMs) {
  const hint = target.apiKeyEnv ?? preset.apiKeyEnv
  const credential = { auth: 'key', configured: false, hint }
  if (credentials && hint) {
    try {
      const info = await credentials.describe(hint)
      if (info?.configured) {
        const hit = await credentials.resolve(hint)
        if (typeof hit?.value === 'string' && hit.value !== '') {
          credential.configured = true
          credential.source = hit.source
          credential.token = hit.value
        }
      }
      credential.writable = info?.writable !== false
    } catch (error) {
      credential.error = `the credential store refused to read ${hint}: ${String(error?.message ?? error)}`
    }
  }
  if (!credential.token && preset.cliAuth) {
    const local = await readCliAuth(preset.cliAuth)
    if (local) {
      credential.configured = true
      credential.source = 'cli'
      credential.account = local.account
      credential.token = local.key
      credential.hint = preset.cliAuth
      credential.writable = false
    }
  }
  return credential
}

/** What an OAuth target resolves to, renewing a grant that is close to expiring. */
async function oauthCredential(credentials, target, timeoutMs) {
  const credential = { auth: 'oauth', configured: false, hint: target.record ?? XAI_RECORD }
  if (!credentials) {
    credential.error = 'this composition mounts no credential store'
    return credential
  }
  let record
  try {
    record = await credentials.readRecord(target.record ?? XAI_RECORD)
  } catch (error) {
    credential.error = `the credential store refused to read the sign-in: ${String(error?.message ?? error)}`
    return credential
  }
  const grant = record?.payload
  if (!grant || typeof grant.access !== 'string' || grant.access === '') return credential
  credential.configured = true
  credential.source = 'record'
  const usable = await usableGrant(grant, { timeoutMs })
  if (!usable) {
    credential.configured = false
    credential.error = 'the Grok sign-in has expired; sign in again'
    return credential
  }
  credential.token = usable.grant.access
  credential.account = accountOf(usable.grant.access)
  credential.expiresAt = typeof usable.grant.expires === 'number' ? new Date(usable.grant.expires).toISOString() : undefined
  if (usable.renewed) {
    try {
      await saveXaiGrant(credentials, usable.grant)
    } catch (error) {
      log(undefined, 'warn', '[quota] the renewed Grok sign-in was not stored: %s', String(error?.message ?? error))
    }
  }
  return credential
}

// ---- the sign-in ---------------------------------------------------------------

/**
 * Grok's device-code sign-in, one attempt per target. The browser approves on
 * x.ai's page; this side polls, and writes the grant as the credential record
 * the xAI route reads, so the approval is the same one DSH itself would make.
 */
function createSignIn(ctx, settings) {
  const attempts = new Map()

  const publicOf = (id) => {
    const attempt = attempts.get(id)
    if (!attempt) return undefined
    return {
      status: attempt.status,
      userCode: attempt.userCode,
      verificationUri: attempt.verificationUri,
      verificationUriComplete: attempt.verificationUriComplete,
      expiresAt: attempt.expiresAt,
      error: attempt.error,
      account: attempt.account,
    }
  }

  const settle = (id, patch) => {
    const attempt = attempts.get(id)
    if (!attempt) return
    attempts.set(id, { ...attempt, ...patch })
  }

  function cancel(id) {
    const attempt = attempts.get(id)
    if (!attempt) return false
    attempt.controller?.abort()
    if (attempt.status === 'pending') attempts.set(id, { ...attempt, status: 'cancelled' })
    return true
  }

  async function start(target) {
    const credentials = ctx.get('credentials')
    if (!credentials) throw new Error('this composition mounts no credential store, so a sign-in has nowhere to be kept')
    const previous = attempts.get(target.id)
    if (previous?.status === 'pending') return publicOf(target.id)

    const controller = new AbortController()
    const device = await startDeviceFlow({ signal: controller.signal, timeoutMs: settings.timeoutMs })
    attempts.set(target.id, {
      status: 'pending',
      controller,
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt: new Date(Date.now() + device.expiresIn * 1000).toISOString(),
    })
    void run(target, device, controller).catch((error) => {
      log(ctx, 'warn', '[quota] the Grok sign-in failed: %s', String(error?.message ?? error))
      settle(target.id, { status: 'failed', error: String(error?.message ?? error) })
    })
    return publicOf(target.id)
  }

  const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })

  async function run(target, device, controller) {
    const credentials = ctx.get('credentials')
    let interval = device.interval
    const deadline = Date.now() + device.expiresIn * 1000
    while (!controller.signal.aborted && Date.now() < deadline) {
      await sleep(Math.max(1000, interval * 1000), controller.signal)
      if (controller.signal.aborted) return
      const polled = await pollDeviceFlow(device, { signal: controller.signal, timeoutMs: settings.timeoutMs })
      if (polled.status === 'pending') {
        if (typeof polled.interval === 'number' && polled.interval > 0) interval = polled.interval
        continue
      }
      if (polled.status === 'done') {
        await saveXaiGrant(credentials, polled.grant)
        settle(target.id, { status: 'success', account: accountOf(polled.grant.access), error: undefined })
        return
      }
      settle(target.id, { status: 'failed', error: polled.error })
      return
    }
    if (!controller.signal.aborted) settle(target.id, { status: 'failed', error: 'the sign-in timed out; start it again' })
  }

  const dispose = () => {
    for (const attempt of attempts.values()) attempt.controller?.abort()
    attempts.clear()
  }

  return { start, cancel, publicOf, dispose }
}

// ---- one snapshot ---------------------------------------------------------------

/**
 * Ask every target at once and keep each failure on its own card: a quota page
 * whose Grok card is missing because OpenCode failed would be worse than
 * useless. A card that cannot be read says why, in the vendor's own words
 * where there are any.
 */
function createService(ctx, settings, signIn, usage) {
  const planCache = new Map()
  let snapshot
  let cachedAt = 0
  let inflight

  const fresh = (now) => snapshot !== undefined && now - cachedAt < settings.refreshMs

  async function card(target) {
    const preset = PRESETS[target.preset]
    const card = { id: target.id, label: target.label, preset: target.preset, auth: preset.auth }
    if (preset.auth === 'key' && preset.keysUrl) card.keysUrl = preset.keysUrl
    const login = signIn.publicOf(target.id)
    if (login) card.login = login

    const credentials = ctx.get('credentials')
    let credential
    try {
      credential = preset.auth === 'oauth'
        ? await oauthCredential(credentials, target, settings.timeoutMs)
        : await keyCredential(credentials, preset, target, settings.timeoutMs)
    } catch (error) {
      return { ...card, credential: { auth: preset.auth, configured: false }, error: `the credential could not be read: ${String(error?.message ?? error)}` }
    }

    card.credential = {
      auth: credential.auth,
      configured: credential.configured,
      source: credential.source,
      hint: credential.hint,
      account: credential.account,
      expiresAt: credential.expiresAt,
      writable: credential.writable,
    }
    if (credential.error) card.credential.error = credential.error
    if (!credential.token) {
      return {
        ...card,
        missing: true,
        error: credential.error ?? `no credential for ${credential.hint ?? preset.label}`,
      }
    }

    try {
      const reading = await readQuota(
        { id: target.id, preset: target.preset, baseURL: target.baseURL, token: credential.token },
        { timeoutMs: settings.timeoutMs, planCache },
      )
      // The tightest window first: the number that decides whether the next
      // request works is the one worth reading first.
      const windows = (Array.isArray(reading.windows) ? reading.windows : [])
        .slice()
        .sort((a, b) => (b?.used ?? 0) - (a?.used ?? 0))
      return {
        ...card,
        url: reading.url,
        windows,
        worst: worstOf(windows) ?? null,
        plan: reading.plan,
        until: reading.until,
        renew: reading.renew,
        balance: reading.balance,
        note: reading.note,
        parts: reading.parts,
      }
    } catch (error) {
      return { ...card, error: String(error?.message ?? error) }
    }
  }

  async function collect() {
    const cards = await Promise.all(settings.providers.map((target) => card(target)))
    return {
      enabled: true,
      fetchedAt: new Date().toISOString(),
      refreshMs: settings.refreshMs,
      providers: cards,
    }
  }

  async function refresh() {
    if (inflight) return inflight
    inflight = collect()
      .then((next) => {
        snapshot = next
        cachedAt = Date.now()
        return next
      })
      .catch((error) => {
        log(ctx, 'warn', '[quota] the refresh failed: %s', String(error?.message ?? error))
        return snapshot ?? { enabled: true, fetchedAt: new Date().toISOString(), refreshMs: settings.refreshMs, providers: [], error: 'the quota refresh failed' }
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  return {
    async state({ force = false } = {}) {
      const measured = {
        usage: await usage.summary(),
        usageFile: usageFile(),
        presets: Object.entries(PRESETS).map(([id, preset]) => ({ id, label: preset.label, auth: preset.auth })),
      }
      if (!settings.enabled) return { enabled: false, fetchedAt: null, refreshMs: settings.refreshMs, providers: [], ...measured }
      if (force || !fresh(Date.now())) await refresh()
      return { ...snapshot, ...measured }
    },
    targets: () => settings.providers,
  }
}

// ---- HTTP ----------------------------------------------------------------------

function sendJson(res, status, body) {
  if (res.headersSent) {
    try {
      res.end()
    } catch {}
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function jsonError(res, status, error) {
  sendJson(res, status, { error })
}

/** A refused cross-site request, saying what it sent so the page can report it. */
function forbidden(res, req) {
  sendJson(res, 403, { error: 'forbidden-origin', ...originDetail(req) })
}

/** The page's own request only: a write has to say where it came from. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLocalOrigin(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * A request from the page, and not from some other site's page.
 *
 * The desktop renderer sends neither `Origin` nor `Sec-Fetch-Site` on its own
 * fetches, so a missing origin is what a local client looks like; only a
 * browser names an origin, and it always does so on a cross-site POST — the
 * case this check exists to refuse. A named origin counts when it is loopback
 * (the page may be opened as localhost or 127.0.0.1 on any port), when the
 * browser marks the request same-origin, or when it matches the Host header.
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (isLocalOrigin(origin)) return true
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'none') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** What a refused request said, so a rejection is diagnosable from the page. */
function originDetail(req) {
  return {
    origin: req.headers.origin ?? '(none)',
    host: req.headers.host ?? '(none)',
    site: req.headers['sec-fetch-site'] ?? '(none)',
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('the request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('the request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

function targetOf(service, id) {
  if (typeof id !== 'string' || id === '') return undefined
  return service.targets().find((entry) => entry.id === id)
}

function registerRoutes(ctx, service, settings, signIn) {
  const route = (path, handler) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        void (async () => {
          try {
            await handler(req, res)
          } catch (error) {
            log(ctx, 'debug', '[quota] %s failed: %s', path, String(error?.message ?? error))
            jsonError(res, 500, String(error?.message ?? error))
          }
        })()
      },
    }))
  }

  route(ROUTES.state, async (req, res) => {
    if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    sendJson(res, 200, await service.state())
  })

  route(ROUTES.refresh, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    sendJson(res, 200, await service.state({ force: true }))
  })

  route(ROUTES.key, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    const preset = PRESETS[target.preset]
    if (preset.auth !== 'key') return jsonError(res, 400, 'this provider signs in instead of taking a key')
    const hint = target.apiKeyEnv ?? preset.apiKeyEnv
    if (!hint) return jsonError(res, 400, 'this provider names no credential reference')
    const credentials = ctx.get('credentials')
    if (!credentials) return jsonError(res, 503, 'this composition mounts no credential store')
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (key === '') return jsonError(res, 400, 'the key is empty')
    try {
      await credentials.set(hint, key)
    } catch (error) {
      return jsonError(res, 500, `the key was not stored: ${String(error?.message ?? error)}`)
    }
    sendJson(res, 200, { ok: true, hint })
  })

  route(ROUTES.clear, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    const preset = PRESETS[target.preset]
    const credentials = ctx.get('credentials')
    if (!credentials) return jsonError(res, 503, 'this composition mounts no credential store')
    try {
      if (preset.auth === 'oauth') {
        signIn.cancel(target.id)
        await credentials.deleteRecord(target.record ?? XAI_RECORD)
      } else {
        const hint = target.apiKeyEnv ?? preset.apiKeyEnv
        if (!hint) return jsonError(res, 400, 'this provider names no credential reference')
        await credentials.unset(hint)
      }
    } catch (error) {
      return jsonError(res, 500, `the credential was not removed: ${String(error?.message ?? error)}`)
    }
    sendJson(res, 200, { ok: true })
  })

  route(ROUTES.providers, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    if (!PRESETS[body.preset]) return jsonError(res, 400, `unknown preset "${String(body.preset)}"`)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!ID_PATTERN.test(id)) return jsonError(res, 400, 'the id must start with a letter or digit and hold only letters, digits and dashes')
    if (service.targets().some((entry) => entry.id === id)) return jsonError(res, 409, `"${id}" is already a provider`)
    const row = { id, preset: body.preset }
    for (const key of ['label', 'baseURL', 'apiKeyEnv', 'record']) {
      const value = typeof body[key] === 'string' ? body[key].trim() : ''
      if (value !== '') row[key] = value
    }
    try {
      const providers = await editProviders(ctx, (rows) => [...rows, row])
      sendJson(res, 200, { ok: true, providers })
    } catch (error) {
      jsonError(res, 500, String(error?.message ?? error))
    }
  })

  route(ROUTES.providersRemove, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const targets = service.targets()
    if (!targets.some((entry) => entry.id === id)) return jsonError(res, 404, 'unknown-provider')
    if (targets.length <= 1) return jsonError(res, 400, 'at least one provider has to stay')
    try {
      const providers = await editProviders(ctx, (rows) => rows.filter((row) => row.id !== id))
      sendJson(res, 200, { ok: true, providers })
    } catch (error) {
      jsonError(res, 500, String(error?.message ?? error))
    }
  })

  route(ROUTES.loginStart, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    if (PRESETS[target.preset].login !== 'xai-device-code') return jsonError(res, 400, 'this provider has no sign-in')
    try {
      sendJson(res, 200, await signIn.start(target))
    } catch (error) {
      jsonError(res, 502, String(error?.message ?? error))
    }
  })

  route(ROUTES.loginStatus, async (req, res) => {
    if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const id = url.searchParams.get('id') ?? ''
    sendJson(res, 200, signIn.publicOf(id) ?? { status: 'idle' })
  })

  route(ROUTES.loginCancel, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    sendJson(res, 200, { ok: signIn.cancel(typeof body.id === 'string' ? body.id : '') })
  })
}

// ---- providers, edited through the profile's own patch ---------------------------

/** The Loader row this bundle inserted, as the profile's patch layer sees it. */
function configRow(ctx) {
  const editor = ctx.get('configEditor')
  if (!editor) return undefined
  let entries
  try {
    entries = editor.entries()
  } catch {
    return undefined
  }
  const entry = entries.find((candidate) => candidate?.options?.id === CONFIG_ID || candidate?.options?.name === '@local/dsh-quota')
  return entry ? { editor, entry } : undefined
}

/** The rows a config starts from when it names none — the plugin's defaults. */
function defaultProviderRows() {
  return DEFAULT_TARGETS.map((target) => ({ ...target }))
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i

/**
 * Rewrite this plugin's own `providers` list in the profile patch, which is
 * where every other tunable of this plugin lives and the one layer that
 * survives upgrades. The config that results is applied through the Loader, so
 * the page's list and the running targets agree after the reload.
 */
async function editProviders(ctx, mutate) {
  const found = configRow(ctx)
  if (!found) {
    throw new Error('this profile does not keep the dsh-quota row in its own patch layer, so the page cannot rewrite the provider list')
  }
  let next
  await found.editor.edit(found.entry, (current = {}, inherited = {}) => {
    const base = { ...inherited, ...current }
    const rows = Array.isArray(base.providers) && base.providers.length > 0
      ? base.providers.map((row) => ({ ...row }))
      : defaultProviderRows()
    next = mutate(rows)
    return { ...base, providers: next }
  })
  return next
}

// ---- usage ----------------------------------------------------------------------

/**
 * Every model call's usage, read off the stream waterfall. The wrapper passes
 * every chunk straight through, so a listener here cannot change what the
 * conversation sees; only a call that actually delivered a `usage` chunk and
 * did not fail is counted.
 */
function watchStream(usage, options, next) {
  const upstream = next()
  return (async function* watched() {
    let measured
    let failed = false
    try {
      for await (const chunk of upstream) {
        if (chunk?.type === 'usage' && chunk.usage) measured = chunk.usage
        if (chunk?.type === 'finish' && (chunk.kind === 'error' || chunk.kind === 'aborted')) failed = true
        yield chunk
      }
    } finally {
      if (measured && !failed) {
        usage.record({
          provider: options?.provider,
          model: options?.model,
          usage: measured,
          purpose: options?.purpose,
        })
      }
    }
  })()
}

export function apply(ctx, config) {
  const settings = normalize(config)
  const signIn = createSignIn(ctx, settings)
  ctx.effect(() => () => signIn.dispose())

  const usage = createUsageStore()
  void usage.ready()
  ctx.effect(() => () => { void usage.flush() })
  try {
    ctx.effect(() => ctx.on('llm/stream', (options, next) => watchStream(usage, options, next)))
  } catch (error) {
    // Counting tokens must never be the reason the page does not load.
    log(ctx, 'warn', '[quota] usage cannot observe model calls: %s', String(error?.message ?? error))
  }

  const service = createService(ctx, settings, signIn, usage)
  registerRoutes(ctx, service, settings, signIn)
  log(ctx, 'debug', '[quota] watching %s', settings.providers.map((entry) => entry.preset).join(', '))
}

export { ROUTES, XAI_OAUTH }
