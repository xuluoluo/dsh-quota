// Minimal asar reader: list [prefix] | extract <prefix> <dest> | cat <path>
import fs from 'node:fs';
import path from 'node:path';

const ASAR = process.env.ASAR ?? 'C:\\Users\\luo\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

const fd = fs.openSync(ASAR, 'r');
const sizeBuf = Buffer.alloc(8);
fs.readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const rawHeader = headerBuf.toString('utf8');
const start = rawHeader.indexOf('{');
let depth = 0;
let inString = false;
let escaped = false;
let end = -1;
for (let i = start; i < rawHeader.length; i++) {
  const ch = rawHeader[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') inString = false;
    continue;
  }
  if (ch === '"') inString = true;
  else if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const header = JSON.parse(rawHeader.slice(start, end));
const dataOffset = 8 + headerSize;

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: Number(entry.offset), unpacked: entry.unpacked });
  }
}

const all = [];
walk(header, '', all);

const cmd = process.argv[2];
if (cmd === 'list') {
  const filter = process.argv[3];
  const depthArg = process.argv[4];
  let rows = all.filter((e) => !filter || e.path.startsWith(filter));
  if (depthArg === 'shallow') {
    const base = (filter ?? '').replace(/\/+$/, '');
    const seen = new Map();
    for (const r of rows) {
      const rest = r.path.slice(base ? base.length + 1 : 0);
      const [head, ...tail] = rest.split('/');
      const key = tail.length ? `${head}/` : head;
      const prev = seen.get(key) ?? { size: 0, count: 0, dir: tail.length > 0 };
      seen.set(key, { size: prev.size + r.size, count: prev.count + 1, dir: prev.dir || tail.length > 0 });
    }
    for (const [k, v] of [...seen].sort()) {
      console.log(`${v.dir ? 'DIR ' : '    '}${String(v.count).padStart(6)}  ${String(v.size).padStart(10)}  ${k}`);
    }
    console.log(`# total=${all.length} matched=${rows.length}`);
  } else {
    for (const r of rows) console.log(`${String(r.size).padStart(9)}  ${r.unpacked ? 'U ' : '  '}${r.path}`);
    console.log(`# total=${all.length} matched=${rows.length}`);
  }
} else if (cmd === 'extract') {
  const prefix = process.argv[3];
  const dest = process.argv[4];
  const rows = all.filter((e) => e.path.startsWith(prefix));
  let n = 0;
  for (const r of rows) {
    const target = path.join(dest, r.path.slice(prefix.length).replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (r.unpacked) {
      const src = path.join(path.dirname(ASAR), 'app.asar.unpacked', r.path);
      if (fs.existsSync(src)) fs.copyFileSync(src, target);
      continue;
    }
    const buf = Buffer.alloc(r.size);
    fs.readSync(fd, buf, 0, r.size, dataOffset + r.offset);
    fs.writeFileSync(target, buf);
    n++;
  }
  console.log(`extracted ${n} packed files under ${dest}`);
} else if (cmd === 'cat') {
  const r = all.find((e) => e.path === process.argv[3]);
  if (!r) { console.error('not found'); process.exit(1); }
  const buf = Buffer.alloc(r.size);
  fs.readSync(fd, buf, 0, r.size, dataOffset + r.offset);
  process.stdout.write(buf);
}
