// The Client bundle, driven without a browser: a small hooks runtime expands
// the components, a fake fetch answers the Host routes, and the whole path —
// register → read → render → act — is checked through the trees the components
// actually produce.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failures += 1
}

// —— 最小 hooks 运行时 ——
function createMiniReact() {
  const instances = new Map()
  let current = null
  let root = null
  let tree = null
  let scheduled = false

  const instanceOf = (fn) => {
    if (!instances.has(fn)) instances.set(fn, { hooks: [], effects: new Set() })
    return instances.get(fn)
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      const inst = current
      const index = inst.index++
      if (!(index in inst.hooks)) inst.hooks[index] = initial
      const set = (value) => {
        const next = typeof value === 'function' ? value(inst.hooks[index]) : value
        if (next === inst.hooks[index]) return
        inst.hooks[index] = next
        schedule()
      }
      return [inst.hooks[index], set]
    },
    useEffect(fn) {
      const inst = current
      const index = inst.index++
      if (inst.effects.has(index)) return
      inst.effects.add(index)
      const cleanup = fn()
      return cleanup
    },
    useRef(initial) {
      const inst = current
      const index = inst.index++
      if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
      return inst.hooks[index]
    },
    useCallback(fn) {
      return fn
    },
  }

  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (node === null || node === undefined) return node
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const inst = instanceOf(node.type)
      const previous = current
      current = inst
      inst.index = 0
      let out
      try {
        out = node.type({ ...node.props, children: node.children })
      } finally {
        current = previous
      }
      return expand(out)
    }
    return { type: node.type, props: node.props ?? {}, children: (node.children ?? []).map(expand) }
  }

  function draw() {
    tree = root === null ? null : expand(root)
    return tree
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      draw()
    }, 0)
  }

  return {
    React,
    mount(component, props = {}) {
      // A fresh mount is a fresh tree: effects run again, exactly like a
      // component that was just re-created.
      for (const inst of instances.values()) inst.effects.clear()
      root = { type: component, props, children: [] }
      return draw()
    },
    get tree() { return tree },
  }
}

function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { node.forEach((entry) => textsOf(entry, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (node.children) node.children.forEach((entry) => textsOf(entry, out))
  return out
}

function elements(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((entry) => elements(entry, out)); return out }
  if (node.type) out.push(node)
  for (const child of node.children ?? []) elements(child, out)
  return out
}

function findByText(tree, text) {
  return elements(tree).find((node) => node.type === 'button' && textsOf(node).join('').includes(text))
}

function byAttr(tree, name, value) {
  return elements(tree).find((node) => node.props?.[name] === value)
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

// —— 浏览器与 React 的替身 ——
const mini = createMiniReact()
let definition
globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def } } }
globalThis.document = { baseURI: 'http://127.0.0.1:62756/', visibilityState: 'visible' }

const calls = []
const cardBase = {
  id: 'opencode-go',
  label: 'OpenCode Go',
  preset: 'opencode-go',
  auth: 'key',
  keysUrl: 'https://opencode.ai/auth',
  windows: [
    { key: 'rolling', used: 2, resetsAt: '2026-10-20T06:45:48.000Z' },
    { key: 'weekly', used: 19, resetsAt: '2026-10-26T00:00:00.000Z' },
    { key: 'monthly', used: 33, resetsAt: '2026-11-11T01:02:09.000Z' },
  ],
  worst: { key: 'monthly', used: 33 },
  credential: { auth: 'key', configured: true, source: 'file', hint: 'OPENCODE_GO_API_KEY', writable: true },
}
const usageView = {
  todayCost: 0.42,
  cost: 3.17,
  today: { calls: 1, input: 12000, output: 900, cacheRead: 20000, cacheWrite: 0, reasoning: 300 },
  window: { calls: 4, input: 47300, output: 3600, cacheRead: 93200, cacheWrite: 0, reasoning: 2300 },
  days: ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'].map((date, index) => ({
    date,
    calls: index === 6 ? 1 : 0,
    input: index === 6 ? 12000 : 0,
    output: index === 6 ? 900 : 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  })),
  models: [
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash', calls: 3, input: 33000, output: 3600, cacheRead: 93200, cacheWrite: 0, reasoning: 2000, cost: 0.0132 },
    { provider: 'opencode-go', model: 'glm-5.3-flash', calls: 1, input: 14300, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.0021 },
  ],
}

