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
import { PRICES } from './prices.js'
import { DEFAULT_PROMPT, createPredictor } from './prediction.js'
import { PRESETS, probeTarget, readQuota, worstOf } from './providers.js'
import { createUsageStore, usageFile } from './usage.js'
import { createWorkspaceProbe } from './workspace.js'
import { XAI_OAUTH, accountOf, pollDeviceFlow, startDeviceFlow, usableGrant } from './xai-oauth.js'

export const name = 'dsh-quota'

/** `webServer` carries the page's requests; `credentials` is read opportunistically. */
export const inject = ['webServer']

const ROUTES = Object.freeze({
  state: '/quota/state',
  refresh: '/quota/refresh',
  test: '/quota/test',
  suggest: '/quota/suggest',
  models: '/quota/models',
  predict: '/quota/predict',
  key: '/quota/key',
  clear: '/quota/clear',
  providers: '/quota/providers',
  providersRemove: '/quota/providers/remove',
  providersAttach: '/quota/providers/attach',
  providerModels: '/quota/provider/models',
  providerModelsDiscover: '/quota/provider/models/discover',
  providerModelsAdd: '/quota/provider/models/add',
  providerModelsRemove: '/quota/provider/models/remove',
  loginStart: '/quota/login/start',
  loginStatus: '/quota/login/status',
  loginCancel: '/quota/login/cancel',
  workspace: '/quota/workspace',
})

/** The Loader row this bundle inserts — the row a provider is added to. */
const CONFIG_ID = 'dsh-quota'

/** The record Grok's sign-in writes — `dsh-llm-pi-ai`'s own key for xAI. */
const XAI_RECORD = 'llm-pi-ai/xai'

const DEFAULT_REFRESH_MS = 60_000
const MAX_BODY_BYTES = 16 * 1024
/** The grammar a credential reference follows — an environment-variable name. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

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

/** Price overrides from config, keeping only entries a catalog price could use. */
function normalizePrices(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const input = Number(value.input)
    const output = Number(value.output)
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    const line = { input, output }
    if (Number.isFinite(Number(value.cacheRead))) line.cacheRead = Number(value.cacheRead)
    if (Number.isFinite(Number(value.cacheWrite))) line.cacheWrite = Number(value.cacheWrite)
    out[key] = line
  }
  return out
}

function normalize(config) {
  const enabled = pick(config, 'enabled', true) !== false
  const refreshMs = numberPick(config, 'refreshMs', DEFAULT_REFRESH_MS, 10_000, 3_600_000)
  const timeoutMs = numberPick(config, 'timeoutMs', 8000, 1000, 60_000)
  const alertAt = numberPick(config, 'alertAt', 90, 10, 100)
  const alertCriticalAt = numberPick(config, 'alertCriticalAt', 97, alertAt, 100)
  const balanceFloor = numberPick(config, 'balanceFloor', 5, 0, 1_000_000)
  // The strip below the composer shows the same numbers as the chip, so the
  // chip is off unless someone asks for it.
  const showChip = pick(config, 'showChip', false) === true
  const prices = { ...PRICES, ...normalizePrices(pick(config, 'prices', {})) }
  const configured = pick(config, 'providers', [])
  // No configuration means no cards: a provider the user never added is not
  // something this page should invent, and one that DSH cannot route would
  // only promise models that never show up in the selector.
  const list = Array.isArray(configured) ? configured : []
  const providers = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const preset = PRESETS[entry.preset]
    if (!preset) continue
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : entry.preset
    // A reference is a name, never a secret: a key pasted into this field is
    // dropped here rather than published on the page and into the payload.
    const reference = typeof entry.apiKeyEnv === 'string' && REF_PATTERN.test(entry.apiKeyEnv) ? entry.apiKeyEnv : preset.apiKeyEnv
    providers.push({
      id,
      preset: entry.preset,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : preset.label,
      baseURL: typeof entry.baseURL === 'string' && entry.baseURL !== '' ? entry.baseURL : preset.baseURL,
      apiKeyEnv: reference,
      record: typeof entry.record === 'string' && entry.record !== '' ? entry.record : preset.record,
      // Which model route this quota card belongs to, when there is one. The
      // page says whether that route is mounted instead of assuming it is.
      modelProvider: preset.model?.provider,
    })
  }
  return { enabled, refreshMs, timeoutMs, alertAt, alertCriticalAt, balanceFloor, showChip, prices, predict: normalizePredict(pick(config, 'predict', {})), providers }
}

