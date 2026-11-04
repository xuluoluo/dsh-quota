// The Host half, driven end to end without DSH: `apply()` on a stand-in
// context registers the real routes, and every request below goes through
// them, with fetch and the credential store faked at their seams. This is the
// test that says the page will have data — the readers are covered separately.
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { apply, ROUTES } from '../build/index.js'

// The usage counters live in the DSH home; this run gets a directory of its own.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-home-'))
process.env.DSH_HOME = testHome
// All CLI credential lookups stay within synthetic directories, including on Windows.
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.CODEX_HOME = path.join(testHome, 'empty-codex')
process.env.CLAUDE_CONFIG_DIR = path.join(testHome, 'empty-claude')

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
    case 'chatgpt.com/backend-api/wham/usage':
      return response({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } })
    case 'api.anthropic.com/api/oauth/usage':
      return response({ five_hour: { utilization: 23 } })
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
  { options: { id: 'dsh-quota', name: 'dsh-allowance', config: {} } },
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

// 配置只认写下来的：插件不再自己初始化五家供应商（2026-10-22 改）。
const CONFIGURED = {
  providers: [
    { id: 'opencode-go', preset: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    { id: 'grok', preset: 'xai-billing', record: 'llm-pi-ai/xai' },
    { id: 'commandcode', preset: 'commandcode', apiKeyEnv: 'COMMANDCODE_API_KEY' },
    { id: 'deepseek', preset: 'deepseek-api', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    { id: 'bailian', preset: 'bailian', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  ],
}

apply(ctx, CONFIGURED)

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

async function callOn(map, route, { method = 'GET', body, origin = ORIGIN, host = HOST, url } = {}) {
  const handler = map.get(route)
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

const call = (route, options) => callOn(routes, route, options)

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
check('chip 默认关掉（窄条已经在显示同一份数字）', state.json.showChip === false)
const suggest = await call(ROUTES.suggest, { method: 'POST', body: { sessionId: 's1' } })
check('输入预测默认关着，问它也不去打扰模型', suggest.status === 200 && suggest.json.suggestion === null && suggest.json.reason === 'disabled', JSON.stringify(suggest.json))
check('预测设置跟着快照一起下发', state.json.predict && state.json.predict.enabled === false && typeof state.json.defaultPrompt === 'string' && state.json.defaultPrompt.length > 20)
check('五张卡都在，顺序是配置顺序', (state.json.providers ?? []).map((c) => c.id).join() === 'opencode-go,grok,commandcode,deepseek,bailian')
let cards = providers(state.json)
check('OpenCode 卡：三个窗口 + 最坏值', cards['opencode-go'].windows.length === 3 && cards['opencode-go'].worst.used === 33)
check('Grok 卡：周窗口 + 分项 + 已登录账号', cards.grok.windows[0].key === 'weekly' && cards.grok.parts.length === 2 && cards.grok.credential.account === 'grok@example.com')
check('Command Code 卡：套餐 GOAT + 三个窗口（含当月 credits）',
  cards.commandcode.plan === 'GOAT' && cards.commandcode.windows.map((w) => w.key).sort().join() === 'credits,five-hour,weekly')
check('Command Code 卡：5 小时窗口 7/14 = 50%', cards.commandcode.windows.find((w) => w.key === 'five-hour').used === 50)
check('5 小时窗口排在最前，其余按已用', cards.commandcode.windows[0].key === 'five-hour' &&
  cards.commandcode.windows.slice(1).map((w) => w.used).every((used, index, all) => index === 0 || all[index - 1] >= used),
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

// 自定义 Grok 记录必须贯穿读取、续期、登录与清除，默认记录不得被覆盖。
const customRoutes = new Map()
apply({
  logger: ctx.logger,
  get: (name) => name === 'credentials' ? credentials : undefined,
  effect: (fn) => fn(), on: () => () => {},
  webServer: { register: (route) => { customRoutes.set(route.path, route.handler); return () => {} } },
}, { providers: [{ id: 'custom-grok', preset: 'xai-billing', record: 'custom/grok' }] })
const customCall = (route, options) => callOn(customRoutes, route, options)
const defaultGrant = { kind: 'grant', payload: { type: 'oauth', access: 'default-sentinel', refresh: 'default-refresh', expires: Date.now() + 3600_000 } }
records.set('llm-pi-ai/xai', defaultGrant)
records.set('custom/grok', { kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'custom-refresh', expires: Date.now() + 30_000 } })
const customRefresh = await customCall(ROUTES.refresh, { method: 'POST' })
check('Grok 自定义记录续期写回原记录', customRefresh.json.providers[0].credential.account === 'refreshed@example.com' && records.get('custom/grok').payload.refresh === 'custom-refresh' && records.get('custom/grok').payload.access !== 'old')
check('Grok 自定义记录续期不覆盖默认记录', records.get('llm-pi-ai/xai') === defaultGrant)
records.delete('custom/grok')
deviceApproved = true
const customLogin = await customCall(ROUTES.loginStart, { method: 'POST', body: { id: 'custom-grok' } })
check('Grok 自定义记录登录启动', customLogin.status === 200)
check('Grok 登录写入自定义记录', await waitFor(() => records.has('custom/grok')) && records.get('custom/grok').payload.refresh === 'refresh-1')
check('Grok 自定义登录不覆盖默认记录', records.get('llm-pi-ai/xai') === defaultGrant)
check('Grok 自定义记录可清除', (await customCall(ROUTES.clear, { method: 'POST', body: { id: 'custom-grok' } })).status === 200 && !records.has('custom/grok') && records.get('llm-pi-ai/xai') === defaultGrant)
records.delete('llm-pi-ai/xai')

// CLI 文件均为临时目录中的合成数据；自定义目录优先，缺文件不回退。
const codexDir = path.join(testHome, 'custom-codex')
const claudeDir = path.join(testHome, 'custom-claude')
for (const dir of [codexDir, claudeDir, path.join(testHome, '.codex'), path.join(testHome, '.claude')]) fs.mkdirSync(dir, { recursive: true })
const codexFile = (dir, email) => fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt({ email }) } }))
const claudeFile = (dir, plan) => fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `fake-${plan}`, subscriptionType: plan, expiresAt: Date.now() + 3600_000 } }))
codexFile(codexDir, 'custom@example.com')
codexFile(path.join(testHome, '.codex'), 'default@example.com')
claudeFile(claudeDir, 'max')
claudeFile(path.join(testHome, '.claude'), 'pro')
process.env.CODEX_HOME = codexDir
process.env.CLAUDE_CONFIG_DIR = claudeDir
const cliRoutes = new Map()
apply({ logger: ctx.logger, get: () => undefined, effect: (fn) => fn(), on: () => () => {},
  webServer: { register: (route) => { cliRoutes.set(route.path, route.handler); return () => {} } },
}, { providers: [{ id: 'chatgpt', preset: 'chatgpt' }, { id: 'claude', preset: 'claude' }] })
let cliCards = providers((await callOn(cliRoutes, ROUTES.refresh, { method: 'POST' })).json)
check('CODEX_HOME 的登录用于额度查询', cliCards.chatgpt.credential.account === 'custom@example.com' && cliCards.chatgpt.windows?.length > 0, JSON.stringify(cliCards.chatgpt))
check('CLAUDE_CONFIG_DIR 的登录用于额度查询', cliCards.claude.credential.source === 'cli' && cliCards.claude.plan === 'Max' && cliCards.claude.windows?.length > 0, JSON.stringify(cliCards.claude))
process.env.CODEX_HOME = path.join(testHome, 'empty-codex')
process.env.CLAUDE_CONFIG_DIR = path.join(testHome, 'empty-claude')
cliCards = providers((await callOn(cliRoutes, ROUTES.refresh, { method: 'POST' })).json)
check('指定目录缺失时不读取默认登录', cliCards.chatgpt.missing === true && cliCards.claude.missing === true)
delete process.env.CODEX_HOME
delete process.env.CLAUDE_CONFIG_DIR
cliCards = providers((await callOn(cliRoutes, ROUTES.refresh, { method: 'POST' })).json)
check('未设置自定义目录时读取默认文件', cliCards.chatgpt.credential.account === 'default@example.com' && cliCards.claude.plan === 'Pro')

