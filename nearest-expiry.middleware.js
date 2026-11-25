// magpie 路由策略：nearest-expiry —— 会作废的额度最先烧。
// 同刻时优先有峰谷价的供应商（低谷期省成本）；高峰降权把这类供应商推后。
// peakPricing 取 magpie 官方 4 类 + 单独维护的 workbuddy，可用 options 覆盖。
// 精确到期时刻升序 → 同一时刻：有峰谷价者优先 → 再按 used 决胜
//       → 无到期数据的（无期限额度）垫后 → resting/已用尽（used>=98）垫底。
//       30 天外的窗口按无到期数据处理，长时效额度不抢第一档；used>=98 但账本
//       仍有 30 天内会作废的批次或 48h 内到期的窗口时豁免 spent，先把临期额烧完。
// options.timeRules 可按供应商前缀在指定时段降权（软降权，排到同组末尾仍可兜底）；
//       有效排序键按 UTC+8 自然日算 4 天内到期的账号豁免降权，保持正常使用。
//       默认 workbuddy 每天 08:30-22:00，opencode-go 工作日 09:00-12:00、14:00-18:00。
// options.peakPricing 列出有峰谷价的供应商（默认官方 4 类 + workbuddy）；同刻到期时
//       这类供应商优先，用于低谷期多用按峰谷计费的额度，不越过更早到期的账号。
// 数据面：seatJSON 只有 9 个字段（soon 只说何时重置、不说烧它消耗什么），
//   故由 sync-expiry.hooks.js 定时把 /v1/magpie/quotas 的全量窗口账本注入 AUTO_BOOK：
//   真实失效批次（runsOutAt/runsOut）自动升档；计数器型短窗仍靠 FIXES 跳过。
// seat 字段（points.go seatJSON）：{ key, account, known, learns, used, soon[], pace, weight, resting, tokens }
// 返回：seats 的索引排列，只定顺序；候选集、rest、failover 仍由 magpie 核心处理。

const SOON_SKIP = 2 * 3600 * 1000; // 默认忽略 2 小时内到期的窗口（判定为重置型）
const MIN_RUNSOUT = 10; // 小于此量的过期批次按已烧完处理，避免尾量被粘性反复消耗
const HORIZON_MS = 30 * 86400 * 1000; // 30 天外的长时效窗口不参与第一档，避免快用完的账号被拉到前面
const URGENT_MS = 48 * 3600 * 1000; // 48h 内到期的窗口（含 d 签到）与 o 批次一样豁免 spent
const BAND_MS = 5 * 60 * 1000; // 到期时间相差 5 分钟内视作同一档，档内轮换
const TZ8_MS = 8 * 3600 * 1000; // UTC+8 偏移
// 前缀边界匹配：workbuddy 不能误伤 workbuddy-ai；key 为前缀本身或前缀后跟 @/: 才算命中
function prefixHit(key, prefix) {
  if (typeof key !== 'string' || typeof prefix !== 'string' || !prefix) return false;
  if (key === prefix) return true;
  return key.indexOf(prefix) === 0 && (key[prefix.length] === '@' || key[prefix.length] === '/');
}
// 解析 HH:MM 为当天的分钟数
function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return -1;
  const h = Number(m[1]); const mi = Number(m[2]);
  return (h >= 0 && h < 24 && mi >= 0 && mi < 60) ? h * 60 + mi : -1;
}
// 当前是否落在规则配置的降权时段（UTC+8，左闭右开）
function inWindow(local, rule) {
  const days = rule.days;
  if (Array.isArray(days) && days.length && days.indexOf(local.day) < 0) return false;
  const wins = rule.windows;
  if (!Array.isArray(wins) || !wins.length) return false;
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    if (!Array.isArray(w) || w.length < 2) continue;
    const from = hhmm(w[0]); const to = hhmm(w[1]);
    if (from < 0 || to < 0) continue;
    if (local.min >= from && local.min < to) return true;
  }
  return false;
}
// UTC+8 自然日的天数差（target - today），只按日期取整，不看时刻
function dayDiff8(now, targetMs) {
  if (!(now > 0) || !(targetMs > 0)) return 9999;
  try {
    const today = new Date(now + TZ8_MS);
    const tgt = new Date(targetMs + TZ8_MS);
    const y0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const y1 = Date.UTC(tgt.getUTCFullYear(), tgt.getUTCMonth(), tgt.getUTCDate());
    return Math.round((y1 - y0) / 86400000);
  } catch (e) { return 9999; }
}
// 按 pool 记住档内上一次选中的 key；模块常驻，热重载会清零（额度数据变了本就该重排）。
const cursors = {};
const FIXES = [
  // skipHours: 假窗口/计数器，吃掉短 resetsAt；daily: 数据面缺失的每日真蛋糕
  { prefix: 'workbuddy', skipHours: 36 }, // deepseek tokens (est.) 是用量计数器，真池=月度 Credits
  { prefix: 'opencode-go', skipHours: 6 }, // 5h 速率窗不参与排序，按 7d/月窗排（烧=纯赚）
  { prefix: 'marvis', daily: true }, // 每日 10M tokens 的额度，00:00 刷新，数据面无 resetsAt
];
// 全量窗口账本，由 sync-expiry.hooks.js 每 5 分钟从 /v1/magpie/quotas 注入。
// 结构：{ 账号键: [ {r: runsOutAt|resetsAt 的 unix ms, o: runsOut(可选),
//   d: 每日签到限额(可选)} | {x: 耗尽占位}, ... ] }
// 账号键与 seat.key 对齐；命中账本后不再合并 s.soon，避免已耗尽的失效批次
// 从 seat 的 lapse/soon 里回流，绕过同步侧的修正。只带 x 的耗尽占位同样命中
// 账本，但不提供到期时间，账号按无到期数据处理、回落到后段。
const AUTO_BOOK = {
/*AUTO-BOOK-BEGIN*/
/*AUTO-BOOK-END*/
};

