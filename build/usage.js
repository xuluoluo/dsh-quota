/**
 * Token usage, folded out of the LLM stream waterfall and kept per local day.
 *
 * DSH already meters every model call: the `llm/stream` waterfall hands each
 * adapter request through with `{ provider, model, sessionId, purpose }` and
 * its chunk stream ends with one `usage` chunk —
 * `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }`.
 * Wrapping that stream is the only place a plugin can see every call, whoever
 * made it (a conversation step, a compaction, a generated session title), so
 * that is where this module is fed from.
 *
 * The aggregate is one small JSON document in the DSH home, pruned to the last
 * 30 days: a day's totals plus the same numbers per `provider/model`. Nothing
 * here imports a DSH package, and the clock and the file are parameters, so the
 * folding runs in a test.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const VERSION = 1
/** Days kept on disk; the page asks for 7. */
export const KEEP_DAYS = 30
/** Usage arrives in bursts (one call ends at a time); one write per burst. */
const FLUSH_MS = 2000

/** The counters one call, one day, or one model line carries. */
export function emptyCounters() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

const COUNTER_KEYS = Object.keys(emptyCounters())

/** One provider usage value as counters to add: absent fields count as zero. */
export function countersOf(usage) {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
  return {
    calls: 1,
    input: number(usage?.inputTokens),
    output: number(usage?.outputTokens),
    cacheRead: number(usage?.cacheReadTokens),
    cacheWrite: number(usage?.cacheWriteTokens),
    reasoning: number(usage?.reasoningTokens),
  }
}

/** `into` plus `add`, returned as a new object. */
export function addCounters(into, add) {
  const out = { ...into }
  for (const key of COUNTER_KEYS) out[key] = (out[key] ?? 0) + (add[key] ?? 0)
  return out
}

/** The local calendar day a time belongs to, as `YYYY-MM-DD`. */
export function dayKey(time) {
  const date = new Date(time)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The last `count` day keys ending at `time`, oldest first. */
export function recentDays(time, count) {
  const out = []
  const date = new Date(time)
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() - i)
    out.push(dayKey(day.getTime()))
  }
  return out
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A stored document's counters, or zeros when it holds none. */
function readCounters(value) {
  const out = emptyCounters()
  if (!isObject(value)) return out
  for (const key of COUNTER_KEYS) {
    const number = value[key]
    if (typeof number === 'number' && Number.isFinite(number) && number > 0) out[key] = Math.round(number)
  }
  return out
}

/** The empty document. */
export function emptyUsage() {
  return { version: VERSION, days: {} }
}

/** Parse a stored document; anything unreadable becomes the empty one. */
export function parseUsage(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyUsage()
  }
  if (!isObject(parsed) || parsed.version !== VERSION || !isObject(parsed.days)) return emptyUsage()
  const days = {}
  for (const [date, value] of Object.entries(parsed.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isObject(value)) continue
    const models = {}
    if (isObject(value.models)) {
      for (const [name, counters] of Object.entries(value.models)) {
        if (typeof name === 'string' && name !== '') models[name] = readCounters(counters)
      }
    }
    days[date] = { totals: readCounters(value.totals), models }
  }
  return { version: VERSION, days }
}

/**
 * One call folded in: the day's totals, and the line of the `provider/model`
 * that made it. `data` is mutated and returned so a caller can fold a burst.
 */
export function foldCall(data, { provider, model, usage, at }) {
  const date = dayKey(at)
  const day = data.days[date] ?? { totals: emptyCounters(), models: {} }
  const name = `${provider}/${model}`
  const counters = countersOf(usage)
  day.totals = addCounters(day.totals, counters)
  day.models[name] = addCounters(day.models[name] ?? emptyCounters(), counters)
  data.days[date] = day
  return data
}

/** Drop days older than the kept window (and any unparsable keys). */
export function pruneUsage(data, now, keep = KEEP_DAYS) {
  const keepSet = new Set(recentDays(now, keep))
  for (const date of Object.keys(data.days)) {
    if (!keepSet.has(date)) delete data.days[date]
  }
  return data
}

/**
 * What one line of counters would cost at a catalog price (USD per million
 * tokens). A price that names no cache rate falls back to the input rate for
 * cache reads and to zero for cache writes, which is how the catalogs that
 * omit them read.
 */