// —— 没有配置就没有卡：不替用户凭空初始化 ——
const emptyRoutes = new Map()
apply({
  logger: ctx.logger,
  get: (name) => (name === 'credentials' ? credentials : undefined),
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { emptyRoutes.set(route.path, route.handler); return () => {} } },
}, {})
const emptyState = await (async () => {
  const req = Readable.from([])
  req.method = 'GET'
  req.url = ROUTES.state
  req.headers = { host: HOST }
  const res = makeRes()
  await emptyRoutes.get(ROUTES.state)(req, res)
  await res.done
  return JSON.parse(res.body)
})()
check('没配置 providers 时一张卡也没有', emptyState.providers.length === 0, JSON.stringify(emptyState.providers))

// —— composer 左侧：会话所在的文件夹与 git 分支 ——
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-repo-'))
execFileSync('git', ['init', '-b', 'quota-test', repoDir])
execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-m', 'seed'])
const wsRoutes = new Map()
apply({
  logger: ctx.logger,
  get: (name) => (name === 'sessions'
    ? { get: (id) => (id === 's1' ? { header: { cwd: repoDir } } : undefined) }
    : name === 'credentials' ? credentials : undefined),
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { wsRoutes.set(route.path, route.handler); return () => {} } },
}, {})
const ws = await callOn(wsRoutes, ROUTES.workspace, { url: `${ROUTES.workspace}?sessionId=s1` })
check('GET /quota/workspace 回 200', ws.status === 200, JSON.stringify(ws.json))
check('给出会话的文件夹与名字',
  ws.json.root === repoDir && ws.json.name === path.basename(repoDir),
  JSON.stringify(ws.json))
