// sync-expiry.hooks.js — 由 magpie 插件宿主管理的配额账本同步守护
// 每 5 分钟从 /v1/magpie/quotas 拉全量窗口，压成紧凑结构写入
// 同目录 nearest-expiry.middleware.js 的 AUTO_BOOK 块（mtime 变化触发热重载）。
// 数据形状：data[] = {provider, user, windows:[{name, used, remaining,
//   resetsAt, runsOutAt, runsOut, amount, limit, unit, holdsWhy, display}]}
// 注入结构：{ 账号键: [ {r: unix ms, o?: runsOut, d?: 1} | {x: 1}, ... ] }
//   账号键 = 同一 provider 首次出现用裸 provider，其余用 provider@user，
//   与 magpie 的 seat key 对应；策略按精确匹配 + 最长前缀回退查表。
//   r = runsOutAt（真失效批次）优先，否则 resetsAt（到期重置窗）；
//   o = runsOut（过期量），仅 runsOutAt 带；策略按 MIN_RUNSOUT 过滤小批次。
//   d = 每日签到限额：供应商给的是 resetsAt，但它当天作废而非重置，
//       打标记让同步侧豁免 2h 保护、策略侧豁免 skipMs；已烧完的不进账本。
//   x = 耗尽占位：账号没有任何会作废/会到期的窗口时写入，显式标记它当前
//       没有临期资格。账本保持命中以屏蔽 seat 里滞后的 soon/lapse，但不提供
//       排序用的到期时间，账号自然回落到后段。
// codearts 的限时批次由 runsOutAt/runsOut 表达，批次剩余不足阈值时视为
//   已经烧完，直接写耗尽占位；不再退回月度 resetting 窗口，也不再依赖
//   display 文案。阈值留一点余量，避免小额尾量把账号挂在第一档，在
//   stays=turn 下反复粘住请求、转而消耗长时效赠送额度。
// opencode-go 月窗剩余不足 20% 时剔除周窗排序键：周窗是重置型，到点刷新，
//   但把它作为排序键会把账号顶到第一档、提前烧掉月窗余额；剔除后让位给
//   真正临期作废的账号。月窗重置后 remaining 回到 100%，规则自动失效。
// 只保留 2h 之后、30d 之内的窗口；已过期/追不上的丢弃。
// 相对当前时间计算的短速率窗每次读数都会给出新时间戳，会让账本反复变化、
// 每次改写源码都热重载并清空策略里的轮换游标，故按窗口名称排除。
// r 按 5 分钟对齐、o 取整，进一步容忍供应商读数抖动。写入前再做排序等价
// 比较：o/d 的数值变化不改变排序（策略只用 r 时刻与存在性）时跳过重写，
// 轮换游标不再被频繁热重载清零。
const ROUND_MS = 5 * 60 * 1000;
const SHORT_WINDOW = /5\s*(hours|hour|h|小时)/i;
const DAILY_WINDOW = /每日签到|今日积分/;
// 导出的 onRequest 是空操作直通，仅用于让宿主识别并常驻本模块 —— 定时器在模块顶层。
import { createHmac } from 'node:crypto';
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
const MAGPIE_DIR = join(homedir(), '.config', 'magpie');
const DATA_DIR = join(MAGPIE_DIR, 'nearest-expiry');
const LOG = join(DATA_DIR, 'sync-expiry.log');
const INTERVAL = 5 * 60 * 1000;
const QUOTAS_URL = 'http://127.0.0.1:3425/v1/magpie/quotas';
const REF_KEY_PATH = join(MAGPIE_DIR, 'account-ref.key');
const PROVIDERS_PATH = join(MAGPIE_DIR, 'providers.json');
const ROUTING_ID = 'nearest-expiry/nearest-expiry';
// 与 magpie 源码 internal/middleware/account.go 的 accountRef 完全一致：
// HMAC-SHA256(key, "magpie account ref v1\0" + name + "\0" + agent + "\0"
//   + lower(user) + "\0" + lower(plan) + "\0")[:16] 的 hex。
// name = plugin.Name(spec)，git spec 且配置根无 package.json 时为 spec 原样；
// agent = 插件账号固定 "plugin"；user/plan 取自 quotas。
const REF_AGENT = 'plugin';
// plugin.Name(spec)：git spec 且配置根无 package.json 时为 spec 原样。
// 从 plugins.json 读出本插件的 spec，避免把仓库路径写死在源码里。
function pluginSpec() {
  try {
    const d = JSON.parse(readFileSync(join(MAGPIE_DIR, 'plugins.json'), 'utf8'));
    const list = Array.isArray(d.plugins) ? d.plugins : [];
    for (const p of list) {
      if (typeof p.spec === 'string' && p.spec.indexOf('magpie-nearest-expiry') >= 0) return p.spec;
    }
  } catch {}
  return '';
}
// magpie 的 plugin.Name(spec)：实测安装后为 package.json 的 name
// （middleware-nearest-expiry），而非 git spec。优先读安装目录的 name，
// 与 magpie 运行时一致；读不到再回退到 spec。
function refName() {
  try {
    const pj = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
    if (pj.name) return pj.name;
  } catch {}
  return pluginSpec();
}
const MIN_RUNSOUT = 10;
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
      // 0.3.25 起厂商把 runsOutAt/runsOut 挪到「总积分」上，分项桶只作 aside。
      // 月度「总积分/基础积分包」当月用完即作废（用户确认），按作废余额处理：
      // 用 resetsAt 作到期键、remaining 当作废量(o)，让它进第一档优先烧。
      // 同时保留对 runsOutAt 真批次的识别（若插件版本又变化）。
      const monthly = windows.filter((w) => w &&
          (w.name === '总积分' || w.name === '基础积分包') &&
          w.resetsAt && Number(w.remaining) > 0);
      const batches = windows.filter((w) => w &&
          (w.name === '赠送积分包' || w.name === '按需积分包' || w.name === '总积分') &&
          w.runsOutAt && Number(w.runsOut) >= MIN_RUNSOUT && Number(w.remaining) > 0);
      const merged = [
        ...batches.map((w) => ({ at: w.runsOutAt, out: w.runsOut })),
        ...monthly.map((w) => ({ at: w.resetsAt, out: w.remaining })),
      ];
      // 同一到期时刻去重（总积分可能同时带 runsOutAt 与 resetsAt），
      // 优先保留带作废量 out 的那条。
      candidates = [];
      for (const c of merged) {
        const dup = candidates.findIndex((x) => x.at === c.at);
        if (dup < 0) { candidates.push(c); continue; }
        if (c.out !== undefined && candidates[dup].out === undefined) candidates[dup] = c;
      }
    } else {
      // opencode-go 的月窗剩余不足 20% 时剔除周窗排序键：周窗是重置型（到点刷新），
      // 但把账号顶到第一档会提前烧掉月窗余额；此时让位给真正临期作废的账号。
      // 月窗重置后 remaining 回到 100%，规则自动失效。
      const monthWindow = p.provider === 'opencode-go' &&
        windows.find((w) => w && /month/i.test(String(w.name || '')));
      const skipWeekly = !!monthWindow && Number(monthWindow.remaining) <= 20;
      candidates = windows
        .filter((w) => {
          if (!w || !(w.runsOutAt || w.resetsAt)) return false;
          const name = String(w.name || '');
          if (SHORT_WINDOW.test(name)) return false;
          if (skipWeekly && /7\s*days/i.test(name)) return false;
          // 烧完（remaining=0）的重置窗没有可消耗的额度，按耗尽处理，写 x 占位；
          // 每日签到额度烧完后同理，不再占第一档。
          if (!w.runsOutAt && Number(w.remaining) === 0) return false;
          return true;
        })
        .map((w) => {
          const name = String(w.name || '');
          // opencode-go Month 当月作废（用户确认），用 remaining 当作废量(o)，
          // 让它进第一档优先烧；7 days 标记为 weak，同刻到期时排其他供应商后。
          const isMonth = p.provider === 'opencode-go' && /^month$/i.test(name);
          const is7d = p.provider === 'opencode-go' && /7\s*days/i.test(name);
          return {
            at: w.runsOutAt || w.resetsAt,
            out: w.runsOutAt ? w.runsOut : (isMonth ? w.remaining : undefined),
            weak: is7d ? 1 : undefined,
            // 每日签到限额给的是 resetsAt，语义上却是当天作废；仅对仍有余额的
            // 重置型窗口打标记，让下游按会作废处理，不与真失效批次混拼。
            daily: !w.runsOutAt && DAILY_WINDOW.test(name) && Number(w.remaining) > 0,
          };
        });
    }
    const rows = [];
    for (const c of candidates) {
      const ms = Date.parse(c.at);
      if (!Number.isFinite(ms)) continue;
      const dt = ms - now;
      if (dt > MAX_MS) continue;
      const o = c.out === undefined ? undefined : Number(c.out);
      if (o !== undefined && Number.isFinite(o) && o < MIN_RUNSOUT) continue;
      // 真失效批次(o)与每日签到窗(d)豁免 MIN_MS：临近失效时仍要保留，
      // 否则会从账本消失。重置型短窗仍需过 2h 保护，避免计数器/速率窗抢排序。
      if (dt < MIN_MS && !c.daily && (o === undefined || !Number.isFinite(o))) continue;
      const row = { r: ms };
      if (o !== undefined && Number.isFinite(o)) row.o = Math.round(o * 100) / 100;
      if (c.daily) row.d = 1;
      if (c.weak) row.w = 1;
      rows.push(row);
    }
    // 没有会作废/会到期的窗口时显式写耗尽占位：保持账本命中（屏蔽 seat 里
    // 滞后的 soon/lapse），但不给排序用的到期时间，账号回落到后段。
    if (!rows.length) { book[key] = [{ x: 1 }]; continue; }
    // 同一时刻的重复批次去重，优先保留信息量更大的记录；r 对齐到 5 分钟、o 取整
    const weight = (r) => (r.d ? 2 : 0) + (r.o !== undefined ? 1 : 0);
    const byTime = new Map();
    for (const row of rows) {
      row.r = Math.floor(row.r / ROUND_MS) * ROUND_MS;
      if (row.o !== undefined) row.o = Math.round(row.o);
      const prev = byTime.get(row.r);
      if (!prev || weight(row) > weight(prev)) byTime.set(row.r, row);
    }
    book[key] = [...byTime.values()].sort((a, b) => a.r - b.r).slice(0, 12);
  }
  const lines = Object.keys(book).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(book[k])},`);
  // 空响应守卫：0 个有效账号时不写账本，避免一次刷新失败把已有账本清空。
  if (!lines.length) { log('no accounts, keep ledger'); return; }
  // 生成跳过名单：只含 nearest-expiry 组里、限时额度已烧完（账本 x 占位）的账号。
  // 整组耗尽时清空，避免所有候选被 skip 导致请求失败。
  const skipRefs = buildSkipRefs(data.data, book);
  const skipBlock = `/*AUTO-SKIP-BEGIN*/\n  "refs": ${JSON.stringify(skipRefs)}\n/*AUTO-SKIP-END*/`;
  // 块内不含时间戳：数据不变时 next === content，避免每次同步都热重载清零策略状态。
  const block = `/*AUTO-BOOK-BEGIN*/\n${lines.join('\n')}\n/*AUTO-BOOK-END*/`;
  let content;
  try { content = readFileSync(PLUGIN, 'utf8'); } catch (e) { log(`read plugin failed: ${e.message}`); return; }
  const re = /\/\*AUTO-BOOK-BEGIN\*\/[\s\S]*?\/\*AUTO-BOOK-END\*\//;
  const skipRe = /\/\*AUTO-SKIP-BEGIN\*\/[\s\S]*?\/\*AUTO-SKIP-END\*\//;
  if (!re.test(content) || !skipRe.test(content)) { log('AUTO blocks not found'); return; }
  const bookSame = sameOrdering(parseBlock(content), book);
  const skipSame = parseSkip(content) === JSON.stringify(skipRefs);
  if (bookSame && skipSame) { log(`no change (${lines.length} accounts)`); return; }
  // 只有其中一个块变化时也写：整体替换 content，两个块都用新内容。
  let next = content;
  if (!bookSame) next = next.replace(re, block);
  if (!skipSame) next = next.replace(skipRe, skipBlock);
  try { atomicWrite(PLUGIN, next); } catch (e) { log(`write failed: ${e.message}`); return; }
  log(`synced: ${lines.length} accounts, skip=${skipRefs.length}`);
}

// 提取排序语义签名：r 时刻精确比较；o/d/x 只看存在性，数值不参与排序。
// magpie 的账号匿名 ref：与 internal/middleware/account.go 的 accountRef 一致。
// 读不到 key 时返回 null（首次 onAccount 触发前 key 尚未生成，下一轮再算）。
function readRefKey() {
  try {
    const hex = readFileSync(REF_KEY_PATH, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    return buf.length === 32 ? buf : null;
  } catch { return null; }
}
function accountRef(key, user, plan) {
  const mac = createHmac('sha256', key);
  for (const s of ['magpie account ref v1', refName(), REF_AGENT, String(user).toLowerCase(), String(plan || '').toLowerCase()]) {
    mac.update(Buffer.from(s, 'utf8'));
    mac.update(Buffer.from([0]));
  }
  return mac.digest('hex').slice(0, 32);
}

// nearest-expiry 组列表：每组含成员 provider 集合。member 形如
// "officeace/deepseek-v4.1-flash"，取 provider id 部分。
function nearestGroups() {
  const groups = [];
  try {
    const d = JSON.parse(readFileSync(PROVIDERS_PATH, 'utf8'));
    for (const g of (Array.isArray(d.groups) ? d.groups : [])) {
      if (g.routing !== ROUTING_ID) continue;
      const providers = new Set();
      for (const m of (Array.isArray(g.members) ? g.members : [])) {
        if (typeof m === 'string' && m.indexOf('/') > 0) providers.add(m.slice(0, m.indexOf('/')));
      }
      if (providers.size) groups.push(providers);
    }
  } catch {}
  return groups;
}

// 解析现有 skip 块，供等价判断使用
function parseSkip(text) {
  const m = text.match(/\/\*AUTO-SKIP-BEGIN\*\/([\s\S]*?)\/\*AUTO-SKIP-END\*\//);
  if (!m) return null;
  try { return JSON.stringify(JSON.parse(`{${m[1].trim().replace(/,$/, '')}}`).refs || []); } catch { return null; }
}

// 生成要跳过的账号 ref。dataRows 是 /v1/magpie/quotas 的 data[]，book 是本次账本。
// 只处理账本写 x（限时额度烧完）且属于 nearest-expiry 组的账号。
function buildSkipRefs(dataRows, book) {
  const key = readRefKey();
  if (!key) { log('ref key not ready, skip list empty'); return []; }
  const groups = nearestGroups();
  if (!groups.length) return [];
  const nearestSet = new Set();
  for (const g of groups) for (const p of g) nearestSet.add(p);
  // 收集每个 provider 的账号：user -> plan
  const accounts = [];
  for (const row of (Array.isArray(dataRows) ? dataRows : [])) {
    const p = String(row.provider || '');
    if (!nearestSet.has(p)) continue;
    accounts.push({ provider: p, user: row.user, plan: row.plan });
  }
  // 账本键对应规则与 sync 写账本时一致：同 provider 第一个账号用裸 id，
  // 其余用 provider@user。裸键只属于第一个账号，不能套到所有账号上。
  const firstSeen = new Set();
  const accountKeys = [];
  for (const a of accounts) {
    const first = !firstSeen.has(a.provider);
    firstSeen.add(a.provider);
    accountKeys.push({ a, keys: first || !a.user ? [a.provider] : [`${a.provider}@${a.user}`] });
  }
  const exhaustedKeys = new Set();
  for (const k of Object.keys(book)) {
    const rows = book[k];
    if (Array.isArray(rows) && rows.length === 1 && rows[0] && rows[0].x === 1) exhaustedKeys.add(k);
  }
  const isExhausted = (ak) => ak.keys.some((k) => exhaustedKeys.has(k));
  const kept = [];
  for (const ak of accountKeys) {
    if (!isExhausted(ak)) continue;
    // 该账号所在的组里若还有别的非耗尽账号，就正常 skip。
    // 只有当它所在的每一个组都全耗尽（组里所有 provider 的所有账号都耗尽），
    // 才不 skip 它，避免整组无候选时请求失败。
    const inGroups = groups.filter((g) => g.has(ak.a.provider));
    const hasAlternative = inGroups.some((g) => accountKeys.some((other) =>
      other !== ak && g.has(other.a.provider) && !isExhausted(other)));
    if (hasAlternative || inGroups.length === 0) kept.push(accountRef(key, ak.a.user, ak.a.plan));
  }
  return [...new Set(kept)];
}

function orderingSig(rows) {
  const parts = [];
  for (const row of rows) {
    if (row && row.x !== undefined) { parts.push('x'); continue; }
    if (!row || typeof row.r !== 'number') { parts.push('?'); continue; }
    parts.push(`${row.r}:${row.o !== undefined ? 'o' : '-'}${row.d !== undefined ? 'd' : '-'}`);
  }
  return parts.join('|');
}

function parseBlock(text) {
  const m = text.match(/\/\*AUTO-BOOK-BEGIN\*\/([\s\S]*?)\/\*AUTO-BOOK-END\*\//);
  if (!m) return null;
  try { return JSON.parse(`{${m[1].trim().replace(/,$/, '')}` + '}'); } catch { return null; }
}

function sameOrdering(oldBook, nextBook) {
  if (!oldBook) return false;
  const ka = Object.keys(oldBook);
  const kb = Object.keys(nextBook);
  if (ka.length !== kb.length) return false;
  for (const k of kb) {
    if (!(k in oldBook)) return false;
    if (orderingSig(oldBook[k]) !== orderingSig(nextBook[k])) return false;
  }
  return true;
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
