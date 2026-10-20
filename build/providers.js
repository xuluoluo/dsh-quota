/**
 * Quota reading for the providers this plugin watches, as pure functions.
 *
 * Nothing here imports a DSH package, so every reader can be exercised from a
 * plain Node process against the real vendors (`test/providers.test.mjs`,
 * `test/live-probe.mjs`). A reader takes the vendor's JSON and returns windows
 * of one normalized shape — `{ key, used, resetsAt, display }`, `used` a
 * percentage 0–100 — plus the plan and balance a card may show.
 *
 * Where the numbers come from, as the vendors actually answer on 2026-10-20:
 *
 * - OpenCode Go (`https://opencode.ai/zen/go/v1/usage`): three rolling windows
 *   — `rolling`, `weekly`, `monthly` — each a percent used plus its reset.
 * - Grok / SuperGrok (`https://cli-chat-proxy.grok.com/v1/billing?format=credits`):
 *   `creditUsagePercent` for the current period (weekly on a subscription),
 *   the per-product split, the on-demand cap when the plan has one, and the
 *   prepaid balance.
 * - Command Code (`https://api.commandcode.ai/alpha/billing/credits`): the
 *   plan's five-hour and weekly windows as used/cap, and the month's credits
 *   as dollars left; `…/alpha/billing/subscriptions` names the plan, which is
 *   what the monthly allotment — and so the credits window — is read from.
 */

const DEFAULT_TIMEOUT_MS = 8000

/** Presets: where a provider's quota is asked, and how it authenticates. */
export const PRESETS = Object.freeze({
  'opencode-go': {
    label: 'OpenCode Go',
    auth: 'key',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    keysUrl: 'https://opencode.ai/auth',
    baseURL: 'https://opencode.ai/zen/go',
  },
  'xai-billing': {
    label: 'Grok',
    auth: 'oauth',
    record: 'llm-pi-ai/xai',
    login: 'xai-device-code',
    baseURL: 'https://cli-chat-proxy.grok.com/v1',
  },
  commandcode: {
    label: 'Command Code',
    auth: 'key',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    keysUrl: 'https://commandcode.ai/settings/keys',
    baseURL: 'https://api.commandcode.ai',
    /** The Command Code CLI's own sign-in, read when no key is stored. */
    cliAuth: '.commandcode/auth.json',
  },
})

const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '')

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Clamp a percentage into 0–100; undefined when it is not a number. */
function percent(value) {
  const number = asNumber(value)
  if (number === undefined) return undefined
  return Math.min(100, Math.max(0, number))
}

/** A reset time as ISO: RFC 3339 text, or unix seconds / milliseconds. */
function isoTime(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value)
    return Number.isNaN(time) ? undefined : new Date(time).toISOString()
  }
  const number = asNumber(value)
  if (number === undefined || number <= 0) return undefined
  return new Date(number < 1e12 ? number * 1000 : number).toISOString()
}

/** `4.78` → `$4.78`, the way the vendors' own pages print credits. */
export function money(value) {
  const number = asNumber(value)
  if (number === undefined) return ''
  return `$${number.toFixed(2)}`
}

// ---- OpenCode Go ---------------------------------------------------------------

/**
 * OpenCode Go's windows, in the gateway's own order.
 * `{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"…"},…}}`
 */
export function readOpenCodeUsage(body) {
  const usage = isObject(body?.usage) ? body.usage : body
  if (!isObject(usage)) throw new Error('the reply holds no usage')
  const windows = []
  for (const key of ['rolling', 'weekly', 'monthly']) {
    const entry = usage[key]
    if (!isObject(entry)) continue
    const used = percent(entry.percent)
    if (used === undefined) continue
    windows.push({ key, used, resetsAt: isoTime(entry.resetsAt) })
  }
  if (windows.length === 0) throw new Error('the reply holds no readable window')
  return windows
}

async function openCodeQuota(target, preset, io) {
  const url = `${target.baseURL}/v1/usage`
  const body = await io.fetchJson(url, {
    headers: { authorization: `Bearer ${target.token}` },
    signal: io.signal,
    timeoutMs: io.timeoutMs,
  })
  return { url, windows: readOpenCodeUsage(body) }
}

// ---- Grok ----------------------------------------------------------------------

/**
 * Grok's current period, plus on-demand spending when the plan caps it:
 * `{"config":{"creditUsagePercent":100,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"…"},"productUsage":[{"product":"GrokBuild","usagePercent":92}],"prepaidBalance":{"val":0}}}`
 */