check('给出 git 分支与仓库根', ws.json.branch === 'quota-test' && ws.json.gitRoot.replace(/\\/g, '/').toLowerCase() === repoDir.replace(/\\/g, '/').toLowerCase(),
  JSON.stringify(ws.json))
const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-plain-'))
const plainRoutes = new Map()
apply({
  logger: ctx.logger,
  get: (name) => (name === 'sessions'
    ? { get: () => ({ header: { cwd: nonRepo } }) }
    : name === 'credentials' ? credentials : undefined),
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { plainRoutes.set(route.path, route.handler); return () => {} } },
}, {})
const plain = await callOn(plainRoutes, ROUTES.workspace, { url: `${ROUTES.workspace}?sessionId=s2` })
check('不是 git 仓库时只给文件夹', plain.status === 200 && plain.json.branch === null && plain.json.root === nonRepo, JSON.stringify(plain.json))
check('不知道的会话回 404',
  (await callOn(wsRoutes, ROUTES.workspace, { url: `${ROUTES.workspace}?sessionId=nope` })).status === 404)
check('缺 sessionId 回 400', (await callOn(wsRoutes, ROUTES.workspace, { url: ROUTES.workspace })).status === 400)

// —— 卡头：模型路由挂没挂上 ——
const mountRows = [
  {
    options: {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          ali: { api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/', models: [] },
        },
      },
    },
  },
  {
    options: {
      id: 'dsh-quota',
      name: 'dsh-allowance',
      config: { providers: [{ id: 'bailian', preset: 'bailian', apiKeyEnv: 'DASHSCOPE_API_KEY' }] },
    },
  },
]
const mountRoutes = new Map()
apply({
  logger: ctx.logger,
  get: (name) => {
    if (name === 'llm') return { listProviders: async () => [{ id: 'ali' }] }
    if (name === 'configEditor') return { entries: () => mountRows, edit: async () => undefined }
    if (name === 'credentials') return credentials
    return undefined
  },
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { mountRoutes.set(route.path, route.handler); return () => {} } },
}, mountRows[1].options.config)
const mountedState = await callOn(mountRoutes, ROUTES.state)
check('预设名字变了也认得同一个网关（ali 就是百炼）',
  mountedState.json.providers[0].inModels === true && mountedState.json.providers[0].modelProvider === 'ali',
  JSON.stringify(mountedState.json.providers[0]))

const orphanRows = [{ options: { id: 'dsh-quota', name: 'dsh-allowance', config: { providers: [{ id: 'bailian', preset: 'bailian' }] } } }]
const orphanRoutes = new Map()
apply({
  logger: ctx.logger,
  get: (name) => {
    if (name === 'llm') return { listProviders: async () => [] }
    if (name === 'configEditor') return { entries: () => orphanRows, edit: async () => undefined }
    if (name === 'credentials') return credentials
    return undefined
  },
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { orphanRoutes.set(route.path, route.handler); return () => {} } },
}, orphanRows[0].options.config)
const orphanState = await callOn(orphanRoutes, ROUTES.state)
check('没有路由的卡会自己说「未接入模型」',
  orphanState.json.providers[0].inModels === false && orphanState.json.providers[0].modelReason === 'not-mounted',
  JSON.stringify(orphanState.json.providers[0]))

// —— 没有凭据服务：说清楚，而不是崩 ——
const bareRoutes = new Map()
apply({
  logger: ctx.logger,
  get: () => undefined,
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { bareRoutes.set(route.path, route.handler); return () => {} } },
}, CONFIGURED)
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

