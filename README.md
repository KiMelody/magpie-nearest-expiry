# magpie-nearest-expiry

[中文文档](README.zh-CN.md)

A magpie directory plugin that registers a routing strategy named `nearest-expiry/nearest-expiry` and keeps its quota book fresh from the local gateway.

The strategy prefers candidate seats whose allowance is lost soonest. It combines:

- the seat data magpie exposes to JavaScript strategies (`soon`, `used`, `resting`, and related fields);
- a compact account-scoped `AUTO_BOOK` injected into the middleware entry file from `/v1/magpie/quotas`;
- a few provider-specific semantic fixes for counters and unmetered daily allowances.

Candidates are ordered by their exact earliest expiry timestamp. The used percentage only breaks ties between candidates expiring at exactly the same timestamp; rounding expiries into hour buckets is deliberately avoided, since a minute-scale difference can otherwise be inverted by unrelated usage percentages. Candidates whose expiry falls within five minutes of the earliest are treated as one band and rotated per group, so minute-scale differences do not pin every turn to the same account. Rotation state lives in the strategy's module scope and is keyed by pool; it resets when the middleware reloads because quota data changed. Rotation only happens among candidates whose effective sort keys are otherwise equivalent: the same-day credit preference, the exact-tie 7d demotion and the peak-hour preference all outrank a minute-scale difference, so rotation cannot displace them and its cursor is kept separate for each such subgroup.

Peak-priced providers are listed in `peakPricing`, defaulting to magpie's official four hourly-billed providers (deepseek, commandcode, opencode-go, ollama-cloud) plus a separately maintained workbuddy. The strategy now shifts preference by time of day: in off-peak hours peak-priced providers rank first (their metering is cheapest then), while in peak hours flat-priced providers rank first so metered allowances are spared. Small windows — daily check-ins and credit batches expiring within 24 hours — carry a fixed price and are deliberately held back in off-peak hours so they land in the peak window instead. An account within 16 hours of expiry enters a protection band that ignores peak/valley entirely and burns by expiry, so a small window that cannot wait for the next peak is spent in time. Peak hours use opencode-go's weekday 09:00-12:00 and 14:00-18:00 windows; workbuddy is an exception judged by its own daily 08:30-22:00 window. The peak preference is a soft ordering tier: a near-expiry allowance still outranks it, and it never displaces the spent or no-expiry groups.

Windows expiring more than 30 days out are treated as having no expiry data, so long-lived allowances never compete with near-term ones for the first band. An account whose seat reports 98% or more used is normally sunk as spent; when the ledger still holds a losing batch within 30 days, or any window expiring within 48 hours (daily check-ins included), it is exempt from that rule and returns to the first band to burn the expiring credits before falling back.

The hooks write the ledger only when its content changes, avoiding a periodic timestamp that would otherwise reload the middleware and clear rotation state on every sync. Short rate-limit windows computed relative to the current time are excluded, and timestamps and loss amounts are rounded, so routine quota reads keep producing the same ledger. A response with no valid accounts leaves the existing ledger untouched, so a failed refresh cannot wipe it.

Quota windows are keyed per account, so two accounts on the same provider cannot mix their expiry data. For CodeArts, a timed credit batch is identified by the window's own `runsOutAt` and `runsOut`; the vendor now reports those fields only for real batches, so no Chinese display text is parsed. A batch with fewer than 10 credits left is treated as spent and written as an exhaustion placeholder. This keeps a small tail from pinning the account in the first band, where `stays=turn` could repeatedly return to it and consume long-lived credits instead. The same 10-credit threshold is used by both the sync and the strategy so the two layers agree.

Some providers describe a daily check-in or daily-credit allowance with `resetsAt`, even though the credits are lost at that time rather than renewed. A window whose name marks it as a daily check-in or daily credit and still holds a positive balance gets a `d` flag in the ledger, which exempts it from the short-window filter so it stays eligible until it actually expires. Empty check-in windows are left out. A reset window whose balance is already spent (remaining 0) is treated as spent and written as an exhaustion placeholder, so accounts with no quota left do not keep their reset window in the near-term band.

The ledger is only rewritten when its ordering semantics change: the strategy ranks by expiry timestamps and the presence of `o`/`d`/`w`/`s`/`x` flags, so jitter in the `o` amount (it shrinks as credits are burned) leaves those discrete features untouched and the write is skipped. This keeps the strategy's band-rotation cursor alive instead of having it cleared by a hot reload on every sync.

Monthly allowances that lapse at their reset are ranked as expiring credit. Since CodeArts plugin 0.3.25 moved `runsOutAt`/`runsOut` onto the `总积分` window and stopped putting them on the per-bucket details, the hooks use `总积分`/`基础积分包` `resetsAt` as the expiry key and `remaining` as the loss amount (`o`), so unused monthly credit lands in the first band and is burned before it lapses; once a timed batch is spent, ranking falls back to this monthly window instead of dropping the account. opencode-go's `Month` window carries `o` for the same reason; its `7 days` window carries a `w` flag that only demotes it on exact expiry ties, while an earlier expiry still ranks first. opendesign's `7 days` window participates as a plain expiry window because leaving it unused prevents the month from being spent. The five-hour rate windows on opencode-go and opendesign merely refresh and lose nothing, so they stay out of the first band.

