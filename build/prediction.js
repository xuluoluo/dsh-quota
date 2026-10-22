/**
 * Input prediction: read the session's own transcript, ask a model what the
 * user is about to type, and hand the answer back to the composer as ghost
 * text. Nothing here sends anything: the client inserts the text and the user
 * still presses Enter.
 *
 * The seam is `llm.stream` (the same service call the harness makes), so a
 * prediction is billed and counted like any other model call — which is why it
 * shows up in this plugin's own usage numbers rather than hiding from them.
 */

/** The default instruction, kept short: a long one costs more than it saves. */
export const DEFAULT_PROMPT = `你是一个输入预测器。下面是用户与编码 Agent 的对话记录。
请预测用户接下来最可能输入的一句话。

要求：
- 只输出这一句话本身，不要引号、不要解释、不要前缀。
- 用对话所用的语言。
- 20 字以内，像用户自己会打的字（可以是「继续」「跑一下测试」这种短句）。
- 如果没有任何合理的下一句，输出空字符串。`

const DEFAULT_MAX_TOKENS = 120
const DEFAULT_CONTEXT_MESSAGES = 12
const MAX_SUGGESTION_CHARS = 200

/** The last completed turn, or null — a prediction only makes sense at rest. */
function completedTurnSeq(session) {
  const end = typeof session.seq === 'number' ? session.seq : 0
  // 一轮结束后还会跟几条 title / workspace / job 事件；窗口留宽一点，
  // 免得「明明空闲却判断成在跑」。碰到本轮 turn/start 就停。
  const floor = Math.max(0, end - 200)
  for (let seq = end - 1; seq >= floor; seq -= 1) {
    const event = session.eventAt?.(seq)
    if (!event) break
    if (event.type === 'turn/start' || event.type === 'user/message') return null
    if (event.type === 'turn/end') return event.data?.reason?.kind === 'completed' ? seq : null
  }
  return null
}

/** A compact `role: text` transcript of the tail of the conversation. */
export function buildTranscript(messages, limit = DEFAULT_CONTEXT_MESSAGES) {
  const picked = []
  for (const message of messages ?? []) {
    const role = typeof message?.role === 'string' ? message.role : ''
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(message)
    if (text === '') continue
    picked.push(`${role === 'user' ? '用户' : '助手'}: ${text}`)
  }
  return picked.slice(-limit).join('\n\n')
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n').trim()
}

/** What the model said, with the shapes a model uses to "helpfully" wrap it. */
export function cleanSuggestion(raw) {
  let text = typeof raw === 'string' ? raw : ''
  text = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? ''
  text = text.replace(/^[-*]\s+/, '').replace(/^["'“”「『]|["'“”」』]$/g, '').trim()
  if (text.length > MAX_SUGGESTION_CHARS) text = text.slice(0, MAX_SUGGESTION_CHARS)
  return text
}

/**
 * Which route answers. An explicit setting wins; otherwise the session's own
 * selection, then the profile's default model, so this works without setup.
 */
export function pickModel(ctx, predict) {
  if (predict?.provider && predict?.model) return { provider: predict.provider, model: predict.model }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/** Stream a completion and return its text; a failed call throws. */
export async function complete(llm, model, transcript, signal, predict) {
  let text = ''
  const stream = llm.stream({
    provider: model.provider,
    model: model.model,
    system: typeof predict?.systemPrompt === 'string' && predict.systemPrompt.trim() !== '' ? predict.systemPrompt : DEFAULT_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: `对话记录：\n\n${transcript}` }] }],
    temperature: 0.5,
    maxTokens: typeof predict?.maxTokens === 'number' ? predict.maxTokens : DEFAULT_MAX_TOKENS,
    signal,
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk?.type === 'finish') {
      if (chunk.reason?.kind === 'error') {
        throw new Error(`model error: ${chunk.reason?.failure?.code ?? 'unknown'} ${chunk.reason?.failure?.message ?? ''}`.trim())
      }
      if (chunk.reason?.kind === 'aborted') throw new Error('model aborted')
      break
    }
  }
  return text
}

/** The whole flow for one session, answering with data rather than HTTP codes. */
export function createPredictor(ctx, readSettings) {
  return {
    async suggest(sessionId, signal) {
      const { predict } = readSettings()
      if (!predict.enabled) return { suggestion: null, reason: 'disabled' }
      const session = ctx.get('sessions')?.get?.(sessionId)
      if (!session) return { suggestion: null, reason: 'no-session' }
      if (completedTurnSeq(session) === null) return { suggestion: null, reason: 'not-idle' }
      const messages = session.deriveMessages?.() ?? []
      if (!messages.some((message) => message?.role === 'user')) return { suggestion: null, reason: 'empty-conversation' }
      const model = pickModel(ctx, predict)
      if (!model) return { suggestion: null, reason: 'no-model' }
      const transcript = buildTranscript(messages, predict.maxContextMessages)
      const raw = await complete(ctx.get('llm'), model, transcript, signal, predict)
      const suggestion = cleanSuggestion(raw)
      if (suggestion === '') return { suggestion: null, reason: 'nothing-to-say', model }
      return { suggestion, model }
    },
  }
}
