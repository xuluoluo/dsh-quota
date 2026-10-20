// The readers, against the shapes the vendors answer.
//
// Pure checks always run. The live checks (QUOTA_LIVE=1) read this machine's
// real credentials and ask the real endpoints — no token is printed, and a
// provider with no credential is skipped with a word about why.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  commandCodeCreditsWindow,
  commandCodePlan,
  readCommandCodeCredits,
  readCommandCodeSubscription,
  readOpenCodeUsage,
  readQuota,
  readXaiBilling,
  worstOf,
} from '../build/providers.js'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failures += 1
}

// —— OpenCode Go ——
const oc = readOpenCodeUsage({
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-10-20T06:45:48.000Z' },
    weekly: { status: 'ok', percent: 19, resetsAt: '2026-10-26T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 33, resetsAt: '2026-11-11T01:02:09.000Z' },
  },
})
check('OpenCode：三个窗口，顺序不变', oc.map((w) => w.key).join() === 'rolling,weekly,monthly')
check('OpenCode：百分比原样', oc[1].used === 19)
check('OpenCode：清零时间是 ISO', oc[0].resetsAt === '2026-10-20T06:45:48.000Z')
let threw = false
try { readOpenCodeUsage({ usage: {} }) } catch { threw = true }
check('OpenCode：空 usage 抛错而不是编造窗口', threw)
check('OpenCode：坏 percent 被丢掉', readOpenCodeUsage({ usage: { rolling: { percent: 4 }, weekly: { percent: 'x' } } }).length === 1)

// —— Grok ——
const xai = readXaiBilling({
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-20T06:32:13.017+00:00' },
    creditUsagePercent: 100,
    productUsage: [{ product: 'GrokBuild', usagePercent: 92 }, { product: 'Cursor', usagePercent: 5 }],
    prepaidBalance: { val: 3.5 },
  },
})
check('Grok：周窗口是 weekly', xai.windows[0].key === 'weekly' && xai.windows[0].used === 100)
check('Grok：重置时间取自 currentPeriod.end', Date.parse(xai.windows[0].resetsAt) === Date.parse('2026-10-20T06:32:13.017Z'))
check('Grok：分项按产品读出', xai.parts.length === 2 && xai.parts[0].name === 'GrokBuild' && xai.parts[0].used === 92)
check('Grok：预付余额只在有钱时给', xai.balance === '$3.50')
check('Grok：on-demand 按 cap 折算', readXaiBilling({
  config: { creditUsagePercent: 10, onDemandCap: { val: 2000 }, onDemandUsed: { val: 500 } },
}).windows.find((w) => w.key === 'on-demand').used === 25)
check('Grok：没有 cap 就没有 on-demand 窗口', readXaiBilling({ config: { creditUsagePercent: 7 } }).windows.length === 1)
check('Grok：月周期认成 monthly', readXaiBilling({ config: { creditUsagePercent: 7, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } } }).windows[0].key === 'monthly')

// —— Command Code ——
const cc = readCommandCodeCredits({
  credits: { monthlyCredits: 5.2207933742, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.0866816244, cap: 14, resetAt: 4102444800000 },
    weekly: { used: 0.8971969678, cap: 35, resetAt: 4102444800000 },
  },
})
check('Command Code：两个窗口', cc.windows.map((w) => w.key).join() === 'five-hour,weekly')
check('Command Code：0.897/35 约 2.56%', Math.round(cc.windows[1].used * 100) / 100 === 2.56)
check('Command Code：resetAt 是 unix 毫秒', cc.windows[1].resetsAt === new Date(4102444800000).toISOString())
check('Command Code：resetAt 为 0 时不给时间', readCommandCodeCredits({ windowLimits: { fiveHour: { used: 0, cap: 14, resetAt: 0 } } }).windows[0].resetsAt === undefined)
check('Command Code：剩余 credits 是三项之和', Math.round(cc.left * 100) / 100 === 5.22)

