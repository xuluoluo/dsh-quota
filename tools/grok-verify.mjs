// 验证已写入的 xAI 凭据真的能当 API 凭据用：读记录 -> 打 xAI -> 只打印结论，不打印 token。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 凭据文件是 YAML，解析器用 _ref 下的本地副本（第三方代码，不进仓库）。
let parse;
try {
  ({ parse } = await import('../../../_ref/yaml/dist/index.js'));
} catch {
  console.error('需要 _ref/yaml 里的 YAML 解析器（它读的是你的凭据文件）');
  process.exit(2);
}

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const file = path.join(home, '.credentials.yaml');
const doc = parse(fs.readFileSync(file, 'utf8'));
const record = doc?.records?.['llm-pi-ai/xai'];
if (!record) {
  console.error('没有 llm-pi-ai/xai 记录');
  process.exit(1);
}
const { access, refresh, expires } = record.payload ?? {};
console.log(`记录 kind=${record.kind} type=${record.payload?.type}`);
console.log(`access: ${access ? `${access.slice(0, 10)}… (${access.length} 字符)` : '缺失'}`);
console.log(`refresh: ${refresh ? `存在 (${refresh.length} 字符)` : '缺失'}`);
console.log(`expires: ${expires ? new Date(expires).toLocaleString() : '缺失'} | 现在剩余 ${expires ? Math.round((expires - Date.now()) / 60000) : '?'} 分钟`);
console.log(`其它 records 仍在: ${Object.keys(doc.records).join(', ')}`);

const auth = { Authorization: `Bearer ${access}` };

const models = await fetch('https://api.x.ai/v1/models', { headers: auth });
console.log(`\nGET /v1/models -> HTTP ${models.status}`);
if (models.ok) {
  const body = await models.json();
  const ids = (body.data ?? []).map((m) => m.id);
  console.log(`可见模型 ${ids.length} 个: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ' …' : ''}`);
} else {
  console.log((await models.text()).slice(0, 400));
}

if (process.argv.includes('--chat')) {
  const started = Date.now();
  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4.6',
      input: [{ role: 'user', content: '用一句中文回答：你能收到这条消息吗？' }],
      max_output_tokens: 64,
    }),
  });
  console.log(`\nPOST /v1/responses (grok-4.6) -> HTTP ${response.status}  ${Date.now() - started}ms`);
  const text = await response.text();
  if (response.ok) {
    const body = JSON.parse(text);
    const said = body.output_text
      ?? (body.output ?? []).flatMap((item) => item.content ?? []).map((c) => c.text ?? '').join('');
    console.log(`模型回答: ${String(said).trim().slice(0, 200)}`);
    console.log(`usage: ${JSON.stringify(body.usage ?? {})}`);
  } else {
    console.log(text.slice(0, 600));
  }
}