export function readXaiBilling(body) {
  const config = isObject(body?.config) ? body.config : body
  if (!isObject(config)) throw new Error('the reply holds no config')
  const period = isObject(config.currentPeriod) ? config.currentPeriod : {}
  const resetsAt = isoTime(period.end) ?? isoTime(config.billingPeriodEnd)
  const windows = []

  const used = percent(config.creditUsagePercent)
  if (used !== undefined) windows.push({ key: periodKey(period.type), used, resetsAt })

  const cap = asNumber(config.onDemandCap?.val)
  const spent = asNumber(config.onDemandUsed?.val)
  if (cap !== undefined && cap > 0 && spent !== undefined) {
    windows.push({ key: 'on-demand', used: percent((spent / cap) * 100), resetsAt })
  }
  if (windows.length === 0) throw new Error('the reply holds no readable window')

  const parts = []
  for (const entry of Array.isArray(config.productUsage) ? config.productUsage : []) {
    const name = typeof entry?.product === 'string' ? entry.product : ''
    const share = percent(entry?.usagePercent)
    if (name && share !== undefined) parts.push({ name, used: share })
  }
  const prepaid = asNumber(config.prepaidBalance?.val)
  return { windows, parts, balance: prepaid !== undefined && prepaid > 0 ? money(prepaid) : undefined }
}

/** A period type to the window key the client labels. */
function periodKey(type) {
  const name = String(type ?? '').toUpperCase()
  if (name.includes('WEEKLY')) return 'weekly'
  if (name.includes('MONTHLY')) return 'monthly'
  if (name.includes('DAILY')) return 'daily'
  if (name.includes('SEASONAL')) return 'seasonal'
  if (name.includes('FIVE_HOUR') || name.includes('FIVEHOUR')) return 'five-hour'
  return 'period'
}

async function xaiQuota(target, preset, io) {
  const url = `${target.baseURL}/billing?format=credits`
  const body = await io.fetchJson(url, {
    headers: { authorization: `Bearer ${target.token}`, 'x-xai-token-auth': 'xai-grok-cli' },
    signal: io.signal,
    timeoutMs: io.timeoutMs,
  })
  return { url, ...readXaiBilling(body) }
}

// ---- Command Code --------------------------------------------------------------

/**
 * The plans as Command Code's CLI names them, longest id prefix first, with
 * the dollars of credits each gives a month (its `getPlanInfo`).
 */
export const COMMAND_CODE_PLANS = Object.freeze([
  { id: 'individual-provider', name: 'Provider', monthly: 15 },
  { id: 'individual-pro-v1', name: 'Pro', monthly: 80 },
  { id: 'individual-goat', name: 'GOAT', monthly: 70 },
  { id: 'individual-ultra', name: 'Ultra', monthly: 300 },
  { id: 'individual-max', name: 'Max', monthly: 150 },
  { id: 'individual-pro', name: 'Pro', monthly: 30 },
  { id: 'individual-go', name: 'Go', monthly: 10 },
  { id: 'teams-pro', name: 'Teams Pro', monthly: 40 },
])

/** The plan a `planId` names, or undefined for one this build doesn't know. */
export function commandCodePlan(planId) {
  const id = String(planId ?? '').toLowerCase().replace(/_/g, '-')
  if (id === '') return undefined
  let hit
  for (const plan of COMMAND_CODE_PLANS) {
    if (!id.startsWith(plan.id)) continue
    if (hit === undefined || plan.id.length > hit.id.length) hit = plan
  }
  return hit
}

/**
 * `/alpha/billing/credits`, as the CLI's own `/usage` reads it:
 * `{"credits":{"monthlyCredits":0.066,"purchasedCredits":0,"freeCredits":0},"windowLimits":{"fiveHour":{"used":0,"cap":14,"resetAt":0},"weekly":{"used":4.18,"cap":35,"resetAt":1792853160767}}}`
 */
export function readCommandCodeCredits(body) {
  const credits = isObject(body?.credits) ? body.credits : {}
  const monthly = Math.max(0, asNumber(credits.monthlyCredits) ?? 0)
  const purchased = Math.max(0, asNumber(credits.purchasedCredits) ?? 0)
  const free = Math.max(0, asNumber(credits.freeCredits) ?? 0)
  const windows = []
  const limits = isObject(body?.windowLimits) ? body.windowLimits : {}
  for (const [key, raw] of [['five-hour', limits.fiveHour], ['weekly', limits.weekly]]) {
    if (!isObject(raw)) continue
    const used = asNumber(raw.used)
    const cap = asNumber(raw.cap)
    if (used === undefined || cap === undefined || cap <= 0) continue
    windows.push({ key, used: percent((used / cap) * 100), resetsAt: isoTime(raw.resetAt) })
  }
  return { windows, monthly, purchased, free, left: monthly + purchased + free }
}

/** `/alpha/billing/subscriptions`: the plan, its period and whether it renews. */
export function readCommandCodeSubscription(body) {
  if (isObject(body) && body.success === false) throw new Error('the vendor could not tell the subscription')
  const data = isObject(body?.data) ? body.data : undefined
  if (!data || typeof data.planId !== 'string' || data.planId === '') return undefined
  if (data.status === 'canceled' || data.status === 'incomplete_expired') return undefined
  const plan = commandCodePlan(data.planId)
  return {
    planId: data.planId,
    plan: plan?.name,
    monthly: plan?.monthly,
    until: isoTime(data.currentPeriodEnd),
    renew: typeof data.cancelAtPeriodEnd === 'boolean' ? (data.cancelAtPeriodEnd ? 'off' : 'auto') : undefined,
  }
}