export const strategies = {
  'nearest-expiry': (pool, seats, options) => {
    let now = 0;
    try { now = Date.now(); } catch (e) { now = 0; }
    // 时段降权的配置与当前 UTC+8 时间
    const cfg = options && typeof options === 'object' ? options : {};
    const timeRules = Array.isArray(cfg.timeRules) ? cfg.timeRules : [];
    const deferDueDays = typeof cfg.deferDueDays === 'number' ? cfg.deferDueDays : 4;
    // 峰谷价供应商清单：无 options 时用 magpie 官方 4 类 + 单独维护的 workbuddy
    const peakList = Array.isArray(cfg.peakPricing) ? cfg.peakPricing :
      ['deepseek', 'commandcode', 'opencode-go', 'ollama-cloud', 'workbuddy'];
    let localDay = -1; let localMin = -1;
    if (now > 0) {
      try {
        const d = new Date(now + TZ8_MS);
        localDay = d.getUTCDay();
        localMin = d.getUTCHours() * 60 + d.getUTCMinutes();
      } catch (e) { localDay = -1; localMin = -1; }
    }
    const local = { day: localDay, min: localMin };
    const bookKeys = Object.keys(AUTO_BOOK);
    const rank = [];
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i] || {};
      let fix = null;
      let book = null;
      if (typeof s.key === 'string') {
        for (let f = 0; f < FIXES.length; f++) {
          if (s.key.indexOf(FIXES[f].prefix) === 0) { fix = FIXES[f]; break; }
        }
        // 优先按账号键精确命中；新出现的账号回退到最长 provider 前缀
        if (Object.prototype.hasOwnProperty.call(AUTO_BOOK, s.key)) {
          book = AUTO_BOOK[s.key];
        } else {
          let best = '';
          for (let b = 0; b < bookKeys.length; b++) {
            const k = bookKeys[b];
            if (s.key.indexOf(k) === 0 && k.length > best.length) best = k;
          }
          if (best) book = AUTO_BOOK[best];
        }
      }
      let skipMs = SOON_SKIP;
      if (fix && fix.skipHours) skipMs = fix.skipHours * 3600 * 1000;
      let soonMin = 0; // 0 = 无到期数据
      let soonMinKeep = 0; // 不过滤时的最小值（全被过滤则回退用）
      // 账本已经按账号给出可信窗口时，忽略 seat 自带的 soon/lapse：
      // codearts 总积分会把已耗尽的限时批次仍算作即将失效。
      const soon = book ? null : s.soon;
      if (soon && soon.length) {
        for (let j = 0; j < soon.length; j++) {
          const t = soon[j];
          if (typeof t !== 'number' || t <= 0) continue;
          if (now > 0 && t - now > HORIZON_MS) continue; // 长时效窗口：保留但不抢第一档
          if (soonMinKeep === 0 || t < soonMinKeep) soonMinKeep = t;
          if (now > 0 && t - now < skipMs) continue; // 计数器/重置型短窗口，有更晚窗口时忽略
          if (soonMin === 0 || t < soonMin) soonMin = t;
        }
        if (soonMin === 0) soonMin = soonMinKeep; // 全是短窗口：照常参与排序
      }
      // 账本里的真实失效批次（runsOutAt）、每日签到窗(d)与到期窗口
      // （resetsAt）取最早者。真失效批次与每日签到窗豁免 skipMs：它们是会
      // 作废的额度，不能因为临近就被当成重置窗忽略。
      let liveBatch = false; // 30 天内仍有余额的失效批次或 48h 内到期的窗口
      let sortIsCredit = false; // 有效排序键（最早窗）是否带 o：积分类优先用
      if (book && book.length && now > 0) {
        for (let w = 0; w < book.length; w++) {
          const e = book[w];
          if (!e || typeof e.r !== 'number' || e.r <= now) continue;
          if (e.r - now > HORIZON_MS) continue; // 长时效窗口：保留但不抢第一档
          if (e.o && e.o < MIN_RUNSOUT) continue;
          if (e.o || e.r - now <= URGENT_MS) liveBatch = true;
          if (!e.o && !e.d && e.r - now < skipMs) continue;
          if (soonMin === 0 || e.r < soonMin) {
            soonMin = e.r;
            sortIsCredit = !!e.o; // 最早窗带 o 才算积分类；d 签到/重置窗不算
          }
        }
      }
      if (fix && fix.daily && now > 0) {
        // 每日 00:00 重置的真蛋糕，数据面缺失时注入伪窗口
        try {
          const d = new Date(now);
          const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
          if (soonMin === 0 || next < soonMin) soonMin = next;
        } catch (e) { /* moejs 无 Date 构造器则放弃注入 */ }
      }
      // UTC+8 同一天：同日内积分类（最早窗带 o）优先，跨日仍按精确到期排序。
      // 账号随时可用的重置型窗与限额可能用不完的积分窗撞在同一天时，先烧积分。
      let day8 = 0;
      if (soonMin > 0) {
        try {
          const d = new Date(soonMin + 8 * 3600 * 1000);
          day8 = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
        } catch (e) { day8 = 0; }
      }
      // used>=98 通常意味着整桶快用完；但账本里仍有 48h 内会作废的额度（o 批次、
      // d 签到或临期重置窗）时，它恰恰最该先烧完，不能按 spent 垫底把临期额度留到过期。
      const spent = (s.resting === true) ||
        (!liveBatch && s.known === true && typeof s.used === 'number' && s.used >= 98);
      // 排序键：spent 垫底；有到期数据的在前，按精确时刻升序；无数据的排在其后
      const group = spent ? 2 : soonMin > 0 ? 0 : 1;
      const key = typeof s.key === 'string' ? s.key : `#${i}`;
      // 时段降权：命中规则的供应商在降权时段内排到同组末尾；
      // 有效排序键按 UTC+8 自然日算 deferDueDays 天内到期时豁免（临期照常用）。
      let defer = false;
      if (timeRules.length && local.day >= 0 && group === 0) {
        const dueIn = dayDiff8(now, soonMin);
        const nearDue = dueIn <= deferDueDays;
        if (!nearDue) {
          for (let r = 0; r < timeRules.length; r++) {
            const rule = timeRules[r];
            if (prefixHit(key, rule.prefix) && inWindow(local, rule)) { defer = true; break; }
          }
        }
      }
      let peak = false;
      for (let p = 0; p < peakList.length; p++) {
        if (prefixHit(key, peakList[p])) { peak = true; break; }
      }
      rank.push({ i: i, group: group, soon: soonMin, day8: day8, credit: sortIsCredit,
        defer: defer, peak: peak, used: typeof s.used === 'number' ? s.used : 0, key: key });
    }
    rank.sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      if (a.defer !== b.defer) return a.defer ? 1 : -1; // 时段降权：非降权者优先
      if (a.day8 > 0 && a.day8 === b.day8 && a.credit !== b.credit) {
        return a.credit ? -1 : 1; // 同一天：积分类先用
      }
      if (a.soon !== b.soon) return a.soon - b.soon; // 精确到期时刻升序
      if (a.soon > 0 && a.peak !== b.peak) return a.peak ? -1 : 1; // 同刻：有峰谷价者优先（低谷省钱）
      if (a.soon > 0 && a.used !== b.used) return b.used - a.used; // 同刻：快用完的先烧
      return a.i - b.i;
    });

    // 正常候选里，最早到期后 BAND_MS 内的视作同一档，档内轮换一位，避免分钟级
    // 差异把每轮对话钉在同一账号。轮换池只取 BAND 内、与头部同峰谷属性的子组：
    // 同刻的 peak 账号排前（排序已保证），nonpeak 不会被轮换顶到它前面。
    // 用 key 作锚点并区分峰谷属性，容忍候选增减，也避免两组轮换状态互相干扰。
    const normal = rank.filter((r) => r.group === 0 && !r.defer);
    if (normal.length > 1) {
      const t0 = normal[0].soon;
      const headPeak = normal[0].peak;
      const rot = normal.filter((r) => r.soon >= t0 && r.soon - t0 <= BAND_MS && r.peak === headPeak);
      if (rot.length > 1) {
        const p = `${typeof pool === 'string' ? pool : ''}|${headPeak ? 'p' : 'n'}`;
        const last = cursors[p];
        let at = -1;
        if (typeof last === 'string') {
          for (let b = 0; b < rot.length; b++) {
            if (rot[b].key === last) { at = b; break; }
          }
        }
        const pick = rot[(at + 1) % rot.length];
        cursors[p] = pick.key;
        const head = rank.indexOf(pick);
        const base = rank.indexOf(rot[0]);
        if (head > base) rank.splice(base, 0, ...rank.splice(head, 1));
      }
    }
    const order = [];
    for (let k = 0; k < rank.length; k++) order.push(rank[k].i);
    return order;
  },
};
