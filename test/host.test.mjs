// The Host half, driven end to end without DSH: `apply()` on a stand-in
// context registers the real routes, and every request below goes through
// them, with fetch and the credential store faked at their seams. This is the
// test that says the page will have data — the readers are covered separately.
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { apply, ROUTES } from '../build/index.js'

// The usage counters live in the DSH home; this run gets a directory of its own.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-home-'))
process.env.DSH_HOME = testHome

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failures += 1
}

const ORIGIN = 'http://127.0.0.1:62756'
const HOST = '127.0.0.1:62756'
const jwt = (claims) => ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

// —— 厂商与 auth.x.ai 的替身 ——
const calls = []
let deviceApproved = true

function response(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) }
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const body = typeof init.body === 'string' ? init.body : ''
  calls.push({ host: url.host, path: url.pathname, method: init.method ?? 'GET', body })

  switch (`${url.host}${url.pathname}`) {
    case 'opencode.ai/zen/go/v1/usage':
      return response({ usage: {
        rolling: { status: 'ok', percent: 2, resetsAt: '2026-10-20T06:45:48.000Z' },
        weekly: { status: 'ok', percent: 19, resetsAt: '2026-10-26T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 33, resetsAt: '2026-11-11T01:02:09.000Z' },
      } })
    case 'cli-chat-proxy.grok.com/v1/billing':
      return response({ config: {
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-20T06:32:13.017+00:00' },
        creditUsagePercent: 100,
        productUsage: [{ product: 'GrokBuild', usagePercent: 92 }, { product: 'Cursor', usagePercent: 5 }],
      } })
    case 'api.commandcode.ai/alpha/billing/credits':
      return response({
        credits: { monthlyCredits: 5.2207933742, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: true, fiveHour: { used: 7, cap: 14, resetAt: 0 }, weekly: { used: 8.75, cap: 35, resetAt: 1792853160767 } },
      })
    case 'api.commandcode.ai/alpha/billing/subscriptions':
      return response({ success: true, data: {
        planId: 'individual-goat', status: 'active',
        currentPeriodEnd: '2026-10-22T11:40:10.000Z', cancelAtPeriodEnd: true,
      } })
    case 'api.deepseek.com/user/balance':
      return response({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        ],
      })
    case 'auth.x.ai/oauth2/device/code':
      return response({
        device_code: 'device-1', user_code: 'ABCD-1234',
        verification_uri: 'https://x.ai/device', verification_uri_complete: 'https://x.ai/device?code=ABCD-1234',
        interval: 1, expires_in: 60,
      })
    case 'auth.x.ai/oauth2/token': {
      const grantType = new URLSearchParams(body).get('grant_type')
      if (grantType === 'refresh_token') {
        return response({ access_token: jwt({ email: 'refreshed@example.com' }), expires_in: 3600 })
      }
      if (!deviceApproved) return response({ error: 'authorization_pending' }, 400)
      return response({ access_token: jwt({ email: 'signed-in@example.com' }), refresh_token: 'refresh-1', expires_in: 3600 })
    }
    default:
      return response({ error: `unexpected ${url.host}${url.pathname}` }, 400)
  }
}

// —— 凭据缝的替身 ——
const refs = new Map()
const records = new Map()
const credentials = {
  async describe(ref) {
    return refs.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }
  },
  async resolve(ref) {
    return refs.has(ref) ? { value: refs.get(ref), source: 'file' } : undefined
  },
  async set(ref, value) { refs.set(ref, value) },
  async unset(ref) { refs.delete(ref) },
  async readRecord(key) { return records.get(key) },
  async deleteRecord(key) { records.delete(key) },
  async modifyRecord(key, mutate) {
    const next = await mutate(records.get(key))
    if (next !== undefined) records.set(key, next)
    return next
  },
}