/** The prediction knobs: off unless asked for, and the model is the session's own by default. */
function normalizePredict(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  return {
    enabled: source.enabled === true,
    provider: text(source.provider),
    model: text(source.model),
    systemPrompt: typeof source.systemPrompt === 'string' ? source.systemPrompt : '',
    maxTokens: Number.isFinite(Number(source.maxTokens)) ? Math.max(16, Math.min(2048, Number(source.maxTokens))) : 120,
    maxContextMessages: Number.isFinite(Number(source.maxContextMessages))
      ? Math.max(2, Math.min(64, Number(source.maxContextMessages)))
      : 12,
    debounceMs: Number.isFinite(Number(source.debounceMs)) ? Math.max(200, Math.min(10_000, Number(source.debounceMs))) : 700,
  }
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
 * Whether a card deserves to be shouted about, and how loudly: the tightest
 * window over `alertAt`, or a balance at or under `balanceFloor`.
 */
function alertOf(worst, balance, settings) {
  const used = worst?.used
  if (typeof used === 'number' && used >= settings.alertAt) {
    return used >= settings.alertCriticalAt ? 'critical' : 'warn'
  }
  if (typeof balance === 'string') {
    const amount = Number(balance.replace(/[^0-9.-]/g, ''))
    if (Number.isFinite(amount) && amount <= settings.balanceFloor) {
      return amount <= 0 ? 'critical' : 'warn'
    }
  }
  return undefined
}

/**
 * The provider id a hand-declared route is actually mounted under. A route
 * added before this preset got its own name (Bailian was `ali` once) still
 * counts as reachable when the endpoints are the same string.
 */
function mountedRouteFor(ctx, preset) {
  const route = preset?.route
  if (!route?.baseURL) return null
  const found = modelRouteRow(ctx)
  const providers = found?.entry?.options?.config?.providers
  if (!providers || typeof providers !== 'object') return null
  const want = String(route.baseURL).replace(/\/+$/, '').toLowerCase()
  for (const [id, row] of Object.entries(providers)) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.baseURL !== 'string') continue
    if (String(row.baseURL).replace(/\/+$/, '').toLowerCase() === want) return id
  }
  return null
}

/**
 * The provider ids DSH currently mounts, or `null` when this composition has no
 * llm service to ask. The page uses it to tell a card that is also a model route
 * from one that only holds a credential.
 */
