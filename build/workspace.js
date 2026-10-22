/**
 * What the composer's left toolbar says about where the session lives: the
 * folder it is working in and the git branch that folder is on.
 *
 * Both numbers come from the session's own working directory, never from the
 * Host process — two sessions in one DSH can sit in two repositories. `git` is
 * asked directly (no shell, no user config), and a directory that is not a
 * repository is a normal answer, not an error: the page shows the folder and
 * leaves the branch chip out.
 */
import { execFile } from 'node:child_process'

const GIT_TIMEOUT_MS = 2500

/** The environment git gets: no prompts, no optional writes, no user config surprises. */
function gitEnv() {
  const env = { ...process.env }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

/** One git command in one directory; a non-zero exit resolves to `undefined`. */
function runGit(exec, cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    exec('git', ['-C', cwd, ...args], { timeout: timeoutMs, windowsHide: true, env: gitEnv(), maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      resolve(String(stdout ?? '').trim())
    })
  })
}

/** The last path segment, without a trailing slash — `C:\` stays `C:`. */
export function folderName(cwd) {
  const value = String(cwd ?? '').trim()
  if (value === '') return ''
  return value.split(/[\\/]+/).filter((part) => part !== '').pop() ?? value
}

/**
 * The branch a directory is on, and the repository it belongs to.
 * `detached` marks a checkout without a branch, where the short hash stands in.
 */
export async function readBranch(exec, cwd, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const top = await runGit(exec, cwd, ['rev-parse', '--show-toplevel'], timeoutMs)
  if (!top) return { gitRoot: null, branch: null, detached: false }
  const name = await runGit(exec, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs)
  if (!name) return { gitRoot: top, branch: null, detached: false }
  if (name !== 'HEAD') return { gitRoot: top, branch: name, detached: false }
  // A detached HEAD: the short hash is the only name this checkout has.
  const short = await runGit(exec, cwd, ['rev-parse', '--short', 'HEAD'], timeoutMs)
  return { gitRoot: top, branch: short || null, detached: true }
}

/**
 * A probe with a small per-directory memo: the composer asks on every session
 * switch and every few seconds, and `git` is not free on Windows.
 */
export function createWorkspaceProbe({ exec = execFile, ttlMs = 5000, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const cache = new Map()
  return async function probe(cwd) {
    const value = typeof cwd === 'string' ? cwd.trim() : ''
    if (value === '') return { root: '', name: '', branch: null, gitRoot: null, detached: false }
    const now = Date.now()
    const hit = cache.get(value)
    if (hit && now - hit.at < ttlMs) return hit.value
    const git = await readBranch(exec, value, { timeoutMs })
    const info = { root: value, name: folderName(value), ...git }
    cache.set(value, { at: Date.now(), value: info })
    // The composer asks about a handful of folders, not thousands: one page's
    // worth is enough, oldest first.
    if (cache.size > 32) cache.delete(cache.keys().next().value)
    return info
  }
}
