/**
 * The prediction half without a browser: the transcript, the cleaning of what
 * the model says, and the idle gate that decides whether asking is worthwhile.
 */
import { buildTranscript, cleanSuggestion, createPredictor, pickModel } from '../build/prediction.js'

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
}

// —— 对话摘录 ——
const messages = [
  { role: 'user', content: [{ type: 'text', text: '帮我加一个测试' }] },
  { role: 'assistant', content: [{ type: 'text', text: '好，先看 providers.test.mjs' }] },
  { role: 'system', content: [{ type: 'text', text: 'ignored' }] },
  { role: 'assistant', content: [{ type: 'tool-call', name: 'read' }] },
]
const transcript = buildTranscript(messages, 10)
check('摘录只留 user/assistant 的文本', transcript.includes('用户: 帮我加一个测试') && transcript.includes('助手: 好'), transcript)
check('非文本内容不进去', !transcript.includes('tool-call'))

const many = Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: [{ type: 'text', text: `第 ${index} 句` }] }))
check('只取最后 N 条', buildTranscript(many, 3).split('\n\n').length === 3, buildTranscript(many, 3))
check('空对话给空串', buildTranscript([], 5) === '')

// —— 清洗模型输出 ——
check('去掉引号', cleanSuggestion('「继续跑测试」') === '继续跑测试')
check('去掉列表符号', cleanSuggestion('- 继续') === '继续')
check('多行只取第一行', cleanSuggestion('继续\n然后呢') === '继续')
check('全空返回空串', cleanSuggestion('  \n  ') === '')
check('超长截断', cleanSuggestion('x'.repeat(500)).length === 200)

// —— 什么时候值得问 ——
function fakeSession({ events }) {
  return {
    seq: events.length,
    eventAt: (seq) => events[seq],
    deriveMessages: () => events.messages ?? [],
  }
}

const idleEvents = [{ type: 'user/message' }, { type: 'turn/start' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }]
idleEvents.messages = messages

function ctxWith({ session, model = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, llm }) {
  return {
    get: (name) => (name === 'sessions' ? { get: () => session } : name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => model } : undefined),
  }
}

function recordingLlm(text = '「继续」') {
  const seen = []
  return {
    seen,
    stream(options) {
      seen.push(options)
      return (async function* generate() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'completed' } }
      })()
    },
  }
}

const settingsFor = (predict) => ({ predict: { enabled: true, provider: '', model: '', systemPrompt: '', maxTokens: 120, maxContextMessages: 12, debounceMs: 700, ...predict } })

const disabled = createPredictor(ctxWith({ session: fakeSession({ events: idleEvents }), llm: recordingLlm() }), () => settingsFor({ enabled: false }))
check('关掉时一次都不问', (await disabled.suggest('s1')).reason === 'disabled')

const noSession = createPredictor(ctxWith({ session: undefined, llm: recordingLlm() }), () => settingsFor())
check('没有会话就别问', (await noSession.suggest('s1')).reason === 'no-session')

const runningEvents = [...idleEvents, { type: 'user/message' }, { type: 'turn/start' }]
runningEvents.messages = messages
const running = createPredictor(ctxWith({ session: fakeSession({ events: runningEvents }), llm: recordingLlm() }), () => settingsFor())
check('正在跑的时候不问', (await running.suggest('s1')).reason === 'not-idle')

const emptySession = fakeSession({ events: [{ type: 'turn/start' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }] })
const empty = createPredictor(ctxWith({ session: emptySession, llm: recordingLlm() }), () => settingsFor())
check('没有用户消息时不问', (await empty.suggest('s1')).reason === 'empty-conversation')

const llm = recordingLlm()
const idle = createPredictor(ctxWith({ session: fakeSession({ events: idleEvents }), llm }), () => settingsFor())
const answer = await idle.suggest('s1')
check('空闲时问一次，并把引号洗掉', answer.suggestion === '继续', JSON.stringify(answer))
check('模型来自会话默认', answer.model.provider === 'opencode-go' && answer.model.model === 'deepseek-v4.1-flash', JSON.stringify(answer.model))
check('请求带上系统提示词与对话', typeof llm.seen[0].system === 'string' && llm.seen[0].messages[0].content[0].text.includes('帮我加一个测试'))
check('请求限制长度与温度', llm.seen[0].maxTokens === 120 && llm.seen[0].temperature === 0.5)

const explicit = createPredictor(ctxWith({ session: fakeSession({ events: idleEvents }), llm: recordingLlm() }), () => settingsFor({ provider: 'ali', model: 'qwen3.8-max' }))
check('配置里指定模型就听配置的', (await explicit.suggest('s1')).model.provider === 'ali')

const silent = createPredictor(ctxWith({ session: fakeSession({ events: idleEvents }), llm: recordingLlm('   ') }), () => settingsFor())
check('模型说不出话就当没有预测', (await silent.suggest('s1')).suggestion === null)

const failing = {
  stream() {
    return (async function* generate() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limit', message: 'slow down' } } }
    })()
  },
}
const broken = createPredictor(ctxWith({ session: fakeSession({ events: idleEvents }), llm: failing }), () => settingsFor())
let threw = ''
try {
  await broken.suggest('s1')
} catch (error) {
  threw = String(error?.message ?? error)
}
check('模型报错时抛出，由路由转成数据', threw.includes('rate_limit'), threw)

check('pickModel 没配置时退到会话默认', pickModel(ctxWith({ session: undefined, llm: {} }), {}) .provider === 'opencode-go')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