const payload = {
  enabled: true,
  fetchedAt: '2026-10-20T05:50:00.000Z',
  refreshMs: 60000,
  usage: usageView,
  usageFile: 'C:/Users/x/.dsh/.quota-usage.json',
  showChip: true,
  presets: [
    { id: 'opencode-go', label: 'OpenCode Go', auth: 'key' },
    { id: 'xai-billing', label: 'Grok', auth: 'oauth' },
    { id: 'commandcode', label: 'Command Code', auth: 'key' },
    { id: 'deepseek-api', label: 'DeepSeek API', auth: 'key' },
    { id: 'bailian', label: 'Alibaba Bailian', auth: 'key' },
  ],
  providers: [
    cardBase,
    {
      id: 'grok', label: 'Grok', preset: 'xai-billing', auth: 'oauth',
      windows: [{ key: 'weekly', used: 100, resetsAt: '2026-10-20T06:32:13.017Z' }],
      worst: { key: 'weekly', used: 100 },
      parts: [{ name: 'GrokBuild', used: 92 }, { name: 'Cursor', used: 5 }],
      alert: 'critical',
      credential: { auth: 'oauth', configured: false, hint: 'llm-pi-ai/xai' },
    },
    {
      id: 'commandcode', label: 'Command Code', preset: 'commandcode', auth: 'key',
      keysUrl: 'https://commandcode.ai/settings/keys',
      plan: 'GOAT', until: '2026-10-22T11:40:10.000Z', renew: 'off',
      windows: [
        { key: 'five-hour', used: 50, resetsAt: '2026-10-20T15:00:00.000Z' },
        { key: 'weekly', used: 25, resetsAt: '2026-10-24T14:46:00.767Z' },
        { key: 'credits', used: 93, display: '$64.78 / $70.00' },
      ],
      worst: { key: 'credits', used: 93 },
      alert: 'warn',
      credential: { auth: 'key', configured: true, source: 'cli', account: 'xuluoluo', hint: '.commandcode/auth.json', writable: false },
    },
    {
      id: 'deepseek', label: 'DeepSeek API', preset: 'deepseek-api', auth: 'key',
      keysUrl: 'https://platform.deepseek.com/api_keys',
      windows: [], worst: null,
      balance: '¥110.00', note: 'topped up ¥100.00 · granted ¥10.00',
      credential: { auth: 'key', configured: true, source: 'file', hint: 'DEEPSEEK_API_KEY', writable: true },
    },
    {
      id: 'bailian', label: 'Alibaba Bailian', preset: 'bailian', auth: 'key',
      keysUrl: 'https://bailian.console.aliyun.com/',
      quota: false, windows: [], worst: null,
      credential: { auth: 'key', configured: true, source: 'file', hint: 'DASHSCOPE_API_KEY', writable: true },
    },
  ],
}

let answer = (url, init) => {
  if (url.endsWith('/quota/login/start')) {
    return { status: 'pending', userCode: 'ABCD-1234', verificationUri: 'https://x.ai/device', verificationUriComplete: 'https://x.ai/device?code=ABCD-1234' }
  }
  if (url.includes('/quota/login/status')) return { status: 'pending' }
  if (url.endsWith('/quota/key')) return { ok: true }
  if (url.endsWith('/quota/clear')) return { ok: true }
  if (url.endsWith('/quota/test')) return { ok: true, detail: '178 models' }
  if (url.endsWith('/quota/suggest')) return { suggestion: '继续把测试补上' }
  if (url.endsWith('/quota/models')) return { groups: [{ provider: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] }] }
  if (url.endsWith('/quota/providers')) return { ok: true }
  if (url.endsWith('/quota/providers/remove')) return { ok: true }
  return payload
}

globalThis.fetch = async (url, init) => {
  const target = String(url)
  calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body })
  return { ok: true, status: 200, json: async () => answer(target, init) }
}

// —— 加载 bundle ——
await import(pathToFileURL(path.join(here, '..', 'build', 'client.js')).href)
check('bundle 通过 __ModuleLoader__ 注册', definition?.id === '@local/dsh-quota')

const mod = definition.factory((name) => {
  if (name === 'react') return mini.React
  throw new Error(`unexpected require: ${name}`)
})
check('导出 apply 与 inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))
check('inject 声明 slots 与 locale', mod.inject.join() === 'slots,locale')

// —— 假 ctx ——
const dicts = {}
const slots = []
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, value) => { dicts[ns] = value },
    bind: (ns) => (key) => dicts[ns]?.zh?.[key] ?? key,
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (spec, component) => { slots.push({ spec, component }); return () => {} },
  },
}
mod.apply(ctx)

