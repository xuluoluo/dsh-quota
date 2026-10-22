/**
 * The composer's workspace chips without a browser or a real repository: the
 * folder name, the branch git reports, and the "not a repository" answer that
 * is normal rather than an error.
 */
import { createWorkspaceProbe, folderName, readBranch } from '../build/workspace.js'

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
}

// —— 文件夹名 ——
check('取最后一段', folderName('D:\\Documents\\deepseek-harness\\default-workspace') === 'default-workspace')
check('正斜杠也行', folderName('/home/luo/projects/dsh/') === 'dsh')
check('盘根保留盘符', folderName('D:\\') === 'D:')
check('空串给空串', folderName('') === '')

// —— 假 git：按参数回答 ——
function fakeGit(responses) {
  return (file, args, options, callback) => {
    const key = args.slice(2).join(' ')
    const answer = responses[key]
    setTimeout(() => {
      if (answer === undefined) callback(Object.assign(new Error('git failed'), { code: 128 }), '')
      else callback(null, answer + '\n')
    }, 0)
  }
}

const repo = fakeGit({
  'rev-parse --show-toplevel': 'D:/Documents/repo',
  'rev-parse --abbrev-ref HEAD': 'feature/workspace-chips',
})
const branch = await readBranch(repo, 'D:\\Documents\\repo')
check('分支与仓库根都读出来', branch.branch === 'feature/workspace-chips' && branch.gitRoot === 'D:/Documents/repo', JSON.stringify(branch))

const detached = fakeGit({
  'rev-parse --show-toplevel': 'D:/Documents/repo',
  'rev-parse --abbrev-ref HEAD': 'HEAD',
  'rev-parse --short HEAD': 'abc1234',
})
const head = await readBranch(detached, 'D:\\Documents\\repo')
check('游离 HEAD 用短哈希', head.detached === true && head.branch === 'abc1234', JSON.stringify(head))

const plainFolder = fakeGit({})
const none = await readBranch(plainFolder, 'D:\\Documents\\plain')
check('不是仓库就是没有分支，不是报错', none.branch === null && none.gitRoot === null, JSON.stringify(none))

// —— 有记忆的探针 ——
let calls = 0
const counting = (file, args, options, callback) => {
  calls += 1
  const key = args.slice(2).join(' ')
  const answer = key === 'rev-parse --show-toplevel' ? 'D:/Documents/repo' : 'main'
  setTimeout(() => callback(null, answer + '\n'), 0)
}
const probe = createWorkspaceProbe({ exec: counting, ttlMs: 60_000 })
const first = await probe('D:\\Documents\\repo')
const second = await probe('D:\\Documents\\repo')
check('探针带上文件夹名', first.root === 'D:\\Documents\\repo' && first.name === 'repo' && first.branch === 'main', JSON.stringify(first))
check('同一目录第二次不再问 git', second === first && calls === 2, `calls=${calls}`)

const empty = await probe('')
check('没有目录就什么都不做', empty.root === '' && empty.branch === null)

if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exitCode = 1
} else {
  console.log('\nall workspace checks passed')
}