// —— 假 ctx 与 HTTP 搬运 ——
const routes = new Map()
const listeners = new Map()
// The profile's own patch layer, as the config editor sees it.
const configRows = [
  { options: { id: 'dsh-quota', name: '@local/dsh-quota', config: {} } },
  { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } } } },
]
const configEditor = {
  entries: () => configRows,
  async edit(entry, change) {
    const next = change(structuredClone(entry.options.config ?? {}), {})
    entry.options.config = next
    return next
  },
}
const ctx = {
  logger: { debug() {}, info() {}, warn() {} },
  get: (name) => (name === 'credentials' ? credentials : name === 'configEditor' ? configEditor : undefined),
  effect(fn) {
    const disposer = fn()
    return disposer
  },
  on(event, listener) {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

apply(ctx, {})

function makeRes() {
  const res = { headersSent: false, status: 0, body: '', done: undefined, _resolve: undefined }
  res.done = new Promise((resolve) => { res._resolve = resolve })
  res.writeHead = (status) => { res.headersSent = true; res.status = status }
  res.end = (payload) => {
    if (typeof payload === 'string') res.body += payload
    res._resolve()
  }
  return res
}

async function call(route, { method = 'GET', body, origin = ORIGIN, host = HOST, url } = {}) {
  const handler = routes.get(route)
  if (!handler) throw new Error(`no route ${route}`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url ?? route
  req.headers = { host }
  if (origin) req.headers.origin = origin
  const res = makeRes()
  await handler(req, res)
  await Promise.race([
    res.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no response from ${route}`)), 5000)),
  ])
  let json
  try { json = res.body === '' ? undefined : JSON.parse(res.body) } catch { json = res.body }
  return { status: res.status, json }
}

const providers = (state) => Object.fromEntries((state.providers ?? []).map((card) => [card.id, card]))
const waitFor = async (predicate, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

// —— 全凭据：三张卡都有真数字 ——
refs.set('OPENCODE_GO_API_KEY', 'oc-key')
refs.set('COMMANDCODE_API_KEY', 'cc-key')
records.set('llm-pi-ai/xai', { kind: 'grant', payload: { type: 'oauth', access: jwt({ email: 'grok@example.com' }), refresh: 'r-1', expires: Date.now() + 3600_000 } })

let state = await call(ROUTES.state)
check('GET /quota/state 回 200', state.status === 200)
check('五张卡都在，顺序是配置顺序', (state.json.providers ?? []).map((c) => c.id).join() === 'opencode-go,grok,commandcode,deepseek,bailian')
let cards = providers(state.json)
check('OpenCode 卡：三个窗口 + 最坏值', cards['opencode-go'].windows.length === 3 && cards['opencode-go'].worst.used === 33)
check('Grok 卡：周窗口 + 分项 + 已登录账号', cards.grok.windows[0].key === 'weekly' && cards.grok.parts.length === 2 && cards.grok.credential.account === 'grok@example.com')
check('Command Code 卡：套餐 GOAT + 三个窗口（含当月 credits）',
  cards.commandcode.plan === 'GOAT' && cards.commandcode.windows.map((w) => w.key).sort().join() === 'credits,five-hour,weekly')
check('Command Code 卡：5 小时窗口 7/14 = 50%', cards.commandcode.windows.find((w) => w.key === 'five-hour').used === 50)
check('窗口按最紧的排在最前', cards.commandcode.windows[0].key === 'credits' &&
  cards.commandcode.windows.map((w) => w.used).every((used, index, all) => index === 0 || all[index - 1] >= used),
  JSON.stringify(cards.commandcode.windows))
check('Command Code 卡：到期与续费来自订阅', cards.commandcode.until === '2026-10-22T11:40:10.000Z' && cards.commandcode.renew === 'off')
check('卡里带了取 key 的地址', typeof cards['opencode-go'].keysUrl === 'string' && cards['opencode-go'].keysUrl.startsWith('https://'))
check('凭据来源如实报告', cards['opencode-go'].credential.source === 'file' && cards.grok.credential.source === 'record')
check('快照带 fetchedAt 与 refreshMs', typeof state.json.fetchedAt === 'string' && state.json.refreshMs === 60000)

// —— DeepSeek 官方 API：没 key 说缺，有 key 给余额 ——
check('DeepSeek 卡默认也在，没 key 时标缺凭据', cards.deepseek.missing === true && /DEEPSEEK_API_KEY/.test(cards.deepseek.error),
  JSON.stringify(cards.deepseek))
refs.set('DEEPSEEK_API_KEY', 'ds-key')
state = await call(ROUTES.refresh, { method: 'POST' })
cards = providers(state.json)
check('DeepSeek 余额来自 /user/balance', cards.deepseek.balance === '¥110.00', JSON.stringify(cards.deepseek))
check('余额没有窗口（金额不是百分比）', cards.deepseek.windows.length === 0 && cards.deepseek.worst === null)
check('余额拆出充值与赠金', /topped up ¥100\.00/.test(cards.deepseek.note) && /granted ¥10\.00/.test(cards.deepseek.note), cards.deepseek.note)
refs.delete('DEEPSEEK_API_KEY')

// —— 阿里云百炼：没有额度接口，这张卡只存 key ——
check('百炼卡默认也在，没 key 时标缺凭据', cards.bailian.missing === true && /DASHSCOPE_API_KEY/.test(cards.bailian.error),
  JSON.stringify(cards.bailian))
refs.set('DASHSCOPE_API_KEY', 'ds-bailian-key')
state = await call(ROUTES.refresh, { method: 'POST' })
cards = providers(state.json)
check('百炼卡：有 key 也不编窗口', cards.bailian.quota === false && cards.bailian.windows.length === 0 && !cards.bailian.error,
  JSON.stringify(cards.bailian))
check('百炼卡：凭据来源如实报告', cards.bailian.credential.source === 'file' && cards.bailian.credential.hint === 'DASHSCOPE_API_KEY')
refs.delete('DASHSCOPE_API_KEY')

// —— 缺凭据：只有那张卡报缺，别的照旧 ——
refs.delete('OPENCODE_GO_API_KEY')
state = await call(ROUTES.refresh, { method: 'POST' })
cards = providers(state.json)
check('缺 key 的卡标了 missing', cards['opencode-go'].missing === true)
check('缺 key 的卡说清了缺哪一条', /OPENCODE_GO_API_KEY/.test(cards['opencode-go'].error), cards['opencode-go'].error)
check('别的卡不受缺凭据影响', cards.grok.windows.length === 1 && cards.commandcode.windows.length === 3)

// —— 设 key / 清 key ——
let posted = await call(ROUTES.key, { method: 'POST', body: { id: 'opencode-go', key: '  fresh-key  ' } })
check('POST /quota/key 回 200', posted.status === 200)
check('key 被裁掉空白后存进凭据库', refs.get('OPENCODE_GO_API_KEY') === 'fresh-key')
state = await call(ROUTES.refresh, { method: 'POST' })
check('存完 key 后那张卡有数字了', providers(state.json)['opencode-go'].windows.length === 3)

posted = await call(ROUTES.clear, { method: 'POST', body: { id: 'opencode-go' } })
check('POST /quota/clear 删掉 key', posted.status === 200 && !refs.has('OPENCODE_GO_API_KEY'))
check('空 key 被拒绝', (await call(ROUTES.key, { method: 'POST', body: { id: 'opencode-go', key: '   ' } })).status === 400)
check('未知 provider 回 404', (await call(ROUTES.key, { method: 'POST', body: { id: 'nope', key: 'k' } })).status === 404)

// —— 同源与方式 ——
check('没有 Origin 的 POST 直接放过（桌面渲染进程就不带 Origin）', (await call(ROUTES.key, { method: 'POST', body: { id: 'opencode-go', key: 'k' }, origin: '' })).status === 200)
check('别的 Origin 的 POST 被拒', (await call(ROUTES.key, { method: 'POST', body: { id: 'opencode-go', key: 'k' }, origin: 'http://evil.example' })).status === 403)
check('GET /quota/key 回 405', (await call(ROUTES.key)).status === 405)
check('POST /quota/state 回 405', (await call(ROUTES.state, { method: 'POST' })).status === 405)

// —— Grok 过期后自动续期并回写 ——
records.set('llm-pi-ai/xai', { kind: 'grant', payload: { type: 'oauth', access: jwt({ email: 'old@example.com' }), refresh: 'r-2', expires: Date.now() + 30_000 } })
state = await call(ROUTES.refresh, { method: 'POST' })
cards = providers(state.json)
check('快过期的 token 被续期后仍能读额度', cards.grok.windows.length === 1 && !cards.grok.missing)
check('续期后的账号来自新 token', cards.grok.credential.account === 'refreshed@example.com')
check('续期结果写回了凭据记录', records.get('llm-pi-ai/xai').payload.access.startsWith('header.') && records.get('llm-pi-ai/xai').payload.refresh === 'r-2')

// —— 登录：设备码 + 轮询 + 写入记录 ——
records.delete('llm-pi-ai/xai')
deviceApproved = true
const started = await call(ROUTES.loginStart, { method: 'POST', body: { id: 'grok' } })
check('POST /quota/login/start 回 200 并给出 user code', started.status === 200 && started.json.userCode === 'ABCD-1234', JSON.stringify(started.json))
check('登录一开始就给出带 code 的授权页', /code=ABCD-1234/.test(started.json.verificationUriComplete || ''))
check('start 之后状态是 pending', (await call(ROUTES.loginStatus, { url: `${ROUTES.loginStatus}?id=grok` })).json.status === 'pending')
check('后台轮询把授权写成了凭据记录', await waitFor(() => records.has('llm-pi-ai/xai')))
const settled = await call(ROUTES.loginStatus, { url: `${ROUTES.loginStatus}?id=grok` })
check('登录成功后状态是 success', settled.json.status === 'success', JSON.stringify(settled.json))
check('登录记录带上了账号', settled.json.account === 'signed-in@example.com')
check('登录写的就是 dsh-llm-pi-ai 读的那条记录', records.get('llm-pi-ai/xai').kind === 'grant' && records.get('llm-pi-ai/xai').payload.type === 'oauth')
state = await call(ROUTES.refresh, { method: 'POST' })
check('登录后 Grok 卡直接可用', providers(state.json).grok.windows.length === 1)

// 退出登录删掉记录
check('POST /quota/clear 对 oauth 删的是记录', (await call(ROUTES.clear, { method: 'POST', body: { id: 'grok' } })).status === 200 && !records.has('llm-pi-ai/xai'))

// 取消一次登录
deviceApproved = false
const second = await call(ROUTES.loginStart, { method: 'POST', body: { id: 'grok' } })
check('再登一次又是 pending', second.status === 200 && second.json.status === 'pending')
check('取消登录回 ok', (await call(ROUTES.loginCancel, { method: 'POST', body: { id: 'grok' } })).json.ok === true)
check('取消后状态不再是 pending', (await call(ROUTES.loginStatus, { url: `${ROUTES.loginStatus}?id=grok` })).json.status !== 'pending')

// —— 没有凭据服务：说清楚，而不是崩 ——
const bareRoutes = new Map()
apply({
  logger: ctx.logger,
  get: () => undefined,
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { bareRoutes.set(route.path, route.handler); return () => {} } },
}, {})
const bareState = await (async () => {
  const req = Readable.from([])
  req.method = 'GET'
  req.url = ROUTES.state
  req.headers = { host: HOST }
  const res = makeRes()
  await bareRoutes.get(ROUTES.state)(req, res)
  await res.done
  return JSON.parse(res.body)
})()
check('没有凭据服务时 key/oauth 的卡都说缺凭据',
  bareState.providers.filter((card) => card.id !== 'commandcode').every((card) => card.missing === true),
  JSON.stringify(bareState.providers.map((card) => [card.id, card.missing, card.credential?.source])))
check('没有凭据服务时 Command Code 仍可走 CLI 登录',
  bareState.providers.find((card) => card.id === 'commandcode').credential.source === 'cli' ||
  bareState.providers.find((card) => card.id === 'commandcode').missing === true)

// Command Code CLI 的登录：真有一份就读，没有就跳过
const cliAuth = path.join(os.homedir(), '.commandcode', 'auth.json')
if (fs.existsSync(cliAuth)) {
  refs.delete('COMMANDCODE_API_KEY')
  state = await call(ROUTES.refresh, { method: 'POST' })
  const card = providers(state.json).commandcode
  check('没存 key 时用 Command Code CLI 的登录', card.credential.source === 'cli' && card.credential.configured === true, JSON.stringify(card.credential))
  check('CLI 登录给出的账号名', typeof card.credential.account === 'string' && card.credential.account !== '')
} else {
  console.log('SKIP  Command Code CLI 登录：这台机器没有 ~/.commandcode/auth.json')
}

// —— 添加 / 移除供应商：写进 profile 自己的 patch 层 ——
const added = await call(ROUTES.providers, { method: 'POST', body: { id: 'my-oc', preset: 'opencode-go', baseURL: 'https://gateway.example/zen/go', label: 'My OC' } })
check('POST /quota/providers 回 200', added.status === 200, JSON.stringify(added.json))
let savedRows = configRows[0].options.config.providers
check('新 provider 落在配置里', savedRows.length === 6 && savedRows[5].id === 'my-oc')
check('只写了给出的字段', savedRows[5].baseURL === 'https://gateway.example/zen/go' && savedRows[5].label === 'My OC' && savedRows[5].preset === 'opencode-go')
check('第一次添加会把四个默认目标显式写下来', savedRows.slice(0, 5).map((row) => row.id).join() === 'opencode-go,grok,commandcode,deepseek,bailian')
check('重复 id 回 409', (await call(ROUTES.providers, { method: 'POST', body: { id: 'opencode-go', preset: 'opencode-go' } })).status === 409)
check('未知 preset 回 400', (await call(ROUTES.providers, { method: 'POST', body: { id: 'weird', preset: 'nope' } })).status === 400)
check('非法 id 回 400', (await call(ROUTES.providers, { method: 'POST', body: { id: 'bad id!', preset: 'opencode-go' } })).status === 400)
const removed = await (async () => {
  // A real Host reloads the plugin with the edited config; the fake does the same,
  // so the remove below sees the list the add just wrote.
  routes.clear()
  apply(ctx, configRows[0].options.config)
  return call(ROUTES.providersRemove, { method: 'POST', body: { id: 'my-oc' } })
})()
check('POST /quota/providers/remove 回 200', removed.status === 200, JSON.stringify(removed.json))
savedRows = configRows[0].options.config.providers
check('移除后配置里没有它了', savedRows.length === 5 && !savedRows.some((row) => row.id === 'my-oc'))
check('移除不存在的 provider 回 404', (await call(ROUTES.providersRemove, { method: 'POST', body: { id: 'nope' } })).status === 404)
check('移除写回时保留了其它字段', configRows[0].options.config.providers.every((row) => typeof row.preset === 'string'))

// —— 加一个 pi-ai 目录里没有的供应商：同时注册模型路由 ——
const addedBailian = await call(ROUTES.providers, { method: 'POST', body: { id: 'ali-test', preset: 'bailian', label: '阿里云测试' } })
check('加百炼回 200 并带回写入的路由',
  addedBailian.status === 200 && addedBailian.json.route?.api === 'openai-completions',
  JSON.stringify(addedBailian.json).slice(0, 200))
let piAiRoutes = configRows[1].options.config.providers
check('模型路由写进了 llm-pi-ai.providers', Boolean(piAiRoutes['ali-test']) && piAiRoutes['ali-test'].apiKeyEnv === 'DASHSCOPE_API_KEY')
check('路由带 baseURL 与两个模型', piAiRoutes['ali-test'].baseURL.includes('dashscope') && piAiRoutes['ali-test'].models.length === 2)
check('路由带显示名', piAiRoutes['ali-test'].displayName === '阿里云测试')
check('原有路由没被弄丢', Boolean(piAiRoutes['opencode-go']))
check('凭据引用填成 key 会被拒（400）',
  (await call(ROUTES.providers, { method: 'POST', body: { id: 'bad-ref', preset: 'bailian', apiKeyEnv: 'sk-ws-abc.def.ghi' } })).status === 400)

// 配置里本来就把 key 填进 apiKeyEnv：读的时候要丢掉，不能把它当引用泄露出去
const leakRoutes = new Map()
apply({
  logger: ctx.logger,
  get: (name) => (name === 'credentials' ? credentials : name === 'configEditor' ? configEditor : undefined),
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { leakRoutes.set(route.path, route.handler); return () => {} } },
}, { providers: [{ id: 'leaky', preset: 'bailian', apiKeyEnv: 'sk-ws-should-not-leak' }] })
const leakState = await (async () => {
  const req = Readable.from([])
  req.method = 'GET'
  req.url = ROUTES.state
  req.headers = { host: HOST }
  const res = makeRes()
  await leakRoutes.get(ROUTES.state)(req, res)
  await res.done
  return JSON.parse(res.body)
})()
check('key 形状的 apiKeyEnv 被丢掉，退回预设引用',
  leakState.providers[0].credential.hint === 'DASHSCOPE_API_KEY' && !JSON.stringify(leakState).includes('should-not-leak'),
  leakState.providers[0].credential.hint)

// —— 用量：包住 llm/stream，只记成功的调用 ——
const watchStream = listeners.get('llm/stream')
check('注册了 llm/stream 的监听', typeof watchStream === 'function')
const upstream = async function* () {
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5 } }
  yield { type: 'finish', kind: 'stop' }
}
const seen = []
for await (const chunk of watchStream({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, () => upstream())) seen.push(chunk)
check('包装后的流原样吐出每个 chunk', seen.length === 2 && seen[1].type === 'finish')

let usageView = (await call(ROUTES.state)).json.usage
check('一次成功调用计入用量', usageView.window.calls === 1 && usageView.window.input === 100 && usageView.window.output === 20, JSON.stringify(usageView.window))
check('缓存与推理分开记', usageView.window.cacheRead === 30 && usageView.window.reasoning === 5)
check('按 provider/model 分行', usageView.models.length === 1 && usageView.models[0].provider === 'opencode-go' && usageView.models[0].model === 'deepseek-v4.1-flash')
check('七天条带给出七个槽', usageView.days.length === 7 && usageView.days.at(-1).calls === 1)

const failedUpstream = async function* () {
  yield { type: 'usage', usage: { inputTokens: 50 } }
  yield { type: 'finish', kind: 'error', failure: { code: 'AUTH' } }
}
for await (const _chunk of watchStream({ provider: 'grok', model: 'grok-4.6' }, () => failedUpstream())) { /* drain */ }
usageView = (await call(ROUTES.state)).json.usage
check('失败的调用不计入', usageView.window.calls === 1, JSON.stringify(usageView.window))
check('用量文件写在 DSH home 下', typeof usageView === 'object' && (await call(ROUTES.state)).json.usageFile.startsWith(testHome))

// —— 同源判定：本机页面放过，别的站拒掉，并说清原因 ——
const evil = await call(ROUTES.key, { method: 'POST', body: { id: 'opencode-go', key: 'k' }, origin: 'http://evil.example' })
check('跨站 POST 回 403 且带回诊断', evil.status === 403 && evil.json.origin === 'http://evil.example' && evil.json.host === HOST, JSON.stringify(evil.json))
const anotherLocal = await call(ROUTES.key, { method: 'POST', body: { id: 'opencode-go', key: 'from-local-page' }, origin: 'http://localhost:5173' })
check('本机另一个端口的页面仍算本机', anotherLocal.status === 200 && refs.get('OPENCODE_GO_API_KEY') === 'from-local-page')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
