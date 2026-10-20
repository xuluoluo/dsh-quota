#!/usr/bin/env node
/**
 * grok-login.mjs — 用 SuperGrok / X Premium 订阅登录 xAI，并把授权写进 DSH 的凭据库。
 *
 * 流程与 DSH 内置的 pi-ai xAI 登录完全一致（同一个 client_id、同一套 scope、
 * 同一条 device-code 端点），只是把「点一次 GUI 按钮」换成了命令行，
 * 因此适用于：
 *   - GUI 里没有暴露 pi-ai provider 登录入口的版本；
 *   - 远程 / headless 机器上想先把凭据放好。
 *
 * 写入位置：<dsh home>/.credentials.yaml 的 records["llm-pi-ai/xai"]，
 * 记录形状 { kind: grant, payload: { type: oauth, access, refresh, expires } }
 * 与 dsh-llm-pi-ai 自己写入的完全一致（见 packages/llm/llm-pi-ai/src/auth.ts）。
 * 该文件被 dsh-credentials-local 监视，改完自动热加载，不需要重启 DSH。
 *
 * 用法：
 *   node grok-login.mjs                # 开始设备码登录并等待你在浏览器里确认
 *   node grok-login.mjs --no-open      # 不自动打开浏览器
 *   node grok-login.mjs --print-only   # 只走登录流程并打印 token，不写凭据文件
 *   node grok-login.mjs --dsh-home DIR # 覆盖 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const RECORD_KEY = 'llm-pi-ai/xai';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

function dshHome() {
  const override = option('dsh-home', undefined);
  if (override) return override;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  let body = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch {
    throw new Error(`${url} returned invalid JSON (HTTP ${response.status})`);
  }
  return { ok: response.ok, status: response.status, body };
}

const need = (body, field) => {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`xAI OAuth response missing ${field}`);
  return value;
};

function credentialsFromToken(body, previousRefresh) {
  const access = need(body, 'access_token');
  const refresh = body.refresh_token === undefined && previousRefresh ? previousRefresh : need(body, 'refresh_token');
  const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return { type: 'oauth', access, refresh, expires: Date.now() + lifetime * 1000 - REFRESH_SKEW_MS };
}

async function deviceLogin({ autoOpen }) {
  const started = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE, referrer: 'pi' });
  if (!started.ok) {
    const detail = [started.body.error, started.body.error_description].filter(Boolean).join(': ');
    throw new Error(`device authorization failed (HTTP ${started.status})${detail ? `: ${detail}` : ''}`);
  }
  // 以 verification_uri_complete 优先：链接自带 user_code，浏览器里只差一次「确认」。
  const uri = typeof started.body.verification_uri_complete === 'string' && started.body.verification_uri_complete
    ? started.body.verification_uri_complete
    : need(started.body, 'verification_uri');
  const device = {
    deviceCode: need(started.body, 'device_code'),
    userCode: need(started.body, 'user_code'),
    interval: typeof started.body.interval === 'number' && started.body.interval > 0 ? started.body.interval : 5,
    expiresIn: typeof started.body.expires_in === 'number' ? started.body.expires_in : 1800,
  };

  console.log('');
  console.log('  在浏览器打开下面这个地址（已带 user_code）：');
  console.log(`    ${uri}`);
  console.log('');
  console.log(`  如果需要手动输入，码是：${device.userCode}`);
  console.log(`  有效期 ${Math.round(device.expiresIn / 60)} 分钟，过期就重新跑一次。`);
  console.log('');
  if (autoOpen && openBrowser(uri)) console.log('  已尝试自动打开浏览器；没弹出来就手动点上面的链接。');
  console.log('  等待你在浏览器里确认……');

  const deadline = Date.now() + device.expiresIn * 1000;
  let intervalMs = device.interval * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const polled = await postForm(TOKEN_URL, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: device.deviceCode,
    });
    if (polled.ok) return credentialsFromToken(polled.body);
    const error = polled.body.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      const next = polled.body.interval;
      intervalMs = (typeof next === 'number' && next > 0 ? next : device.interval + 5) * 1000;
      continue;
    }
    if (error === 'access_denied' || error === 'authorization_denied') throw new Error('你在浏览器里拒绝了这次授权');
    if (error === 'expired_token') throw new Error('设备码已过期，重新跑一次本命令');
    const detail = [error, polled.body.error_description].filter(Boolean).join(': ');
    throw new Error(`token polling failed (HTTP ${polled.status})${detail ? `: ${detail}` : ''}`);
  }
  throw new Error('设备码已过期，重新跑一次本命令');
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const yamlString = (value) => JSON.stringify(String(value));

/**
 * 在文档文本里就地 upsert `records.<key>`。
 * 只用行级手术，保留注释、字段顺序和其它条目；CBOR/YAML 语义交给 dsh 自己解析。
 */
function upsertRecord(text, key, entryLines) {
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const block = [`  ${key}:`, ...entryLines];

  const recIdx = lines.findIndex((line) => /^records:\s*$/.test(line));
  if (recIdx === -1) {
    // 没有 records 段：在文件末尾追加（version 段之后）。
    lines.push('', 'records:', ...block);
    return lines.join('\n') + '\n';
  }

  const entryRe = new RegExp(`^ {2}${escapeRe(key)}:\\s*$`);
  const start = lines.findIndex((line, index) => index > recIdx && entryRe.test(line));
  if (start !== -1) {
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s{3,}/.test(lines[end]))) end += 1;
    while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
    lines.splice(start, end - start, ...block);
    return lines.join('\n') + (hasTrailingNewline ? '\n' : '');
  }

  let insert = recIdx + 1;
  for (let i = recIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) { insert = i + 1; continue; }
    break;
  }
  lines.splice(insert, 0, ...block);
  return lines.join('\n') + (hasTrailingNewline ? '\n' : '');
}

function writeRecord(credentials) {
  const home = dshHome();
  const file = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(file)) throw new Error(`凭据文件不存在：${file}（先启动一次 DSH，让它创建该文件；或用 --dsh-home 指定目录）`);
  const before = fs.readFileSync(file, 'utf8');
  if (!/^version:\s*1\s*$/m.test(before)) {
    throw new Error('凭据文件不是 version: 1 的文档，拒绝改写（避免覆盖非预期内容）');
  }
  const entry = [
    '    kind: grant',
    '    payload:',
    '      type: oauth',
    `      access: ${yamlString(credentials.access)}`,
    `      refresh: ${yamlString(credentials.refresh)}`,
    `      expires: ${credentials.expires}`,
  ];
  const after = upsertRecord(before, RECORD_KEY, entry);
  if (after === before) throw new Error('写入没有产生变化，已放弃');
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, after, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { file, backup };
}

async function main() {
  try {
    const credentials = await deviceLogin({ autoOpen: !flag('no-open') });
    console.log('');
    console.log(`  登录成功，access token 前缀：${credentials.access.slice(0, 12)}…`);
    console.log(`  refresh token：${credentials.refresh ? '已拿到' : '缺失'}`);
    console.log(`  过期时间：${new Date(credentials.expires).toLocaleString()}`);
    if (flag('print-only')) {
      console.log(JSON.stringify(credentials, null, 2));
    } else {
      const { file } = writeRecord(credentials);
      console.log('');
      console.log(`  已写入 ${file} 的 records["${RECORD_KEY}"]。`);
      console.log('  dsh-credentials-local 会自动热加载；回到 DSH 里选 grok 模型即可。');
    }
    process.exit(0);
  } catch (error) {
    console.error('');
    console.error(`  失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { upsertRecord, writeRecord, deviceLogin };

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