/**
 * The month's credits as one more window, when the plan's allotment is known:
 * what the plan gives plus anything bought or granted, and what is left of it.
 */
export function commandCodeCreditsWindow(credits, planMonthly) {
  if (!(asNumber(planMonthly) > 0)) return undefined
  const pool = Math.max(planMonthly, credits.monthly) + credits.purchased + credits.free
  if (!(pool > 0)) return undefined
  const spent = Math.max(0, pool - credits.left)
  return {
    key: 'credits',
    used: percent((spent / pool) * 100),
    display: `${money(spent)} / ${money(pool)}`,
  }
}

async function commandCodeQuota(target, preset, io) {
  const base = target.baseURL
  const url = `${base}/alpha/billing/credits`
  const headers = { authorization: `Bearer ${target.token}` }

  // billing/credits leaves the plan out, and the month's allotment is the
  // plan's: ask subscriptions beside it, once per ten minutes, and let a
  // failure keep what was read. It is asked in parallel because the vendor's
  // own subscription endpoint is the slow one (15–20 s at times) and the
  // windows must not wait behind it.
  const seen = io.planCache?.get(target.id)
  const stale = !seen || io.now() - seen.at > 10 * 60 * 1000
  const subscriptionTimeout = Math.min(Math.max(io.timeoutMs, 4000), 10000)

  const creditsRequest = io.fetchJson(url, { headers, signal: io.signal, timeoutMs: io.timeoutMs })
  const subscriptionRequest = stale
    ? io.fetchJson(`${base}/alpha/billing/subscriptions`, { headers, signal: io.signal, timeoutMs: subscriptionTimeout })
      .catch(() => undefined)
    : Promise.resolve(undefined)

  const [body, subscribed] = await Promise.all([creditsRequest, subscriptionRequest])
  const credits = readCommandCodeCredits(body)

  let plan = seen
  if (subscribed !== undefined) {
    try {
      const read = readCommandCodeSubscription(subscribed)
      if (read) {
        plan = { at: io.now(), ...read }
        io.planCache?.set(target.id, plan)
      }
    } catch {
      plan = seen
    }
  }

  const windows = [...credits.windows]
  const creditWindow = commandCodeCreditsWindow(credits, plan?.monthly)
  if (creditWindow) windows.push(creditWindow)
  return {
    url,
    windows,
    plan: plan?.plan,
    until: plan?.until,
    renew: plan?.renew,
    balance: creditWindow ? undefined : credits.left > 0 ? money(credits.left) : undefined,
  }
}

// ---- the reader the Host calls ------------------------------------------------

const READERS = {
  'opencode-go': openCodeQuota,
  'xai-billing': xaiQuota,
  commandcode: commandCodeQuota,
}

/**
 * One provider's reading. `target` is `{ id, preset, baseURL, token }`; `io`
 * carries the fetch, the signal, the timeouts and the Command Code plan cache.
 */
export async function readQuota(target, io = {}) {
  const preset = PRESETS[target.preset]
  if (!preset) throw new Error(`unknown quota preset "${String(target.preset)}"`)
  const read = READERS[target.preset]
  return read({ ...target, baseURL: trimSlash(target.baseURL || preset.baseURL) }, preset, {
    fetchJson,
    signal: io.signal,
    timeoutMs: io.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    now: io.now ?? Date.now,
    planCache: io.planCache,
  })
}

// ---- HTTP ---------------------------------------------------------------------

/** The first line of a reply, cut short, for a card's error text. */
function summaryOf(text) {
  const line = String(text ?? '').split(/\r?\n/).find((entry) => entry.trim() !== '') ?? ''
  const trimmed = line.trim().replace(/\s+/g, ' ')
  if (trimmed === '') return ''
  return `: ${trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed}`
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** A failed request as one line: what was reached, and what it said. */
async function fetchJson(url, { headers = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      body,
      signal: composed,
    })
  } catch (error) {
    throw new Error(`cannot reach ${hostOf(url)}: ${describeNetworkError(error, timeoutMs)}`)
  }
  let text
  try {
    text = await response.text()
  } catch (error) {
    throw new Error(`cannot read ${hostOf(url)}: ${describeNetworkError(error, timeoutMs)}`)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}${summaryOf(text)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`the reply from ${hostOf(url)} is not JSON`)
  }
}

function describeNetworkError(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `no answer in ${timeoutMs} ms`
  const code = error?.cause?.code ?? error?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the name does not resolve'
  if (code === 'ECONNREFUSED') return 'the connection was refused'
  if (code === 'ECONNRESET') return 'the connection was reset'
  return String(error?.message ?? error)
}

/** The worst window of a card: what a compact chip shows. */
export function worstOf(windows) {
  let worst
  for (const window of windows ?? []) {
    if (typeof window?.used !== 'number') continue
    if (worst === undefined || window.used > worst.used) worst = window
  }
  return worst
}
