// sync-expiry.hooks.js — 由 magpie 插件宿主管理的配额账本同步守护
// 每 30 分钟从 /v1/magpie/quotas 拉全量窗口，压成紧凑结构写入
// 同目录 nearest-expiry.middleware.js 的 AUTO_BOOK 块（mtime 变化触发热重载）。
// 数据形状：data[] = {provider, user, windows:[{name, used, remaining,
//   resetsAt, runsOutAt, runsOut, amount, limit, unit, holdsWhy, display}]}
// 注入结构：{ provider前缀: [ {r: unix ms, o?: runsOut}, ... ] }
//   r = runsOutAt（真失效批次）优先，否则 resetsAt（到期重置窗）；
//   o = runsOut（过期量），仅 runsOutAt 带；策略按 MIN_RUNSOUT 过滤小批次。
// 只保留 2h 之后、30d 之内的窗口；已过期/追不上的丢弃。
// 导出的 onRequest 是空操作直通，仅用于让宿主识别并常驻本模块 —— 定时器在模块顶层。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(DIR, 'nearest-expiry.middleware.js');
const DATA_DIR = join(homedir(), '.config', 'magpie', 'nearest-expiry');
const LOG = join(DATA_DIR, 'sync-expiry.log');
const INTERVAL = 30 * 60 * 1000;
const QUOTAS_URL = 'http://127.0.0.1:3425/v1/magpie/quotas';
const MIN_RUNSOUT = 20;
const MIN_MS = 2 * 3600 * 1000;
const MAX_MS = 30 * 86400 * 1000;

function ensureDataDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function log(line) {
  ensureDataDir();
  try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {}
}

// 原子替换入口文件：避免就地写入穿透 github: 安装目录里的硬链接，污染 bun 缓存副本。
// 热重载仍由 middleware 入口文件的 mtime/size 变化触发。
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

async function fetchQuotas() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(QUOTAS_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) { log(`quotas http ${res.status}`); return null; }
    return await res.json();
  } catch (e) { log(`quotas fetch failed: ${e.message}`); return null; }
}

async function sync() {
  const data = await fetchQuotas();
  if (!data || !Array.isArray(data.data)) return;
  const now = Date.now();
  const book = {};
  for (const p of data.data) {
    if (!p || typeof p.provider !== 'string') continue;
    const rows = [];
    for (const w of p.windows || []) {
      if (!w) continue;
      const isExpiry = !!w.runsOutAt;
      const raw = isExpiry ? w.runsOutAt : w.resetsAt;
      if (!raw) continue;
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) continue;
      const dt = ms - now;
      if (dt < MIN_MS || dt > MAX_MS) continue;
      const o = isExpiry ? Number(w.runsOut) : undefined;
      if (isExpiry && Number.isFinite(o) && o < MIN_RUNSOUT) continue;
      const row = { r: ms };
      if (isExpiry && Number.isFinite(o)) row.o = Math.round(o * 100) / 100;
      rows.push(row);
    }
    if (rows.length) {
      // 同一 provider 可能有多个账号，必须合并不能覆盖
      if (!book[p.provider]) book[p.provider] = [];
      book[p.provider].push(...rows);
    }
  }
  for (const k of Object.keys(book)) {
    book[k].sort((a, b) => a.r - b.r);
    book[k] = book[k].slice(0, 12); // 控体积，留足多账号窗口
  }
  const lines = Object.keys(book).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(book[k])},`);
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(5, 16);
  const block = `/*AUTO-BOOK-BEGIN*/\n${lines.join('\n')}\n  // synced ${stamp} UTC by sync-expiry.hooks.js\n/*AUTO-BOOK-END*/`;
  let content;
  try { content = readFileSync(PLUGIN, 'utf8'); } catch (e) { log(`read plugin failed: ${e.message}`); return; }
  const re = /\/\*AUTO-BOOK-BEGIN\*\/[\s\S]*?\/\*AUTO-BOOK-END\*\//;
  if (!re.test(content)) { log('AUTO_BOOK block not found'); return; }
  const next = content.replace(re, block);
  if (next === content) { log(`no change (${lines.length} providers)`); return; }
  try { atomicWrite(PLUGIN, next); } catch (e) { log(`write failed: ${e.message}`); return; }
  log(`synced: ${lines.length} providers`);
}

let busy = false;
const run = async () => {
  if (busy) return;
  busy = true;
  try { await sync(); } catch (e) { log(`error: ${e.message}`); } finally { busy = false; }
};
setTimeout(run, 5 * 1000); // 加载后 5s 先跑一次
setInterval(run, INTERVAL);

export async function onRequest() { return undefined; }
