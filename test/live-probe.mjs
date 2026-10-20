// Live probe: what each vendor really answers on this machine, printed once so
// the readers in build/providers.js can be checked against reality. Never
// prints a token; bodies carry usage numbers only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The credentials document is YAML; the parser is a local copy under _ref,
// which the repository doesn't carry (third-party code), so a missing copy is
// a clear stop rather than a stack trace.
let Y
try {
  Y = await import('../../../_ref/yaml/dist/index.js')
} catch {
  console.error('live-probe needs the YAML parser at _ref/yaml (it reads your own credentials file)')
  process.exit(2)
}

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const doc = Y.parse(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'))
const storeKey = doc?.refs?.OPENCODE_GO_API_KEY
const xai = doc?.records?.['llm-pi-ai/xai']?.payload

let cmdKey
try {
  cmdKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.commandcode', 'auth.json'), 'utf8')).apiKey
} catch {}

async function probe(label, url, token, extra = {}) {
  if (!token) {
    console.log(`\n== ${label}\nSKIP no token`)
    return
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...extra },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let body = text
    try { body = JSON.stringify(JSON.parse(text), null, 2) } catch {}
    console.log(`\n== ${label}\nGET ${url}\nHTTP ${res.status}\n${body.slice(0, 2500)}`)
  } catch (error) {
    console.log(`\n== ${label}\nGET ${url}\nERROR ${error?.name}: ${error?.message} ${error?.cause?.code ?? ''}`)
  }
}

await probe('opencode-go usage', 'https://opencode.ai/zen/go/v1/usage', storeKey)
await probe('grok billing', 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', xai?.access, {
  'x-xai-token-auth': 'xai-grok-cli',
})
await probe('commandcode credits', 'https://api.commandcode.ai/alpha/billing/credits', cmdKey)
await probe('commandcode subscriptions', 'https://api.commandcode.ai/alpha/billing/subscriptions', cmdKey)