check('注册了四个 slot', slots.length === 4 && slots.map((s) => s.spec.name).sort().join() === 'conversation.composer.dock,conversation.input.overlay,conversation.input.right,settings.section', JSON.stringify(slots.map((s) => s.spec.name)))
const chipSlot = slots.find((s) => s.spec.name === 'conversation.input.right')
const stripSlot = slots.find((s) => s.spec.name === 'conversation.composer.dock')
const pageSlot = slots.find((s) => s.spec.name === 'settings.section')
check('chip 挂在 conversation.input.right（list 槽，不抢模型选择器）', Boolean(chipSlot) && chipSlot.spec.id === 'quota-chip')
check('设置页挂在 settings.section 且有 label', Boolean(pageSlot) && typeof pageSlot.spec.label === 'function')
check('窄条挂在 conversation.composer.dock', Boolean(stripSlot) && stripSlot.spec.id === 'quota-strip')
check('中英字典都注册了', Boolean(dicts['settings.quota']?.zh?.title && dicts['settings.quota']?.en?.title))

// —— chip ——
check('首帧（还没取到数）不渲染', mini.mount(chipSlot.component) === null)
await tick()
check('取数打了 /quota/state', calls.some((call) => call.url.endsWith('/quota/state')), JSON.stringify(calls))
let chipTexts = textsOf(mini.tree)
check('chip 渲染出五个 provider',
  chipTexts.includes('OpenCode Go') && chipTexts.includes('Grok') && chipTexts.includes('Command Code') && chipTexts.includes('DeepSeek API') && chipTexts.includes('Alibaba Bailian'),
  JSON.stringify(chipTexts))
check('chip 显示最坏窗口的百分比', chipTexts.includes('33%') && chipTexts.includes('100%') && chipTexts.includes('93%'),
  JSON.stringify(chipTexts))
check('没有窗口的余额卡在 chip 上显示金额', chipTexts.includes('¥110.00'), JSON.stringify(chipTexts))

const chip = byAttr(mini.tree, 'data-dsh-quota', 'chip')
check('chip 可点击', Boolean(chip && typeof chip.props.onClick === 'function'))
await chip.props.onClick()
await tick()
check('点击打了 /quota/refresh 且是 POST',
  calls.some((call) => call.url.endsWith('/quota/refresh') && call.method === 'POST'), JSON.stringify(calls.slice(-3)))

// —— 设置页：数字 ——
mini.mount(pageSlot.component)
await tick()
let pageTexts = textsOf(mini.tree)
check('页面标题与刷新按钮', pageTexts.includes('额度') && pageTexts.includes('刷新'))
check('三个窗口名都本地化了',
  pageTexts.includes('滚动窗口') && pageTexts.includes('每周') && pageTexts.includes('每月'),
  JSON.stringify(pageTexts.slice(0, 30)))
check('Command Code 的 5 小时与当月额度也认得',
  pageTexts.includes('5 小时') && pageTexts.includes('当月额度'))
check('套餐与到期写在卡头', pageTexts.join('').includes('套餐 · GOAT') && pageTexts.join('').includes('到期于'))
check('credits 窗口显示金额而不是百分比', pageTexts.includes('$64.78 / $70.00'))
check('DeepSeek 余额卡：金额 + 构成', pageTexts.join('').includes('余额 · ¥110.00') && pageTexts.join('').includes('topped up ¥100.00'))
check('没有额度接口的卡（百炼）说明自己的职责', pageTexts.join('').includes('这家没有公开的额度接口'), JSON.stringify(pageTexts.slice(-12)))
check('Grok 的产品分项有渲染', pageTexts.includes('GrokBuild 92%'))

// —— 用量 ——
check('用量：四个数字都在', ['50.9K', '93.2K', '2.3K', '4'].every((value) => pageTexts.includes(value)),
  JSON.stringify(pageTexts.slice(0, 40)))
check('用量：输入输出写在 TOKEN 下', pageTexts.join('').includes('输入 47.3K · 输出 3.6K'))
check('用量：缓存命中率', pageTexts.join('').includes('命中率 66%'))
check('用量：按模型分行', pageTexts.includes('deepseek-v4.1-flash') && pageTexts.join('').includes('命中率 74%'))
check('用量：七天条带七根柱子',
  elements(mini.tree).filter((node) => /^\d{4}-\d{2}-\d{2} · /.test(String(node.props?.title ?? ''))).length === 7)
check('每个 provider 都有移除按钮',
  elements(mini.tree).filter((node) => node.type === 'button' && textsOf(node).join('') === '移除').length === 5)