// —— 添加 / 移除供应商：只写额度行，不碰模型路由 ——
// 这一组用自己的一份配置与路由，免得把上面那套读取用例的卡片弄乱；
// llm-pi-ai 那一行在这里只用来证明「一个字节都没被写过」。
const editRows = [
  {
    options: {
      id: 'dsh-quota',
      name: 'dsh-allowance',
      config: { providers: [{ id: 'opencode-go', preset: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY' }] },
    },
  },
  {
    options: {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'deepseek-v4.1-flash' }] } } },
    },
  },
]
const editRoutes = new Map()
const editEditor = {
  entries: () => editRows,
  async edit(entry, change) {
    const next = change(structuredClone(entry.options.config ?? {}), {})
    entry.options.config = next
    return next
  },
}
function editHost() {
  editRoutes.clear()
  apply({
    logger: ctx.logger,
    get: (name) => (name === 'credentials' ? credentials : name === 'configEditor' ? editEditor : undefined),
    effect: (fn) => fn(),
    on: () => () => {},
    webServer: { register: (route) => { editRoutes.set(route.path, route.handler); return () => {} } },
  }, editRows[0].options.config)
}
editHost()
const editCall = (route, options) => callOn(editRoutes, route, options)

const piAiBefore = JSON.stringify(editRows[1].options.config)
const added = await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'deepseek-api', key: 'sk-deepseek' } })
check('POST /quota/providers 回 200', added.status === 200, JSON.stringify(added.json))
check('id 默认取预设的模型名', added.json.id === 'deepseek', JSON.stringify(added.json))
let savedRows = editRows[0].options.config.providers
check('新 provider 落在配置里，且没有顺手补默认值', savedRows.length === 2 && savedRows[1].id === 'deepseek' && savedRows[1].preset === 'deepseek-api', JSON.stringify(savedRows))
check('响应只回额度行，不带 model 字段',
  Array.isArray(added.json.providers) && added.json.providers.length === 2 && !('model' in added.json),
  JSON.stringify(added.json).slice(0, 200))
check('llm-pi-ai 的配置没被改写', JSON.stringify(editRows[1].options.config) === piAiBefore)
check('表单里贴的 key 直接存进凭据库', refs.get('DEEPSEEK_API_KEY') === 'sk-deepseek' && added.json.stored === true)

editHost()
const addedCommand = await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'commandcode' } })
check('Command Code 默认 ID 可用于管理', addedCommand.status === 200 && addedCommand.json.id === 'commandcode' && editRows[0].options.config.providers.some((row) => row.id === 'commandcode'), JSON.stringify(addedCommand.json))
editHost()
check('Command Code 可用默认 ID 移除', (await editCall(ROUTES.providersRemove, { method: 'POST', body: { id: 'commandcode' } })).status === 200)
editRows[0].options.config.providers.push({ preset: 'commandcode' })
editHost()
const legacyRemoved = await editCall(ROUTES.providersRemove, { method: 'POST', body: { id: 'commandcode' } })
check('旧的缺失 ID 配置也能移除', legacyRemoved.status === 200 && !editRows[0].options.config.providers.some((row) => row.preset === 'commandcode'))
// 登录型 / CLI 型预设：卡照加，模型路由一个字都不写。
for (const preset of ['chatgpt', 'claude']) {
  editHost()
  const result = await editCall(ROUTES.providers, { method: 'POST', body: { preset } })
  check(`${preset} 只写额度行、不碰模型路由`,
    result.status === 200 && !('model' in result.json) &&
      editRows[0].options.config.providers.some((row) => row.id === result.json.id) &&
      JSON.stringify(editRows[1].options.config) === piAiBefore,
    JSON.stringify(result.json).slice(0, 200))
  editHost()
  await editCall(ROUTES.providersRemove, { method: 'POST', body: { id: result.json.id } })
}

editHost() // 配置写完，Host 会重载插件；这里也重来一遍
check('同一个预设不能加第二遍', (await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'deepseek-api' } })).status === 409)
check('未知 preset 回 400', (await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'nope' } })).status === 400)
check('非法 id 回 400', (await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'bailian', id: 'bad id!' } })).status === 400)

// 换一家 pi-ai 目录里没有的：额度行照写，模型路由不归这张卡管
editHost()
const addedBailian = await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'bailian', label: '阿里云测试' } })
check('加百炼回 200 且响应里没有 model',
  addedBailian.status === 200 && !('model' in addedBailian.json),
  JSON.stringify(addedBailian.json).slice(0, 200))
