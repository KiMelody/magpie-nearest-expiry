// magpie 路由策略：nearest-expiry —— 会作废的额度最先烧。
// 排序：正常成员按有效窗口 min(soon) 的精确时间戳升序 → 最早到期后 BAND_MS 内的
//       候选视作同一档，在档内按组轮换 → 同一时刻才用 used 决胜
//       → 无到期数据的（无期限额度）垫后 → resting/已用尽（used>=98）垫底。
// 数据面：seatJSON 只有 9 个字段（soon 只说何时重置、不说烧它消耗什么），
//   故由 sync-expiry.hooks.js 定时把 /v1/magpie/quotas 的全量窗口账本注入 AUTO_BOOK：
//   真实失效批次（runsOutAt/runsOut）自动升档；计数器型短窗仍靠 FIXES 跳过。
// seat 字段（points.go seatJSON）：{ key, account, known, learns, used, soon[], pace, weight, resting, tokens }
// 返回：seats 的索引排列，只定顺序；候选集、rest、failover 仍由 magpie 核心处理。

const SOON_SKIP = 2 * 3600 * 1000; // 默认忽略 2 小时内到期的窗口（判定为重置型）
const MIN_RUNSOUT = 10; // 小于此量的过期批次按已烧完处理，避免尾量被粘性反复消耗
const BAND_MS = 5 * 60 * 1000; // 到期时间相差 5 分钟内视作同一档，档内轮换
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
          if (soonMinKeep === 0 || t < soonMinKeep) soonMinKeep = t;
          if (now > 0 && t - now < skipMs) continue; // 计数器/重置型短窗口，有更晚窗口时忽略
          if (soonMin === 0 || t < soonMin) soonMin = t;
        }
        if (soonMin === 0) soonMin = soonMinKeep; // 全是短窗口：照常参与排序
      }
      // 账本里的真实失效批次（runsOutAt）、每日签到窗(d)与到期窗口
      // （resetsAt）取最早者。真失效批次与每日签到窗豁免 skipMs：它们是会
      // 作废的额度，不能因为临近就被当成重置窗忽略。
      if (book && book.length && now > 0) {
        for (let w = 0; w < book.length; w++) {
          const e = book[w];
          if (!e || typeof e.r !== 'number' || e.r <= now) continue;
          if (e.o && e.o < MIN_RUNSOUT) continue;
          if (!e.o && !e.d && e.r - now < skipMs) continue;
          if (soonMin === 0 || e.r < soonMin) soonMin = e.r;
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
      const spent = (s.resting === true) || (s.known === true && typeof s.used === 'number' && s.used >= 98);
      // 排序键：spent 垫底；有到期数据的在前，按精确时刻升序；无数据的排在其后
      const group = spent ? 2 : soonMin > 0 ? 0 : 1;
      const key = typeof s.key === 'string' ? s.key : `#${i}`;
      rank.push({ i: i, group: group, soon: soonMin, used: typeof s.used === 'number' ? s.used : 0, key: key });
    }
    rank.sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      if (a.soon !== b.soon) return a.soon - b.soon; // 精确到期时刻升序
      if (a.soon > 0 && a.used !== b.used) return b.used - a.used; // 同一时刻：快用完的先烧
      return a.i - b.i;
    });

    // 正常候选里，最早到期后 BAND_MS 内的视作同一档；按 pool 在档内轮一位，
    // 档外成员仍按上面的顺序跟在后面。用 key 作锚点，容忍候选增减/重排。
    const normal = rank.filter((r) => r.group === 0);
    if (normal.length > 1) {
      const t0 = normal[0].soon;
      const band = normal.filter((r) => r.soon - t0 <= BAND_MS);
      if (band.length > 1) {
        const p = typeof pool === 'string' ? pool : '';
        const last = cursors[p];
        let at = 0;
        if (typeof last === 'string') {
          for (let b = 1; b < band.length; b++) {
            if (band[b].key === last) { at = b; break; }
          }
        } else {
          at = -1; // 首次调用：先按最早到期者，不预轮
        }
        const pick = band[(at + 1) % band.length];
        cursors[p] = pick.key;
        const head = rank.indexOf(pick);
        if (head > 0) rank.splice(0, 0, ...rank.splice(head, 1));
      }
    }
    const order = [];
    for (let k = 0; k < rank.length; k++) order.push(rank[k].i);
    return order;
  },
};
