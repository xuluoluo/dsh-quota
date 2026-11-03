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
 * - ChatGPT subscription, as Codex reads it
 *   (`GET https://chatgpt.com/backend-api/wham/usage`): `rate_limit`'s
 *   primary and secondary windows. A window is five-hour or weekly by its
 *   `limit_window_seconds`, not by which field it arrived in — a team plan
 *   currently reports only the week, under `primary_window`.
 * - Claude Pro/Max, as Claude Code reads it
 *   (`GET https://api.anthropic.com/api/oauth/usage`): `five_hour` and
 *   `seven_day` utilization, plus a model window when the reply actually
 *   carries one. `utilization` is already a 0–100 percentage.
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
    /** pi-ai already mounts this provider: its catalog supplies the models. */
    model: { provider: 'opencode-go', kind: 'catalog' },
  },
  'xai-billing': {
    label: 'Grok',
    auth: 'oauth',
    record: 'llm-pi-ai/xai',
    login: 'xai-device-code',
    baseURL: 'https://cli-chat-proxy.grok.com/v1',
    model: { provider: 'xai', kind: 'catalog', oauth: true },
  },
  commandcode: {
    label: 'Command Code',
    auth: 'key',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    keysUrl: 'https://commandcode.ai/settings/keys',
    baseURL: 'https://api.commandcode.ai',
    /** The Command Code CLI's own sign-in, read when no key is stored. */
    cliAuth: '.commandcode/auth.json',
    /** No pi-ai provider and no OpenAI-compatible chat endpoint: quota only. */
    model: null,
  },
  'deepseek-api': {
    label: 'DeepSeek API',
    auth: 'key',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    baseURL: 'https://api.deepseek.com',
    model: { provider: 'deepseek', kind: 'catalog' },
  },
  bailian: {
    label: 'Alibaba Bailian',
    auth: 'key',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    keysUrl: 'https://bailian.console.aliyun.com/',
    /**
     * Bailian's DashScope key has no public balance or quota endpoint — the
     * bill lives in Alibaba Cloud's Billing API, which wants an AccessKey, not
     * this key — so this target only stores the key here.
     */
    quota: false,
    /** What "test this key" asks: the OpenAI-compatible model list. */
    probe: 'models',
    /**
     * pi-ai ships no Bailian provider, so adding this target also declares the
     * route in `llm-pi-ai.providers`: the OpenAI-compatible endpoint and the
     * models it serves (ids read from
     * `GET https://dashscope.aliyuncs.com/compatible-mode/v1/models`).
     */
    model: { provider: 'bailian', kind: 'route' },
    route: {
      api: 'openai-completions',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [
        { id: 'qwen3.8-max', name: 'Qwen3.8 Max' },
        { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
      ],
    },
  },
  /**
   * ChatGPT Plus / Pro / Team, shared with Codex. The subscription window is
   * not on an API key — Codex's own login (`~/.codex/auth.json`) is what
   * `wham/usage` accepts. Quota only: that login is not an OpenAI API key.
   */
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    auth: 'cli',
    cliAuth: '.codex/auth.json',
    cliKind: 'codex',
    baseURL: 'https://chatgpt.com/backend-api',
    model: { provider: 'openai-codex', kind: 'catalog', oauth: true },
  },
  /**
   * Claude Pro / Max, shared by claude.ai and Claude Code. The usage endpoint
   * wants the OAuth access token Claude Code stores, not an Anthropic API key.
   */
  claude: {
    id: 'claude',
    label: 'Claude',
    auth: 'cli',
    cliAuth: '.claude/.credentials.json',
    cliKind: 'claude',
    baseURL: 'https://api.anthropic.com',
    model: { provider: 'anthropic', kind: 'catalog', oauth: true },
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

// ---- DeepSeek's own API ---------------------------------------------------------

/** The currency signs the platform reports balances in. */
const CURRENCY = { CNY: '¥', USD: '$', HKD: 'HK$', EUR: '€' }

function currencyOf(code) {
  const key = String(code ?? '').toUpperCase()
  return CURRENCY[key] ?? (key === '' ? '' : `${key} `)
}

/**
 * `GET /user/balance`, as the official API answers it:
 * `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}`
 *
 * A balance is money, not a window: there is no denominator the vendor exposes,
 * so this makes no progress bar — the card shows the amount and what it is made
 * of. `is_available` is the vendor saying whether the key can still pay.
 */
export function readDeepSeekBalance(body) {
  const infos = (Array.isArray(body?.balance_infos) ? body.balance_infos : []).filter(isObject)
  const info = infos[0]
  if (!info) throw new Error('the reply holds no balance')
  const symbol = currencyOf(info.currency)
  const total = asNumber(info.total_balance)
  if (total === undefined) throw new Error('the reply holds no total balance')

  const parts = []
  const topped = asNumber(info.topped_up_balance)
  const granted = asNumber(info.granted_balance)
  if (topped !== undefined) parts.push(`topped up ${symbol}${topped.toFixed(2)}`)
  if (granted !== undefined && granted > 0) parts.push(`granted ${symbol}${granted.toFixed(2)}`)
  if (infos.length > 1) parts.push(`+${infos.length - 1} more currency`)

  const available = body?.is_available !== false
  const bits = available ? [] : ['cannot pay right now']
  bits.push(...parts)
  return {
    windows: [],
    balance: `${symbol}${total.toFixed(2)}`,
    available,
    note: bits.join(' · '),
  }
}

async function deepSeekQuota(target, preset, io) {
  const url = `${target.baseURL}/user/balance`
  const body = await io.fetchJson(url, {
    headers: { authorization: `Bearer ${target.token}` },
    signal: io.signal,
    timeoutMs: io.timeoutMs,
  })
  return { url, ...readDeepSeekBalance(body) }
}

// ---- ChatGPT subscription (Codex) ----------------------------------------------

/** A plan id as a card should print it. Unknown ids keep their own capital. */
export function planLabel(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return undefined
  const known = {
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    free: 'Free',
    go: 'Go',
    max: 'Max',
    pro_lite: 'Pro Lite',
    prolite: 'Pro Lite',
  }
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_')
  return known[key] ?? raw.charAt(0).toUpperCase() + raw.slice(1)
}

/** Claims of a JWT, read and never verified. Undefined when it is not one. */
function jwtClaims(access) {
  try {
    const part = String(access ?? '').split('.')[1]
    if (!part) return undefined
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return isObject(claims) ? claims : undefined
  } catch {
    return undefined
  }
}

function claimObject(claims, key) {
  return isObject(claims?.[key]) ? claims[key] : undefined
}

/** Five hours, a day, a week, a month — from the window's own length. */
function windowKeyForSeconds(seconds, fallback) {
  const span = asNumber(seconds)
  if (span === undefined || span <= 0) return fallback
  if (span >= 86400 * 25) return 'monthly'
  if (span >= 172800) return 'weekly'
  if (span >= 20 * 3600) return 'daily'
  if (span >= 3 * 3600) return 'five-hour'
  if (span >= 30 * 60) return 'hourly'
  return fallback
}

/**
 * One Codex rate-limit window. `used_percent` is 0–100 already used;
 * older replies say `percent_left` instead. The length, not the field name,
 * decides whether this is the five-hour window or the week.
 */
function readRateWindow(raw, fallback) {
  if (!isObject(raw)) return undefined
  let used = percent(raw.used_percent ?? raw.usedPercent)
  if (used === undefined) {
    const left = percent(raw.percent_left ?? raw.percentLeft)
    if (left !== undefined) used = percent(100 - left)
  }
  if (used === undefined) return undefined
  return {
    key: windowKeyForSeconds(raw.limit_window_seconds ?? raw.limitWindowSeconds, fallback),
    used,
    resetsAt: isoTime(raw.reset_time_ms) ?? isoTime(raw.resetsAt) ?? isoTime(raw.reset_at),
  }
}

function pushWindow(windows, seen, window) {
  if (!window || seen.has(window.key)) return
  seen.add(window.key)
  windows.push(window)
}

/**
 * `GET /backend-api/wham/usage`, as Codex's `/status` reads it.
 * A single present window is enough; `secondary_window: null` is not an error.
 */
export function readChatGptUsage(body) {
  const root = isObject(body?.rate_limit) ? body.rate_limit : isObject(body?.rate_limits) ? body.rate_limits : undefined
  if (!root) throw new Error('the reply holds no rate limit')
  const windows = []
  const seen = new Set()
  const families = [
    ['five-hour', ['five_hour', 'primary_window', 'primary']],
    ['weekly', ['weekly', 'secondary_window', 'secondary']],
  ]
  for (const [fallback, names] of families) {
    let raw
    for (const name of names) {
      if (isObject(root[name])) {
        raw = root[name]
        break
      }
    }
    pushWindow(windows, seen, readRateWindow(raw, fallback))
  }
  const review = isObject(body?.code_review_rate_limit) ? body.code_review_rate_limit : undefined
  if (review) {
    const inner = isObject(review.primary_window) ? review.primary_window : review
    const window = readRateWindow(inner, 'review')
    if (window) pushWindow(windows, seen, { ...window, key: 'review' })
  }
  if (windows.length === 0) throw new Error('the reply holds no readable window')

  const credits = isObject(body?.credits) ? body.credits : undefined
  let note
  let balance
  if (credits?.unlimited === true) note = 'credits are unlimited'
  else if (credits?.has_credits === true) {
    const amount = asNumber(credits.balance)
    if (amount !== undefined) balance = money(amount)
  }
  if (credits?.overage_limit_reached === true) note = [note, 'overage limit reached'].filter(Boolean).join(' · ')
  return { windows, plan: planLabel(body?.plan_type), balance, note }
}

/** Codex's `auth.json`: the ChatGPT login, or a stated reason it cannot be used. */
export function readCodexAuth(body) {
  if (!isObject(body)) return undefined
  const tokens = isObject(body.tokens) ? body.tokens : {}
  const access = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  if (access === '') {
    if (typeof body.OPENAI_API_KEY === 'string' && body.OPENAI_API_KEY !== '') {
      return { error: 'Codex is signed in with an API key, which has no ChatGPT subscription window' }
    }
    return undefined
  }
  const claims = jwtClaims(access)
  const profile = claimObject(claims, 'https://api.openai.com/profile')
  const account = typeof profile?.email === 'string' && profile.email !== ''
    ? profile.email
    : typeof claims?.email === 'string' && claims.email !== '' ? claims.email : undefined
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id !== '' ? tokens.account_id : undefined
  return { token: access, accountId, account, expiresAt: isoTime(claims?.exp) }
}

async function chatGptQuota(target, preset, io) {
  const url = `${target.baseURL}/wham/usage`
  const headers = {
    authorization: `Bearer ${target.token}`,
    accept: 'application/json',
    origin: 'https://chatgpt.com',
    referer: 'https://chatgpt.com/',
    'user-agent': 'codex-cli',
  }
  if (typeof target.accountId === 'string' && target.accountId !== '') headers['ChatGPT-Account-Id'] = target.accountId
  const body = await io.fetchJson(url, { headers, signal: io.signal, timeoutMs: io.timeoutMs })
  return { url, ...readChatGptUsage(body) }
}

// ---- Claude subscription (Claude Code) ------------------------------------------

/** The windows Claude Code's own status line names. Anything else stays out. */
const CLAUDE_WINDOWS = Object.freeze([
  ['five_hour', 'five-hour'],
  ['seven_day', 'weekly'],
  ['seven_day_sonnet', 'sonnet'],
  ['seven_day_opus', 'opus'],
  ['seven_day_cowork', 'cowork'],
  ['seven_day_oauth_apps', 'apps'],
])

/**
 * `GET /api/oauth/usage`. `utilization` is a percentage, so `1` is 1%, not
 * full. Null buckets (a Pro plan has no separate Opus window) are skipped.
 * `seven_day_breakdown` is how the week was spent, not another limit.
 */
export function readClaudeUsage(body) {
  if (!isObject(body)) throw new Error('the reply holds no usage')
  const windows = []
  const seen = new Set()
  for (const [name, key] of CLAUDE_WINDOWS) {
    const entry = body[name]
    if (!isObject(entry)) continue
    const used = percent(entry.utilization ?? entry.percent)
    if (used === undefined) continue
    const spent = asNumber(entry.used_dollars)
    const cap = asNumber(entry.limit_dollars)
    pushWindow(windows, seen, {
      key,
      used,
      resetsAt: isoTime(entry.resets_at),
      display: spent !== undefined && cap !== undefined && cap > 0 ? `${money(spent)} / ${money(cap)}` : undefined,
    })
  }
  if (windows.length === 0 && Array.isArray(body.limits)) {
    for (const entry of body.limits) {
      if (!isObject(entry)) continue
      const used = percent(entry.percent)
      if (used === undefined) continue
      const kind = String(entry.kind ?? '')
      const key = kind === 'session' ? 'five-hour' : kind === 'weekly_all' || entry.group === 'weekly' ? 'weekly' : (kind.replace(/_/g, '-') || 'period')
      pushWindow(windows, seen, { key, used, resetsAt: isoTime(entry.resets_at) })
    }
  }
  const extra = isObject(body.extra_usage) ? body.extra_usage : undefined
  if (extra?.is_enabled === true) {
    const spent = asNumber(extra.used_credits)
    const cap = asNumber(extra.monthly_limit)
    const used = percent(extra.utilization) ?? (spent !== undefined && cap !== undefined && cap > 0 ? percent((spent / cap) * 100) : undefined)
    if (used !== undefined) {
      pushWindow(windows, seen, {
        key: 'credits',
        used,
        display: spent !== undefined && cap !== undefined ? `${money(spent)} / ${money(cap)}` : undefined,
      })
    }
  }
  if (windows.length === 0) throw new Error('the reply holds no readable window')

  const rows = Array.isArray(body.seven_day_breakdown?.rows) ? body.seven_day_breakdown.rows : []
  const shares = []
  for (const row of rows) {
    const share = asNumber(row?.percent)
    const name = typeof row?.display_name === 'string' ? row.display_name : ''
    if (name && share !== undefined && share > 0) shares.push(`${name} ${Math.round(share)}%`)
  }
  return { windows, note: shares.length > 0 ? `of the week: ${shares.join(' · ')}` : undefined }
}

/** Claude Code's `.credentials.json`: the OAuth access token and the plan. */
export function readClaudeAuth(body) {
  const oauth = isObject(body?.claudeAiOauth) ? body.claudeAiOauth : isObject(body) ? body : undefined
  if (!oauth) return undefined
  const token = typeof oauth.accessToken === 'string' ? oauth.accessToken
    : typeof oauth.access_token === 'string' ? oauth.access_token : ''
  if (token === '') return undefined
  return {
    token,
    plan: planLabel(oauth.subscriptionType),
    expiresAt: isoTime(oauth.expiresAt),
  }
}

async function claudeQuota(target, preset, io) {
  const url = `${target.baseURL}/api/oauth/usage`
  const body = await io.fetchJson(url, {
    headers: {
      authorization: `Bearer ${target.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'claude-code',
    },
    signal: io.signal,
    timeoutMs: io.timeoutMs,
  })
  return { url, ...readClaudeUsage(body) }
}

// ---- the reader the Host calls ------------------------------------------------

const READERS = {
  'opencode-go': openCodeQuota,
  'xai-billing': xaiQuota,
  commandcode: commandCodeQuota,
  'deepseek-api': deepSeekQuota,
  chatgpt: chatGptQuota,
  claude: claudeQuota,
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

/**
 * Ask a target that has no quota endpoint whether its key works at all. The
 * provider's own model list is the cheapest request that answers that.
 */
export async function probeTarget(target, io = {}) {
  const preset = PRESETS[target.preset]
  if (!preset?.probe) return undefined
  const base = trimSlash(target.baseURL || preset.baseURL)
  const url = preset.probe === 'models' ? base + '/models' : preset.probe
  const body = await fetchJson(url, {
    headers: { authorization: 'Bearer ' + target.token },
    signal: io.signal,
    timeoutMs: io.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  return { url, count: list.length }
}

/**
 * The window a compact strip should print. A 5-hour limit is what blocks the
 * next request, so it wins over a fuller week or month. Without one, the
 * fullest window is still the number worth showing.
 */
export function headlineOf(windows) {
  const list = Array.isArray(windows) ? windows : []
  const fiveHour = list.find((window) => window?.key === 'five-hour' && typeof window.used === 'number')
  return fiveHour ?? worstOf(list)
}

/** 5-hour first, then the remaining windows from fullest to emptiest. */
export function orderWindows(windows) {
  return (Array.isArray(windows) ? windows : []).slice().sort((a, b) => {
    const rank = (window) => (window?.key === 'five-hour' ? 0 : 1)
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return (b?.used ?? 0) - (a?.used ?? 0)
  })
}

/** The worst window of a card: what raises an alert, not what the strip prints. */
export function worstOf(windows) {
  let worst
  for (const window of windows ?? []) {
    if (typeof window?.used !== 'number') continue
    if (worst === undefined || window.used > worst.used) worst = window
  }
  return worst
}