savedRows = editRows[0].options.config.providers
check('百炼只落额度行（带显示名）',
  savedRows.some((row) => row.id === 'bailian' && row.label === '阿里云测试' && row.preset === 'bailian'),
  JSON.stringify(savedRows))
check('llm-pi-ai 里没有多出百炼路由',
  !('bailian' in editRows[1].options.config.providers) && JSON.stringify(editRows[1].options.config) === piAiBefore,
  JSON.stringify(editRows[1].options.config))
check('凭据引用填成 key 会被拒（400）',
  (await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'xai-billing', apiKeyEnv: 'sk-ws-abc.def.ghi' } })).status === 400)
check('登录型供应商不收 key',
  (await editCall(ROUTES.providers, { method: 'POST', body: { preset: 'xai-billing', key: 'sk-1' } })).status === 400)

// —— 移除：只删额度行，模型路由不是这张卡管的 ——
editHost()
const removed = await editCall(ROUTES.providersRemove, { method: 'POST', body: { id: 'deepseek' } })
check('POST /quota/providers/remove 回 200', removed.status === 200, JSON.stringify(removed.json))
savedRows = editRows[0].options.config.providers
check('移除后额度配置里没有它了', !savedRows.some((row) => row.id === 'deepseek'), JSON.stringify(savedRows))
check('移除响应只回额度行列表，不带 model', Array.isArray(removed.json.providers) && !('model' in removed.json), JSON.stringify(removed.json).slice(0, 160))
check('移除不回写 llm-pi-ai：配置原样不动', JSON.stringify(editRows[1].options.config) === piAiBefore, JSON.stringify(editRows[1].options.config))
check('移除不存在的 provider 回 404', (await editCall(ROUTES.providersRemove, { method: 'POST', body: { id: 'nope' } })).status === 404)

editHost()
const removedBailian = await editCall(ROUTES.providersRemove, { method: 'POST', body: { id: 'bailian' } })
check('移除百炼也只删额度行', removedBailian.status === 200 &&
  !editRows[0].options.config.providers.some((row) => row.id === 'bailian') &&
  JSON.stringify(editRows[1].options.config) === piAiBefore,
  JSON.stringify({ rows: editRows[0].options.config.providers, llm: editRows[1].options.config }).slice(0, 240))
check('剩最后一家也能移除',
  (await editCall(ROUTES.providersRemove, { method: 'POST', body: { id: 'opencode-go' } })).status === 200)

// —— 连点两下「添加」：配置写入要串行，且只落一行 ——
// configEditor 用「写入前读到的 config」推导 next，两个写入重叠时第二个会拿旧
// next 去比对刚写完的文档，于是报 “overridden by a home patch”（其实没有覆盖）。
const raceRows = [
  { options: { id: 'dsh-quota', name: 'dsh-allowance', config: { providers: [] } } },
  { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } } },
]
const raceRoutes = new Map()
let activeWrites = 0
let peakWrites = 0
const raceEditor = {
  entries: () => raceRows,
  async edit(entry, change) {
    activeWrites += 1
    peakWrites = Math.max(peakWrites, activeWrites)
    await new Promise((resolve) => setTimeout(resolve, 15))
    const next = change(structuredClone(entry.options.config ?? {}), {})
    entry.options.config = next
    activeWrites -= 1
    return next
  },
}
apply({
  logger: ctx.logger,
  get: (name) => (name === 'configEditor' ? raceEditor : name === 'credentials' ? credentials : undefined),
  effect: (fn) => fn(),
  on: () => () => {},
  webServer: { register: (route) => { raceRoutes.set(route.path, route.handler); return () => {} } },
}, raceRows[0].options.config)
const raceCall = (route, options) => callOn(raceRoutes, route, options)
const [firstAdd, secondAdd] = await Promise.all([
  raceCall(ROUTES.providers, { method: 'POST', body: { preset: 'opencode-go' } }),
  raceCall(ROUTES.providers, { method: 'POST', body: { preset: 'opencode-go' } }),
])
check('并发添加都回 200', firstAdd.status === 200 && secondAdd.status === 200,
  JSON.stringify([firstAdd.status, secondAdd.status]))
check('并发添加只落一行', raceRows[0].options.config.providers.filter((row) => row.preset === 'opencode-go').length === 1,
  JSON.stringify(raceRows[0].options.config.providers))
check('配置写入是串行的', peakWrites === 1, `peak=${peakWrites}`)

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