// —— 设置页：凭据状态与动作 ——
check('已存储的 key 说了来源', pageTexts.join('').includes('已存入 DSH 凭据库'))
check('CLI 登录说了账号', pageTexts.join('').includes('使用 Command Code CLI 的登录') && pageTexts.join('').includes('xuluoluo'))
check('未登录的 Grok 显示登录按钮', Boolean(findByText(mini.tree, '登录 Grok')))
check('凭据引用名可见', pageTexts.includes('OPENCODE_GO_API_KEY'))

// 存 key：先输入，再点保存
const input = elements(mini.tree).find((node) => node.type === 'input')
check('OpenCode 卡有 key 输入框', Boolean(input && typeof input.props.onChange === 'function'))
input.props.onChange({ target: { value: '  sk-test-123  ' } })
await tick()
const save = findByText(mini.tree, '保存')
check('输入后保存按钮可用', Boolean(save && save.props.disabled === false), JSON.stringify(save?.props?.disabled))
await save.props.onClick()
await tick(60)
const keyCall = calls.find((call) => call.url.endsWith('/quota/key'))
check('保存打了 /quota/key', Boolean(keyCall), JSON.stringify(calls.map((c) => c.url)))
check('保存把 key 原样（不带空白）发给 Host', keyCall && JSON.parse(keyCall.body).key === 'sk-test-123', keyCall?.body)
check('保存带上 provider id', keyCall && JSON.parse(keyCall.body).id === 'opencode-go')

// —— 添加供应商：列表上方一个按钮，点开才出表单 ——
const addToggle = elements(mini.tree).find((node) => node.type === 'button' && textsOf(node).join('').includes('添加供应商'))
check('列表上方有「添加供应商」按钮', Boolean(addToggle), JSON.stringify(elements(mini.tree).filter((n) => n.type === 'button').map((n) => textsOf(n).join(''))))
check('没点开时看不到表单',
  !elements(mini.tree).some((node) => node.type === 'input' && String(node.props?.placeholder ?? '').startsWith('id')))
addToggle.props.onClick()
await tick()
const idField = elements(mini.tree).find((node) => node.type === 'input' && String(node.props?.placeholder ?? '').startsWith('id'))
check('点开后出现表单', Boolean(idField))
idField.props.onChange({ target: { value: 'my-oc' } })
await tick()
const addButton = elements(mini.tree).find((node) => node.type === 'button' && textsOf(node).join('') === '添加')
check('填了 id 之后添加按钮可用', Boolean(addButton))
addButton.props.onClick()
await tick(80)
const addCall = calls.find((call) => call.url.endsWith('/quota/providers'))
check('添加打了 /quota/providers', Boolean(addCall), JSON.stringify(calls.map((call) => call.url)))
check('添加带上预设与 id', addCall && JSON.parse(addCall.body).id === 'my-oc' && JSON.parse(addCall.body).preset === 'opencode-go', addCall?.body)
check('添加成功后表单收起',
  !elements(mini.tree).some((node) => node.type === 'input' && String(node.props?.placeholder ?? '').startsWith('id')))

// —— 成本、告警、测试连接 ——
check('用量区给出估算花费', pageTexts.join('').includes('≈') && pageTexts.join('').includes('.17'), JSON.stringify(pageTexts.slice(0, 20)))
check('模型行也带花费', pageTexts.join('').includes('.013'))
check('超过阈值时卡头挂告警', pageTexts.join('').includes('已达上限') && pageTexts.join('').includes('接近上限'))

const testButton = findByText(mini.tree, '测试')
check('有「测试」按钮', Boolean(testButton))
await testButton.props.onClick()
await tick(80)
check('测试打了 /quota/test', calls.some((call) => call.url.endsWith('/quota/test') && call.method === 'POST'))
check('测试结果显示在卡上', textsOf(mini.tree).join('').includes('连接正常') && textsOf(mini.tree).join('').includes('178 models'),
  JSON.stringify(textsOf(mini.tree).slice(-10)))

// —— 常驻窄条 ——
mini.mount(stripSlot.component)
await tick()
const stripTexts = textsOf(mini.tree)
check('窄条显示每家与百分比', stripTexts.includes('OpenCode Go') && stripTexts.some((text) => text.includes('100%')), JSON.stringify(stripTexts))
check('窄条显示今日花费', stripTexts.join('').includes('今日 ≈$0.42'), JSON.stringify(stripTexts))
check('窄条对告警加 ⚠', stripTexts.some((text) => text.indexOf('⚠') === 0), JSON.stringify(stripTexts))

