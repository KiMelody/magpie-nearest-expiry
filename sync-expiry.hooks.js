// sync-expiry.hooks.js — 由 magpie 插件宿主管理的配额账本同步守护
// 每 30 分钟从 /v1/magpie/quotas 拉全量窗口，压成紧凑结构写入
// 同目录 nearest-expiry.middleware.js 的 AUTO_BOOK 块（mtime 变化触发热重载）。
// 数据形状：data[] = {provider, user, windows:[{name, used, remaining,
//   resetsAt, runsOutAt, runsOut, amount, limit, unit, holdsWhy, display}]}
// 注入结构：{ 账号键: [ {r: unix ms, o?: runsOut}, ... ] }
//   账号键 = 同一 provider 首次出现用裸 provider，其余用 provider@user，
//   与 magpie 的 seat key 对应；策略按精确匹配 + 最长前缀回退查表。
//   r = runsOutAt（真失效批次）优先，否则 resetsAt（到期重置窗）；
//   o = runsOut（过期量），仅 runsOutAt 带；策略按 MIN_RUNSOUT 过滤小批次。
// codearts 的总积分会把已耗尽的限时批次仍算作即将失效，故只认
//   赠送/按需积分包里 remaining>0 的批次；没有有效批次时退回月度重置窗。
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
  const seen = new Set();
  for (const p of data.data) {
    if (!p || typeof p.provider !== 'string') continue;
    // 与 magpie 的 seat key 对齐：同 provider 第一张卡用裸 id，其余用 id@user
    const first = !seen.has(p.provider);
    seen.add(p.provider);
    const key = first || !p.user ? p.provider : `${p.provider}@${p.user}`;
    const windows = p.windows || [];
    let candidates;
    if (p.provider === 'codearts') {
      // 总积分窗口会把已耗尽的签到批次仍算作即将失效；只认限时分桶的剩余量。
      // 限时积分烧完后退回月度重置窗，且不带 o（这不是会作废的批次）。
      const timed = windows.filter((w) => w &&
        (w.name === '赠送积分包' || w.name === '按需积分包') &&
        w.runsOutAt && Number(w.remaining) > 0);
      if (timed.length) {
        candidates = timed.map((w) => ({ at: w.runsOutAt, out: w.runsOut }));
      } else {
        const monthly = windows.find((w) => w && w.name === '基础积分包') ||
                        windows.find((w) => w && w.name === '总积分');
        candidates = monthly && monthly.resetsAt ? [{ at: monthly.resetsAt }] : [];
      }
    } else {
      candidates = windows
        .filter((w) => w && (w.runsOutAt || w.resetsAt))
        .map((w) => ({ at: w.runsOutAt || w.resetsAt, out: w.runsOutAt ? w.runsOut : undefined }));
    }
    const rows = [];
    for (const c of candidates) {
      const ms = Date.parse(c.at);
      if (!Number.isFinite(ms)) continue;
      const dt = ms - now;
      if (dt < MIN_MS || dt > MAX_MS) continue;
      const o = c.out === undefined ? undefined : Number(c.out);
      if (o !== undefined && Number.isFinite(o) && o < MIN_RUNSOUT) continue;
      const row = { r: ms };
      if (o !== undefined && Number.isFinite(o)) row.o = Math.round(o * 100) / 100;
      rows.push(row);
    }
    if (!rows.length) continue;
    // 同一时刻的重复批次去重，保留带 o 的记录
    const byTime = new Map();
    for (const row of rows) {
      const prev = byTime.get(row.r);
      if (!prev || (row.o !== undefined && prev.o === undefined)) byTime.set(row.r, row);
    }
    book[key] = [...byTime.values()].sort((a, b) => a.r - b.r).slice(0, 12);
  }
  const lines = Object.keys(book).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(book[k])},`);
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(5, 16);
  const block = `/*AUTO-BOOK-BEGIN*/\n${lines.join('\n')}\n  // synced ${stamp} UTC by sync-expiry.hooks.js\n/*AUTO-BOOK-END*/`;
  let content;
  try { content = readFileSync(PLUGIN, 'utf8'); } catch (e) { log(`read plugin failed: ${e.message}`); return; }
  const re = /\/\*AUTO-BOOK-BEGIN\*\/[\s\S]*?\/\*AUTO-BOOK-END\*\//;
  if (!re.test(content)) { log('AUTO_BOOK block not found'); return; }
  const next = content.replace(re, block);
  if (next === content) { log(`no change (${lines.length} accounts)`); return; }
  try { atomicWrite(PLUGIN, next); } catch (e) { log(`write failed: ${e.message}`); return; }
  log(`synced: ${lines.length} accounts`);
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