async function mountedProviders(ctx) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.listProviders !== 'function') return null
  try {
    const providers = await llm.listProviders()
    return new Set((Array.isArray(providers) ? providers : []).map((provider) => provider?.id).filter(Boolean))
  } catch {
    return null
  }
}

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

  async function card(target, mounted) {
    const preset = PRESETS[target.preset]
    const card = { id: target.id, label: target.label, preset: target.preset, auth: preset.auth }
    if (preset.auth === 'key' && preset.keysUrl) card.keysUrl = preset.keysUrl
    // Whether the provider behind this card is also a route DSH can serve
    // models from. `null` = the Host has no llm service to ask.
    card.modelProvider = target.modelProvider ?? null
    card.inModels = target.modelProvider
      ? mounted === null ? null : mounted.has(target.modelProvider)
      : false
    if (card.inModels === false && preset.model?.kind === 'route') {
      const mountedAs = mountedRouteFor(ctx, preset)
      if (mountedAs) {
        card.modelProvider = mountedAs
        card.inModels = true
      }
    }
    if (preset.model === null) card.modelReason = 'quota-only'
    else if (card.inModels === false) card.modelReason = 'not-mounted'
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

    // A provider whose key cannot be priced or metered from outside: the card
    // exists to hold the credential, and says so instead of inventing numbers.
    if (preset.quota === false) {
      return { ...card, quota: false, windows: [], worst: null }
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
      const worst = worstOf(windows) ?? null
      return {
        ...card,
        url: reading.url,
        windows,
        worst,
        alert: alertOf(worst, reading.balance, settings),
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
    const mounted = await mountedProviders(ctx)
    const cards = await Promise.all(settings.providers.map((target) => card(target, mounted)))
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
        // A failed first refresh still gets a snapshot: the page then renders
        // its empty state instead of a state object with no `providers` at all.
        if (snapshot === undefined) {
          snapshot = { enabled: true, fetchedAt: new Date().toISOString(), refreshMs: settings.refreshMs, providers: [], error: 'the quota refresh failed' }
          cachedAt = Date.now()
        }
        return snapshot
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
        presets: Object.entries(PRESETS).map(([id, preset]) => ({
          id,
          label: preset.label,
          auth: preset.auth,
          addsModels: Boolean(preset.model),
          modelProvider: preset.model?.provider ?? null,
        })),
        showChip: settings.showChip,
        predict: settings.predict,
        defaultPrompt: DEFAULT_PROMPT,
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
  const predictor = createPredictor(ctx, () => settings)
  const probeWorkspace = createWorkspaceProbe()
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

  // The composer's left toolbar: which folder this conversation works in, and
  // the branch that folder is on. A session id is required — the answer belongs
  // to one conversation, not to whatever directory the Host process started in.
  route(ROUTES.workspace, async (req, res) => {
    if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') return jsonError(res, 400, 'sessionId is required')
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (!session) return jsonError(res, 404, 'unknown-session')
    const cwd = session.header?.cwd ?? session.cwd ?? session.meta?.cwd
    if (typeof cwd !== 'string' || cwd === '') return jsonError(res, 404, 'this session names no working directory')
    try {
      sendJson(res, 200, await probeWorkspace(cwd))
    } catch (error) {
      // The folder is known even when git is not: answer with it, say nothing
      // about a branch, and keep the composer rendering.
      sendJson(res, 200, { root: cwd, name: '', branch: null, gitRoot: null, detached: false, error: String(error?.message ?? error) })
    }
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

  // "Does this credential work?" — one request to the provider, answered as
  // data so the page can show the vendor's own words instead of an HTTP code.
  route(ROUTES.test, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    const preset = PRESETS[target.preset]
    const credentials = ctx.get('credentials')
    let credential
    try {
      credential = preset.auth === 'oauth'
        ? await oauthCredential(credentials, target, settings.timeoutMs)
        : await keyCredential(credentials, preset, target)
    } catch (error) {
      return sendJson(res, 200, { ok: false, detail: String(error?.message ?? error) })
    }
    if (!credential.token) {
      return jsonError(res, 400, credential.error ?? `no credential for ${credential.hint ?? preset.label}`)
    }
    try {
      const measured = preset.probe
        ? await probeTarget({ ...target, token: credential.token }, { timeoutMs: settings.timeoutMs })
        : await readQuota({ ...target, token: credential.token }, { timeoutMs: settings.timeoutMs, planCache: new Map() })
      const detail = typeof measured?.count === 'number'
        ? `${measured.count} models`
        : `${Array.isArray(measured?.windows) ? measured.windows.length : 0} windows`
      sendJson(res, 200, { ok: true, detail, url: measured?.url })
    } catch (error) {
      sendJson(res, 200, { ok: false, detail: String(error?.message ?? error) })
    }
  })

  // —— 输入预测 ——
  // One suggestion per call: the client asks when the conversation comes to
  // rest and the composer is empty, and aborts on the next keystroke.
  route(ROUTES.suggest, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return jsonError(res, 400, 'sessionId is required')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(settings.timeoutMs, 15_000))
    req.on?.('close', () => controller.abort())
    try {
      const answer = await predictor.suggest(sessionId, controller.signal)
      sendJson(res, 200, answer)
    } catch (error) {
      const said = error?.name === 'AbortError' ? 'aborted' : String(error?.message ?? error)
      sendJson(res, 200, { suggestion: null, reason: said })
    } finally {
      clearTimeout(timer)
    }
  })

  route(ROUTES.models, async (req, res) => {
    if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const llm = ctx.get('llm')
    if (!llm) return jsonError(res, 503, 'this composition mounts no llm service')
    try {
      const providers = await llm.listProviders()
      const groups = await Promise.all(providers.map(async (provider) => {
        try {
          const models = await llm.listModels(provider.id)
          return { provider: provider.id, name: provider.name ?? provider.id, models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })) }
        } catch {
          return { provider: provider.id, name: provider.name ?? provider.id, models: [] }
        }
      }))
      sendJson(res, 200, { groups })
    } catch (error) {
      jsonError(res, 500, String(error?.message ?? error))
    }
  })

  route(ROUTES.predict, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const patch = {}
    for (const key of ['provider', 'model', 'systemPrompt']) {
      if (typeof body[key] === 'string') patch[key] = body[key].trim()
    }
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    for (const key of ['maxTokens', 'maxContextMessages', 'debounceMs']) {
      if (Number.isFinite(Number(body[key]))) patch[key] = Number(body[key])
    }
    try {
      const next = await editConfig(ctx, (current) => ({
        ...current,
        predict: { ...(current.predict && typeof current.predict === 'object' ? current.predict : {}), ...patch },
      }))
      sendJson(res, 200, { ok: true, predict: normalizePredict(next.predict) })
    } catch (error) {
      jsonError(res, 500, String(error?.message ?? error))
    }
  })

  route(ROUTES.providers, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const preset = PRESETS[body.preset]
    if (!preset) return jsonError(res, 400, `unknown preset "${String(body.preset)}"`)
    const targets = service.targets()
    // One card per vendor: a second copy would ask the same endpoint with the
    // same credential and print the same number twice.
    const already = targets.find((entry) => entry.preset === body.preset)
    if (already) return jsonError(res, 409, `this provider is already on the page as "${already.id}"`)
    // The id is the model route's name where there is one, so a card and the
    // model selector agree; an explicit id stays possible for a second gateway.
    const wanted = typeof body.id === 'string' ? body.id.trim() : ''
    const id = wanted !== '' ? wanted : preset.model?.provider ?? preset.id
    if (!ID_PATTERN.test(id)) return jsonError(res, 400, 'the id must start with a letter or digit and hold only letters, digits and dashes')
    if (targets.some((entry) => entry.id === id)) return jsonError(res, 409, `"${id}" is already a provider`)
    const row = { id, preset: body.preset }
    for (const key of ['label', 'baseURL', 'record']) {
      const value = typeof body[key] === 'string' ? body[key].trim() : ''
      if (value !== '') row[key] = value
    }
    const reference = typeof body.apiKeyEnv === 'string' ? body.apiKeyEnv.trim() : ''
    if (reference !== '') {
      if (!REF_PATTERN.test(reference)) {
        return jsonError(res, 400, 'the credential reference is a name such as DASHSCOPE_API_KEY — paste the key itself into the card, not here')
      }
      row.apiKeyEnv = reference
    }
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (key !== '' && preset.auth !== 'key') return jsonError(res, 400, 'this provider signs in instead of taking a key')
    const credentials = key === '' ? undefined : ctx.get('credentials')
    if (key !== '' && !credentials) return jsonError(res, 503, 'this composition mounts no credential store')
    try {
      // The model side first: if it fails, nothing else is written and the page
      // never shows a card whose models are missing.
      const model = await attachModel(ctx, { preset, row, id })
      // The key before the card: a stored key without a card is harmless and
      // clearable, a card claiming a key it never got is not.
      let stored = false
      if (key !== '') {
        await credentials.set(row.apiKeyEnv ?? preset.apiKeyEnv, key)
        stored = true
      }
      // Idempotent: a double click may reach this line twice; the second one
      // finds the row already there instead of appending a duplicate.
      const providers = await editProviders(ctx, (rows) => (rows.some((entry) => entry.id === row.id) ? rows : [...rows, row]))
      sendJson(res, 200, { ok: true, id, providers, stored, model })
    } catch (error) {
      jsonError(res, 500, String(error?.message ?? error))
    }
  })

  // A card that was configured before the model wiring existed (or whose route
  // was removed by hand) can be connected without adding it a second time.
  route(ROUTES.providersAttach, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    const preset = PRESETS[target.preset]
    if (!preset.model) return jsonError(res, 400, 'this provider has no model route to attach')
    try {
      const model = await attachModel(ctx, { preset, row: target, id: target.id })
      sendJson(res, 200, { ok: true, model })
    } catch (error) {
      jsonError(res, 500, String(error?.message ?? error))
    }
  })

  // —— 一家的模型：看、问厂商要、加、删 ——
  // 全部写回 `llm-pi-ai.providers[provider].models`，所以模型选择器下一次
  // 请求看到的就是这里改出来的那份。
  route(ROUTES.providerModels, async (req, res) => {
    if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const target = targetOf(service, url.searchParams.get('id'))
    if (!target) return jsonError(res, 404, 'unknown-provider')
    if (!target.modelProvider) return jsonError(res, 400, 'this provider has no model route')
    const llm = ctx.get('llm')
    if (!llm?.listModels) return jsonError(res, 503, 'this composition mounts no llm service')
    const provider = await resolvedProvider(ctx, target, llm)
    try {
      sendJson(res, 200, { ok: true, provider, models: await listModels(llm, provider) })
    } catch (error) {
      sendJson(res, 200, { ok: false, provider, models: [], error: String(error?.message ?? error) })
    }
  })

  // "这家现在到底能提供哪些模型？" — 目录里有的按目录回答（不发请求），
  // 没有的（百炼这种手工路由）才拿存的 key 去问 `GET {baseURL}/models`。
  route(ROUTES.providerModelsDiscover, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    if (!target.modelProvider) return jsonError(res, 400, 'this provider has no model route')
    const llm = ctx.get('llm')
    if (!llm?.discoverModels) return jsonError(res, 503, 'this composition mounts no llm service')
    const provider = await resolvedProvider(ctx, target, llm)
    const found = modelRouteRow(ctx)
    const settingsNs = found?.entry?.options?.id ?? 'llm-pi-ai'
    const { route } = routeConfigOf(ctx, provider)
    const preset = PRESETS[target.preset]
    const request = { provider }
    const baseURL = route?.baseURL ?? preset.route?.baseURL
    const api = route?.api ?? preset.route?.api
    if (typeof baseURL === 'string' && baseURL !== '') request.baseURL = baseURL
    if (typeof api === 'string' && api !== '') request.api = api
    try {
      const models = await llm.discoverModels(settingsNs, request)
      sendJson(res, 200, {
        ok: true,
        provider,
        models: (Array.isArray(models) ? models : []).filter((model) => model && typeof model.id === 'string' && model.id !== ''),
      })
    } catch (error) {
      // The vendor's own words ("answered 401; check the API key") are the
      // useful part; the page shows them as-is.
      sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route(ROUTES.providerModelsAdd, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    if (!target.modelProvider) return jsonError(res, 400, 'this provider has no model route')
    const model = body.model && typeof body.model === 'object' ? body.model : {}
    const modelId = typeof model.id === 'string' ? model.id.trim() : ''
    if (!MODEL_ID_PATTERN.test(modelId)) return jsonError(res, 400, 'a model id is required')
    const name = typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : undefined
    const entry = { id: modelId }
    if (name) entry.name = name
    // Discovery answers with contextWindow / maxTokens / inputModalities; carry
    // the parts the route config spells, so adopting a candidate does not lose
    // the sizes the vendor just told us.
    if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) entry.contextWindow = model.contextWindow
    if (Number.isInteger(model.maxTokens) && model.maxTokens > 0) entry.maxTokens = model.maxTokens
    const input = Array.isArray(model.input)
      ? [...new Set(model.input.filter((value) => typeof value === 'string' && value !== ''))]
      : Array.isArray(model.inputModalities)
        ? [...new Set(model.inputModalities.filter((value) => typeof value === 'string' && value !== ''))]
        : []
    if (input.length > 0) entry.input = input
    const llm = ctx.get('llm')
    const provider = await resolvedProvider(ctx, target, llm)
    try {
      const rows = await effectiveModelRows(ctx, llm, provider)
      if (rows.some((row) => row.id === modelId)) return jsonError(res, 409, `"${modelId}" is already a model here`)
      const next = [...rows, entry]
      await writeRouteModels(ctx, provider, next)
      sendJson(res, 200, { ok: true, models: next })
    } catch (error) {
      jsonError(res, 500, String(error?.message ?? error))
    }
  })

  route(ROUTES.providerModelsRemove, async (req, res) => {
    if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
    if (!sameOrigin(req)) return forbidden(res, req)
    const body = await readJson(req)
    const target = targetOf(service, body.id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    if (!target.modelProvider) return jsonError(res, 400, 'this provider has no model route')
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : ''
    if (modelId === '') return jsonError(res, 400, 'modelId is required')
    const llm = ctx.get('llm')
    const provider = await resolvedProvider(ctx, target, llm)
    try {
      const rows = await effectiveModelRows(ctx, llm, provider)
      const next = rows.filter((row) => row.id !== modelId)
      if (next.length === rows.length) return jsonError(res, 404, 'unknown-model')
      // llm-pi-ai refuses a route that resolves no models at all.
      if (next.length === 0) return jsonError(res, 400, 'at least one model has to stay on this provider')
      await writeRouteModels(ctx, provider, next)
      sendJson(res, 200, { ok: true, models: next })
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
    const target = targets.find((entry) => entry.id === id)
    if (!target) return jsonError(res, 404, 'unknown-provider')
    try {
      const preset = PRESETS[target.preset]
      const providers = await editProviders(ctx, (rows) => rows.filter((row) => row.id !== id))
      // A route this plugin wrote goes with the card; a catalog entry stays,
      // because the provider may already have served models before it was
      // added here and removing quota tracking must not break the model list.
      if (preset.model?.kind === 'route' && preset.route) {
        await removeModelRoute(ctx, { id: preset.model.provider ?? id, route: preset.route })
      }
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

/**
 * One config write, serialized with this plugin's other writes.
 *
 * The editor derives the next document from the config it read when the entry
 * was handed in, so two writes that overlap can make the second one compare a
 * stale `next` against the document the first one just wrote — which the editor
 * reports as "overridden by a home patch" even though nothing overrides it.
 * A queue (plus an idempotent mutation) is what keeps a double click or a slow
 * reload from turning into that error.
 */
let configWriteChain = Promise.resolve()

async function editEntry(found, change) {
  const attempt = (entry) => found.editor.edit(entry, change)
  const run = async () => {
    try {
      return await attempt(found.entry)
    } catch (error) {
      const said = String(error?.message ?? error)
      if (!/no longer available|changed during reload|overridden by a home patch/.test(said)) throw error
      const fresh = found.editor.entries().find((entry) => entry?.options?.id === found.entry?.options?.id
        || entry?.options?.name === found.entry?.options?.name)
      if (fresh && fresh !== found.entry) return attempt(fresh)
      if (/overridden by a home patch/.test(said)) {
        throw new Error(`配置被更高优先级的层覆盖，页面改不了：检查 ~/.dsh/cordis.patch.yml（home patch）或 DSH 的 --patch 启动参数。原始信息：${said}`)
      }
      throw error
    }
  }
  const next = configWriteChain.then(run, run)
  configWriteChain = next.then(() => undefined, () => undefined)
  return next
}

/** The rows a config starts from: none. A provider exists once it is added. */
function defaultProviderRows() {
  return []
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
  await editEntry(found, (current = {}, inherited = {}) => {
    const base = { ...inherited, ...current }
    const rows = Array.isArray(base.providers) && base.providers.length > 0
      ? base.providers.map((row) => ({ ...row }))
      : defaultProviderRows()
    next = mutate(rows)
    return { ...base, providers: next }
  })
  return next
}

/**
 * Write into the dsh-quota row itself. The provider list has its own helper
 * (`editProviders`) because it has to seed the defaults; everything else — the
 * prediction settings — lands here.
 */
async function editConfig(ctx, mutate) {
  const found = configRow(ctx)
  if (!found) {
    throw new Error('this profile does not keep the dsh-quota row in its own patch layer, so the page cannot rewrite these settings')
  }
  let next
  await editEntry(found, (current = {}, inherited = {}) => {
    next = mutate({ ...inherited, ...current })
    return next
  })
  return next
}

/** The llm-pi-ai row, which owns the model routes a new provider needs. */
function modelRouteRow(ctx) {
  const editor = ctx.get('configEditor')
  if (!editor) return undefined
  let entries
  try {
    entries = editor.entries()
  } catch {
    return undefined
  }
  const entry = entries.find((candidate) => candidate?.options?.id === 'llm-pi-ai' || candidate?.options?.name === '@deepseek-ai/dsh-llm-pi-ai')
  return entry ? { editor, entry } : undefined
}

/**
 * Declare a provider pi-ai's own catalog does not know. A route lives in
 * `llm-pi-ai.providers`, so writing it is what puts the provider — and its
 * models — into the Models page and the model selector.
 */
async function upsertModelRoute(ctx, { id, label, reference, route }) {
  const found = modelRouteRow(ctx)
  if (!found) return null
  let written
  await editEntry(found, (current = {}, inherited = {}) => {
    const base = { ...inherited, ...current }
    const providers = { ...(base.providers ?? {}) }
    written = {
      ...(providers[id] ?? {}),
      ...(label ? { displayName: label } : {}),
      apiKeyEnv: reference,
      api: route.api,
      baseURL: route.baseURL,
      models: route.models.map((model) => ({ ...model })),
    }
    providers[id] = written
    return { ...base, providers }
  })
  return { provider: id, wired: true, entry: written }
}

/**
 * Put a provider pi-ai already knows into `llm-pi-ai.providers`, so the model
 * selector lists it. An entry that is already there is left exactly as it is —
 * the user may have narrowed its models or pointed it at another gateway.
 */
async function ensureCatalogRoute(ctx, { provider, reference }) {
  const found = modelRouteRow(ctx)
  if (!found) return { provider, wired: false, reason: 'this profile keeps no llm-pi-ai row' }
  let entry
  let wired = false
  await editEntry(found, (current = {}, inherited = {}) => {
    const base = { ...inherited, ...current }
    const providers = { ...(base.providers ?? {}) }
    const existing = providers[provider]
    if (existing !== undefined && typeof existing === 'object' && existing !== null) {
      entry = existing
      return base
    }
    entry = reference ? { apiKeyEnv: reference } : {}
    providers[provider] = entry
    wired = true
    return { ...base, providers }
  })
  return { provider, wired, entry }
}

/**
 * The one place a provider's model side is written: adding a provider and
 * re-attaching one both come through here, so the card list and the model
 * selector cannot drift apart.
 */
async function attachModel(ctx, { preset, row, id }) {
  const spec = preset?.model
  if (!spec) return null
  if (spec.kind === 'route' && preset.route) {
    return upsertModelRoute(ctx, {
      id: spec.provider ?? id,
      label: row?.label,
      reference: row?.apiKeyEnv ?? preset.apiKeyEnv,
      route: preset.route,
    })
  }
  if (spec.kind === 'catalog') {
    return ensureCatalogRoute(ctx, {
      provider: spec.provider,
      // An OAuth provider authenticates through its record; an apiKeyEnv would
      // override that login on every request.
      reference: spec.oauth ? undefined : (row?.apiKeyEnv ?? preset.apiKeyEnv),
    })
  }
  return null
}

/** Model ids are endpoint ids: no whitespace, no path punctuation games. */
const MODEL_ID_PATTERN = /^\S{1,200}$/

/**
 * The provider id a card's model route really has. Usually the preset's own
 * name, but a route added by hand under another name (Bailian once wrote `ali`)
 * is found through its endpoint instead of being declared a second time.
 */
async function resolvedProvider(ctx, target, llm) {
  const provider = target?.modelProvider
  if (!provider) return undefined
  try {
    const mounted = await llm?.listProviders?.()
    const ids = new Set((Array.isArray(mounted) ? mounted : []).map((entry) => entry?.id).filter(Boolean))
    if (ids.has(provider)) return provider
    const mountedAs = mountedRouteFor(ctx, PRESETS[target.preset])
    if (mountedAs && ids.has(mountedAs)) return mountedAs
  } catch {}
  return provider
}

/** The effective route config of one provider, as the llm-pi-ai row holds it. */
function routeConfigOf(ctx, provider) {
  const found = modelRouteRow(ctx)
  const providers = found?.entry?.options?.config?.providers
  const route = providers && typeof providers === 'object' ? providers[provider] : undefined
  return { found, route: route && typeof route === 'object' ? route : undefined }
}

/** What the Models page would list for one provider, flattened to what the page draws. */
async function listModels(llm, provider) {
  const models = await llm.listModels(provider)
  return (Array.isArray(models) ? models : [])
    .filter((model) => model && typeof model.id === 'string' && model.id !== '')
    .map((model) => ({
      id: model.id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    }))
}

/**
 * The rows to edit: the configured list when there is one, else the catalog the
 * route currently serves, written out. Editing a catalog route narrows it —
 * that is what "delete a model" means in `llm-pi-ai.providers`.
 */
async function effectiveModelRows(ctx, llm, provider) {
  const { route } = routeConfigOf(ctx, provider)
  if (Array.isArray(route?.models) && route.models.length > 0) return route.models.map((model) => ({ ...model }))
  const models = await listModels(llm, provider).catch(() => [])
  return models.map((model) => ({
    id: model.id,
    ...(model.name && model.name !== model.id ? { name: model.name } : {}),
    ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    ...(Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
  }))
}

/** Replace one route's model list in the profile patch. */
async function writeRouteModels(ctx, provider, models) {
  const found = modelRouteRow(ctx)
  if (!found) throw new Error('this profile keeps no llm-pi-ai row, so models cannot be edited here')
  await editEntry(found, (current = {}, inherited = {}) => {
    const base = { ...inherited, ...current }
    const providers = { ...(base.providers ?? {}) }
    const route = { ...(providers[provider] ?? {}) }
    route.models = models.map((model) => ({ ...model }))
    providers[provider] = route
    return { ...base, providers }
  })
}

/**
 * Take the route back out when its provider is removed — but only when it still
 * looks like the one this plugin wrote, so a hand-edited route survives.
 */
async function removeModelRoute(ctx, { id, route }) {
  const found = modelRouteRow(ctx)
  if (!found) return false
  let removed = false
  await editEntry(found, (current = {}, inherited = {}) => {
    const base = { ...inherited, ...current }
    const providers = { ...(base.providers ?? {}) }
    const existing = providers[id]
    if (existing && typeof existing === 'object' && existing.baseURL === route.baseURL) {
      delete providers[id]
      removed = true
    }
    return { ...base, providers }
  })
  return removed
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

  const usage = createUsageStore({ priceOf: (provider, model) => settings.prices[provider + '/' + model] })
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