Subscription windows (opencode-go, opendesign, commandcode and the like, where `remaining` is a percentage with no unit) lose value if left unused, so their leftovers rank too: they are exempt from the absolute `MIN_RUNSOUT` threshold and carry an `s` ledger flag, so even 5% left ranks as loss amount `o`. Credit windows (points/credits) keep the absolute threshold to filter worthless tails, and daily check-in windows are treated as lapsing rather than subscription.

For opencode-go, the weekly window is dropped as a ranking key once the monthly window falls below 20% remaining. The weekly window renews on schedule and loses nothing by waiting; using it as the sort key would push the account into the first band and burn the monthly balance early. With the weekly key removed, the account falls back and near-term expiring accounts at other providers take priority. The rule lifts itself when the monthly window renews back to 100%.

opencode-go is available at any time, while credit-based accounts (those carrying expiring batches) may hit their rate limits and fail to spend their balance. When two candidates' effective sort keys (their earliest windows) fall on the same UTC+8 day, the one with an `o` batch ranks first; across different days, exact expiry order is unchanged. The check runs in the strategy on every request, so it reacts immediately when a earlier window burns out and the earliest key shifts, rather than relying on the ledger snapshot at write time.

An account with no losing or resetting window gets an `x` exhaustion placeholder. The placeholder keeps the account in the ledger, which suppresses any stale `soon` or `lapse` still present on the seat, but contributes no expiry timestamp, so the account is treated as having no expiry data and falls behind. Once a timed allowance is spent, new turns move back to accounts that still have a near-term allowance as soon as the next sync notices. The 5-minute sync interval bounds that delay; with `stays=turn`, stickiness inside one long turn remains under magpie's control and the strategy only affects new turns.

The hooks entry runs a lightweight 5-minute timer inside magpie's plugin host. It has no model-facing tools and does not change request bodies; it only refreshes the middleware source block so magpie hot-reloads the strategy.

## Skipping exhausted accounts inside a long turn

With `stays=turn`, magpie promotes the last responder to the front of the candidate list on every request, so ranking an account last cannot stop a long turn from returning to it. The plugin exports `onAccount(account, ctx)`: every five minutes the hooks write the anonymous refs of accounts whose timed allowance is spent (the ledger's `x` placeholder) into an `AUTO_SKIP` block, and `onAccount` returns `{skip:true}` on a hit. magpie then tries the next candidate; once it succeeds, the turn's stickiness moves to the new account, so later requests in the same turn no longer return to the exhausted one.

Only accounts in groups routed by `nearest-expiry/nearest-expiry` are skipped; other strategies are untouched. An exhausted account is kept when every group it belongs to has no other usable account, so skipping cannot leave a request with no candidate. The ref is magpie's anonymous account identifier; the hooks derive it with the same HMAC-SHA256 as magpie's source, from `account-ref.key`, `user` and `plan`. Before the key exists the skip list is empty and fills in on the next sync after the first `onAccount` creates it. To check the mapping once, set the `debugRefs` option to true and the log prints each account's `(provider, ref)`.

When a small window (a daily check-in or a sub-24-hour credit batch) burns out on a multi-window account, that account would otherwise keep its turn stickiness and spend the remaining long-lived window. The hooks compare each account's earliest window between syncs and record a handoff event when a short window becomes a long one, together with the ref of the account that currently holds the group's earliest expiry. `onAccount` skips a handed-off account for up to ten minutes only when another account is the earliest and its own next window is more than 16 hours out, so a long turn moves to a more urgent seat. If the account is itself the earliest, or its remaining window is already near due, it is kept and continues on the same account without losing cache warmth. The decision reads the precomputed best ref plus a single ledger lookup, so it adds no per-request sort work.

## Install

```bash
magpie plugin add github:owner/magpie-nearest-expiry
magpie group set <group-id> routing=nearest-expiry/nearest-expiry stays=turn
```

The package name is `middleware-nearest-expiry` so magpie's `ShortName` remains `nearest-expiry`. This keeps the routing id stable.

## Runtime data

The published source contains only an empty `AUTO_BOOK` block. At runtime the hooks entry writes provider window timestamps into that block using a temporary file plus rename. The log is kept under:

```text
~/.config/magpie/nearest-expiry/sync-expiry.log
```

No account identifiers, quota snapshots, or logs are committed to the repository.

## Files

- `nearest-expiry.middleware.js`: moejs-safe routing strategy.
- `sync-expiry.hooks.js`: Bun-hosted quota sync and source injection.
- `package.json`: declares both magpie entry points.

## Notes

- `magpie.options` in `package.json` is only an example for magpie's options editor. Runtime options come from the installed plugin's `options` entry in `plugins.json`.
- `magpie plugin update` on a GitHub source may replace the installation directory. The hooks timer repopulates `AUTO_BOOK` shortly after reload.
- Keep `stays=turn` or `stays=off`; with `stays=auto`, magpie's cache affinity can prevent any custom routing strategy from being reconsidered on each new turn.

## License

MIT