export function costOfCounters(counters, price) {
  if (!price || typeof price.input !== 'number' || typeof price.output !== 'number') return undefined
  const per = 1_000_000
  const total =
    (counters.input / per) * price.input +
    (counters.output / per) * price.output +
    (counters.cacheRead / per) * (typeof price.cacheRead === 'number' ? price.cacheRead : price.input) +
    (counters.cacheWrite / per) * (typeof price.cacheWrite === 'number' ? price.cacheWrite : 0)
  return Math.round(total * 1e6) / 1e6
}

/** The cost of every model line in one day's map, with its own resolver. */
function costOfDay(dayModels, priceOf) {
  let total = 0
  let priced = false
  for (const [name, counters] of Object.entries(dayModels ?? {})) {
    const slash = name.indexOf('/')
    const value = costOfCounters(counters, priceOf?.(slash > 0 ? name.slice(0, slash) : '', slash > 0 ? name.slice(slash + 1) : name))
    if (value === undefined) continue
    priced = true
    total += value
  }
  return priced ? Math.round(total * 1e6) / 1e6 : undefined
}

/**
 * What the page shows: today, the last seven days, a per-day strip, and the
 * model lines of those seven days, heaviest first. `now` decides the day, and
 * `priceOf` (optional) turns counters into money per line and per window.
 */
export function summariseUsage(data, now, days = 7, priceOf) {
  const keys = recentDays(now, days)
  const todayKey = keys[keys.length - 1]
  const today = data.days[todayKey]?.totals ?? emptyCounters()
  const window = emptyCounters()
  const strip = []
  const models = new Map()
  for (const date of keys) {
    const day = data.days[date]
    const totals = day?.totals ?? emptyCounters()
    strip.push({ date, ...totals })
    for (const key of COUNTER_KEYS) window[key] += totals[key]
    for (const [name, counters] of Object.entries(day?.models ?? {})) {
      const slash = name.indexOf('/')
      const provider = slash > 0 ? name.slice(0, slash) : ''
      const model = slash > 0 ? name.slice(slash + 1) : name
      const line = models.get(name) ?? { provider, model, ...emptyCounters() }
      models.set(name, { ...line, ...addCounters(line, counters) })
    }
  }
  const lines = [...models.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
  let cost = 0
  let priced = false
  for (const line of lines) {
    const value = costOfCounters(line, priceOf?.(line.provider, line.model))
    if (value === undefined) continue
    priced = true
    line.cost = value
    cost += value
  }
  const todayCost = costOfDay(data.days[todayKey]?.models, priceOf)
  return {
    today,
    window,
    days: strip,
    models: lines,
    ...(priced ? { cost: Math.round(cost * 1e6) / 1e6 } : {}),
    ...(todayCost === undefined ? {} : { todayCost }),
  }
}

/**
 * The store: load once, fold every call, flush the document on a short debounce
 * so a burst of calls is one write, and flush at unload.
 */
export function createUsageStore({ file = usageFile(), now = Date.now, priceOf } = {}) {
  let data = emptyUsage()
  let loaded = false
  let loading
  let timer
  let queue = Promise.resolve()

  /**
   * The one read of the document. Every caller awaits this same promise, so a
   * call folded in while the file is still being read can never be overwritten
   * by the read landing afterwards.
   */
  function loadOnce() {
    if (loaded) return Promise.resolve()
    if (loading === undefined) {
      loading = readFile(file, 'utf8')
        .then((text) => {
          data = pruneUsage(parseUsage(text), now())
        })
        .catch(() => {
          data = emptyUsage()
        })
        .finally(() => {
          loaded = true
        })
    }
    return loading
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, FLUSH_MS)
    timer.unref?.()
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const body = `${JSON.stringify(pruneUsage(data, now()))}\n`
    try {
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.tmp-${process.pid}`
      await writeFile(temporary, body, { mode: 0o600 })
      await rename(temporary, file)
    } catch {
      // A usage counter is not worth failing a model call over.
    }
  }

  return {
    async ready() {
      await loadOnce()
      return data
    },
    record(call) {
      queue = queue
        .then(async () => {
          await loadOnce()
          if (!isObject(call) || typeof call.provider !== 'string' || typeof call.model !== 'string') return
          if (!call.usage) return
          foldCall(data, { ...call, at: call.at ?? now() })
          schedule()
        })
        .catch(() => {})
    },
    async summary(days = 7) {
      await loadOnce()
      await queue
      return summariseUsage(pruneUsage(data, now()), now(), days, priceOf)
    },
    flush,
  }
}

/** Where the counters live: the DSH home, beside the credentials document. */
export function usageFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, '.quota-usage.json')
}
