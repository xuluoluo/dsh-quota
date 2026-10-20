// 离线验证 upsertRecord 的 YAML 手术：内容正确、其它条目原样保留、可重复执行。
import fs from 'node:fs';
import path from 'node:path';
import { upsertRecord } from './grok-login.mjs';

// 断言用的 YAML 解析器是 _ref 下的本地副本（第三方代码，不进仓库）。
let parse;
try {
  ({ parse } = await import('../../../_ref/yaml/dist/index.js'));
} catch {
  console.error('需要 _ref/yaml 里的 YAML 解析器；这个回归测试读本地副本，跳过即视为失败');
  process.exit(2);
}

const REAL = path.join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures += 1;
};

const entry = (access, refresh, expires) => [
  '    kind: grant',
  '    payload:',
  '      type: oauth',
  `      access: ${JSON.stringify(access)}`,
  `      refresh: ${JSON.stringify(refresh)}`,
  `      expires: ${expires}`,
];

// 1. 真实文件（脱敏副本不必要：只读不改）
const original = fs.readFileSync(REAL, 'utf8');
const before = parse(original);
const patched = upsertRecord(original, 'llm-pi-ai/xai', entry('acc-1', 'ref-1', 1786000000000));
const after = parse(patched);

check('结果可被 YAML 解析', typeof after === 'object' && after !== null);
check('version 保留', after.version === before.version);
check('新记录写入 records', after.records?.['llm-pi-ai/xai']?.kind === 'grant');
check('payload.type = oauth', after.records?.['llm-pi-ai/xai']?.payload?.type === 'oauth');
check('access 原样', after.records?.['llm-pi-ai/xai']?.payload?.access === 'acc-1');
check('refresh 原样', after.records?.['llm-pi-ai/xai']?.payload?.refresh === 'ref-1');
check('expires 是数字', after.records?.['llm-pi-ai/xai']?.payload?.expires === 1786000000000);

const othersIntact = Object.keys(before.records ?? {})
  .filter((key) => key !== 'llm-pi-ai/xai')
  .every((key) => JSON.stringify(before.records[key]) === JSON.stringify(after.records?.[key]));
check('原有 records 条目未被改动', othersIntact);
check('refs 未被改动', JSON.stringify(before.refs) === JSON.stringify(after.refs));
const expectedKeys = Object.keys(before.records ?? {}).length + (before.records?.['llm-pi-ai/xai'] === undefined ? 1 : 0);
check(
  before.records?.['llm-pi-ai/xai'] === undefined ? '新增键后按键数 +1' : '覆盖已有键时按键数不变',
  Object.keys(after.records).length === expectedKeys,
  `期望 ${expectedKeys}，实际 ${Object.keys(after.records).length}`,
);

// 2. 幂等：再写一次（换 token）应替换而不是追加
const twice = upsertRecord(patched, 'llm-pi-ai/xai', entry('acc-2', 'ref-2', 1790000000000));
const twiceParsed = parse(twice);
check('重复写入不产生重复键', Object.keys(twiceParsed.records).filter((k) => k === 'llm-pi-ai/xai').length === 1);
check('重复写入替换了 access', twiceParsed.records['llm-pi-ai/xai'].payload.access === 'acc-2');
check('重复写入后其它条目仍在', JSON.stringify(twiceParsed.refs) === JSON.stringify(before.refs));

// 3. 没有 records 段的文档
const noRecords = upsertRecord('version: 1\n\nrefs:\n  A: x\n', 'llm-pi-ai/xai', entry('a', 'r', 1));
const nr = parse(noRecords);
check('无 records 段时新建段', nr.records?.['llm-pi-ai/xai']?.kind === 'grant');
check('无 records 段时 refs 保留', nr.refs?.A === 'x');
check('无 records 段时 version 保留', nr.version === 1);

// 4. 特殊字符 token 不破坏 YAML
const weird = upsertRecord(original, 'llm-pi-ai/xai', entry('a"b\\c:d #e', 'r\tx', 5));
check('特殊字符往返一致', parse(weird).records['llm-pi-ai/xai'].payload.access === 'a"b\\c:d #e');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