const goat = commandCodeCreditsWindow(cc, 70)
check('Command Code：GOAT 的当月额度算成 $5.22/$70', goat.display === '$64.78 / $70.00' && Math.round(goat.used) === 93, JSON.stringify(goat))
check('Command Code：没有套餐就没有 credits 窗口', commandCodeCreditsWindow(cc, 0) === undefined)
check('Command Code：planId 前缀最长者胜', commandCodePlan('individual-pro-v1')?.name === 'Pro' && commandCodePlan('individual-pro-v1')?.monthly === 80)
check('Command Code：individual-goat 是 GOAT $70', commandCodePlan('individual-goat-monthly')?.monthly === 70)
check('Command Code：未知套餐不猜', commandCodePlan('individual-what') === undefined)
check('Command Code：取消的订阅不当作在用', readCommandCodeSubscription({ data: { planId: 'individual-go', status: 'canceled' } }) === undefined)
check('Command Code：订阅给出套餐、到期与续费', (() => {
  const read = readCommandCodeSubscription({ success: true, data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-10-22T11:40:10.000Z', cancelAtPeriodEnd: true } })
  return read.plan === 'GOAT' && read.renew === 'off' && read.until === '2026-10-22T11:40:10.000Z'
})())
check('Command Code：success:false 抛错而不是当成没有套餐', (() => {
  try { readCommandCodeSubscription({ success: false }) } catch { return true }
  return false
})())

check('worstOf 取最坏窗口', worstOf([{ used: 3 }, { used: 91 }, { used: 20 }]).used === 91)
check('worstOf 忽略没有数字的窗口', worstOf([{ used: 3 }, {}]).used === 3)

// —— Command Code：订阅接口挂了，窗口照出，只是没有套餐 ——
{
  const realFetch = globalThis.fetch
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    if (String(url).endsWith('/alpha/billing/credits')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ credits: { monthlyCredits: 5 }, windowLimits: { weekly: { used: 5, cap: 50 } } }) }
    }
    throw Object.assign(new Error('slow'), { name: 'TimeoutError' })
  }
  try {
    const reading = await readQuota({ id: 'cc-test', preset: 'commandcode', token: 'k' }, { timeoutMs: 5000, planCache: new Map() })
    check('订阅接口挂了仍然给出窗口', reading.windows.length === 1 && Math.round(reading.windows[0].used) === 10, JSON.stringify(reading))
    check('没有套餐时退回余额而不是编一个月度窗口', reading.plan === undefined && reading.balance === '$5.00', JSON.stringify(reading))
    check('两个接口是一起问的', asked.length === 2, JSON.stringify(asked))
  } finally {
    globalThis.fetch = realFetch
  }
}

// —— 真凭据、真接口 ——
// 需要 `_ref/yaml` 来读凭据文件；那份第三方副本不进仓库，缺席就跳过，不算失败。
const live = process.env.QUOTA_LIVE === '1'
let Y
if (live) {
  try { Y = await import('../../../_ref/yaml/dist/index.js') } catch { Y = undefined }
}
if (live && Y === undefined) console.log('SKIP  真实接口检查：没有 _ref/yaml（第三方副本不在仓库里）')
if (live && Y !== undefined) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const doc = Y.parse(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'))
  const openCodeKey = doc?.refs?.OPENCODE_GO_API_KEY
  const xaiGrant = doc?.records?.['llm-pi-ai/xai']?.payload
  let commandCodeKey
  try { commandCodeKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.commandcode', 'auth.json'), 'utf8')).apiKey } catch {}

  const live = async (label, target, checkName) => {
    if (!target.token) {
      console.log(`SKIP  ${label}：没有凭据`)
      return
    }
    try {
      const reading = await readQuota(target, { timeoutMs: 20000 })
      const ok = reading.windows.length > 0 && reading.windows.every((w) => typeof w.used === 'number' && w.used >= 0 && w.used <= 100)
      check(`${checkName}：真实接口的窗口形状合法`, ok, JSON.stringify(reading))
      console.log(`       ${reading.windows.map((w) => `${w.key}=${Math.round(w.used)}%${w.resetsAt ? ` @${w.resetsAt}` : ''}`).join('  ')}${reading.plan ? `  plan=${reading.plan}` : ''}${reading.balance ? `  balance=${reading.balance}` : ''}`)
    } catch (error) {
      check(`${checkName}：真实接口可读`, false, error.message)
    }
  }

  await live('opencode-go', { id: 'opencode-go', preset: 'opencode-go', token: openCodeKey }, 'OpenCode Go')
  await live('grok', { id: 'grok', preset: 'xai-billing', token: xaiGrant?.access }, 'Grok')
  await live('commandcode', { id: 'commandcode', preset: 'commandcode', token: commandCodeKey }, 'Command Code')

  let refused = ''
  try { await readQuota({ id: 'grok', preset: 'xai-billing', token: 'not-a-token' }, { timeoutMs: 20000 }) } catch (error) { refused = error.message }
  check('坏 token 报出 HTTP 状态而不是静默', /HTTP 4\d\d/.test(refused), refused)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