// 登录：点按钮 → 出设备码面板（先挂回设置页）
mini.mount(pageSlot.component)
await tick()
const signIn = findByText(mini.tree, '登录 Grok')
await signIn.props.onClick()
await tick(60)
pageTexts = textsOf(mini.tree)
check('登录打了 /quota/login/start', calls.some((call) => call.url.endsWith('/quota/login/start') && call.method === 'POST'))
check('设备码面板显示 user code', pageTexts.includes('ABCD-1234'), JSON.stringify(pageTexts.slice(-16)))
check('设备码面板给出授权页链接', Boolean(elements(mini.tree).find((node) => node.type === 'a' && String(node.props.href).includes('code=ABCD-1234'))))
check('登录面板可取消', Boolean(findByText(mini.tree, '取消')))

// 退出登录：对 oauth 卡是删记录
const signOut = findByText(mini.tree, '退出登录')
check('已登录的卡才有退出登录', signOut === undefined)

// —— 失败态：接口挂掉时 chip 显示 ! 而不是消失 ——
answer = () => ({ ...payload, providers: [{ id: 'grok', label: 'Grok', auth: 'oauth', error: 'HTTP 401: Unauthorized', credential: { auth: 'oauth', configured: true } }] })
mini.mount(slots[0].component)
await tick()
const failChip = byAttr(mini.tree, 'data-dsh-quota', 'chip')
await failChip.props.onClick()
await tick(40)
const failTexts = textsOf(mini.tree)
check('出错时仍显示 provider 且标 !', failTexts.includes('Grok') && failTexts.includes('!'), JSON.stringify(failTexts))

// —— 输入预测：空输入框里要一次预测，Tab 接受 ——
const keyHandlers = []
const inserted = []
globalThis.window = Object.assign(globalThis, {
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener(type, fn) { if (type === 'keydown') keyHandlers.push(fn) },
  removeEventListener() {},
  getSelection: () => null,
  getComputedStyle: () => ({ font: '14px serif', lineHeight: '20px', color: '#000' }),
})

const ghostEntry = slots.find((slot) => slot.spec.name === 'conversation.input.overlay')
const actions = {
  captureInsertion: () => ({ anchor: 0 }),
  insertText: (text) => { inserted.push(text); return true },
}
const ghostProps = (overrides) => Object.assign({
  sessionId: 'session-1',
  useInput: (select) => select({ draft: '', attachmentIds: [] }),
  useSession: (select) => select({ running: false }),
  inputActions: actions,
  t: (key) => key,
}, overrides)

// 让 store 抓一次新快照：点一下 chip 就是 refresh
async function refreshStore() {
  mini.mount(chipSlot.component)
  await tick()
  const chip = byAttr(mini.tree, 'data-dsh-quota', 'chip')
  if (chip) {
    await chip.props.onClick()
    await tick(60)
  }
}

answer = (url) => (url.endsWith('/quota/suggest') ? { suggestion: '继续把测试补上' } : { ...payload, predict: { enabled: false, debounceMs: 200 } })
await refreshStore()
mini.mount(ghostEntry.component, ghostProps())
await tick(50)
check('预测关掉时什么都不渲染', mini.tree === null)

answer = (url) => (url.endsWith('/quota/suggest') ? { suggestion: '继续把测试补上' } : { ...payload, predict: { enabled: true, debounceMs: 200 } })
await refreshStore()
mini.mount(ghostEntry.component, ghostProps({ useInput: (select) => select({ draft: '已输入', attachmentIds: [] }) }))
await tick(300)
check('输入框有字时不去问', !calls.some((call) => call.url.endsWith('/quota/suggest')))

calls.length = 0
mini.mount(ghostEntry.component, ghostProps())
await tick(400)
const predictCall = calls.find((call) => call.url.endsWith('/quota/suggest'))
check('空输入框 + 空闲 → 请求一次预测', Boolean(predictCall) && JSON.parse(predictCall.body).sessionId === 'session-1',
  JSON.stringify(calls.map((call) => call.url)))
check('预测结果不自动填入', inserted.length === 0)
check('预测的灰字挂在 composer 的 overlay 槽里', Boolean(byAttr(mini.tree, 'data-dsh-quota', 'ghost')))

const tab = keyHandlers[keyHandlers.length - 1]
tab({ key: 'Tab', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {} })
await tick(20)
check('Tab 才把预测填进输入框', inserted[0] === '继续把测试补上', JSON.stringify(inserted))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
