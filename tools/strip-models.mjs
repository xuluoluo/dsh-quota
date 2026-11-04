/**
 * 一次性数据修复：把 `llm-pi-ai.providers` 下几条**目录路由**上被写死的
 * `models:` 手工清单删掉，让它们重新跟随 pi-ai 目录（目录里有多少就是多少）。
 *
 * 只动点名的那几个 provider，只删 `models:` 及其更深缩进的行，其余原样保留。
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = process.argv[2]
const providers = process.argv.slice(3)
if (!file || providers.length === 0) {
  console.error('usage: node strip-models.mjs <cordis.patch.yml> <provider>...')
  process.exit(2)
}

const text = await readFile(file, 'utf8')
const lines = text.split('\n')
const out = []
const removed = []
let inRow = false // inside the llm-pi-ai plugin row
let provider = null // current provider key inside `providers:`
let skipIndent = -1 // skipping a models block at this indent
let inProviders = false

const indentOf = (line) => line.length - line.trimStart().length

for (const line of lines) {
  const trimmed = line.trim()

  if (skipIndent >= 0) {
    if (trimmed === '' || indentOf(line) > skipIndent) {
      removed.push(line)
      continue
    }
    skipIndent = -1
  }

  if (/^- id: /.test(line)) {
    inRow = trimmed === '- id: llm-pi-ai' || trimmed.startsWith('- id: llm-pi-ai ')
    inProviders = false
    provider = null
    out.push(line)
    continue
  }

  if (!inRow) {
    out.push(line)
    continue
  }

  if (/^\s+providers:\s*$/.test(line)) {
    inProviders = true
    out.push(line)
    continue
  }

  if (inProviders) {
    const key = /^(\s+)([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(line)
    if (key && key[1].length === 6) {
      provider = providers.includes(key[2]) ? key[2] : null
      out.push(line)
      continue
    }
    if (provider !== null) {
      const m = /^(\s+)models:\s*(#.*)?$/.exec(line)
      if (m) {
        skipIndent = m[1].length
        removed.push(line)
        continue
      }
    }
  }

  out.push(line)
}

// 把删空了的 `xai:` 改回 `xai: {}`：YAML 里裸键是 null，适配器要求对象。
for (let i = 0; i < out.length; i += 1) {
  const m = /^(\s{6})([A-Za-z0-9._-]+):\s*$/.exec(out[i])
  if (!m || !providers.includes(m[2])) continue
  let j = i + 1
  while (j < out.length && out[j].trim() === '') j += 1
  const nextIndent = j < out.length ? indentOf(out[j]) : 0
  if (nextIndent <= 6) out[i] = `${m[1]}${m[2]}: {}`
}

await writeFile(file, out.join('\n'), 'utf8')
console.log(`removed ${removed.length} line(s)`)
