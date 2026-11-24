# magpie-nearest-expiry

[中文文档](README.zh-CN.md)

A magpie directory plugin that registers a routing strategy named `nearest-expiry/nearest-expiry` and keeps its quota book fresh from the local gateway.

The strategy prefers candidate seats whose allowance is lost soonest. It combines:

- the seat data magpie exposes to JavaScript strategies (`soon`, `used`, `resting`, and related fields);
- a compact account-scoped `AUTO_BOOK` injected into the middleware entry file from `/v1/magpie/quotas`;
- a few provider-specific semantic fixes for counters and unmetered daily allowances.

Candidates are ordered by their exact earliest expiry timestamp. The used percentage only breaks ties between candidates expiring at exactly the same timestamp; rounding expiries into hour buckets is deliberately avoided, since a minute-scale difference can otherwise be inverted by unrelated usage percentages. Candidates whose expiry falls within five minutes of the earliest are treated as one band and rotated per group, so minute-scale differences do not pin every turn to the same account. Rotation state lives in the strategy's module scope and is keyed by pool; it resets when the middleware reloads because quota data changed.

Windows expiring more than 30 days out are treated as having no expiry data, so long-lived allowances never compete with near-term ones for the first band. An account whose seat reports 98% or more used is normally sunk as spent; when the ledger still holds a losing batch within 30 days, or any window expiring within 48 hours (daily check-ins included), it is exempt from that rule and returns to the first band to burn the expiring credits before falling back.

The hooks write the ledger only when its content changes, avoiding a periodic timestamp that would otherwise reload the middleware and clear rotation state on every sync. Short rate-limit windows computed relative to the current time are excluded, and timestamps and loss amounts are rounded, so routine quota reads keep producing the same ledger. A response with no valid accounts leaves the existing ledger untouched, so a failed refresh cannot wipe it.

Quota windows are keyed per account, so two accounts on the same provider cannot mix their expiry data. For CodeArts, a timed credit batch is identified by the window's own `runsOutAt` and `runsOut`; the vendor now reports those fields only for real batches, so no Chinese display text is parsed. A batch with fewer than 10 credits left is treated as spent and written as an exhaustion placeholder. This keeps a small tail from pinning the account in the first band, where `stays=turn` could repeatedly return to it and consume long-lived credits instead. The same 10-credit threshold is used by both the sync and the strategy so the two layers agree.

Some providers describe a daily check-in or daily-credit allowance with `resetsAt`, even though the credits are lost at that time rather than renewed. A window whose name marks it as a daily check-in or daily credit and still holds a positive balance gets a `d` flag in the ledger, which exempts it from the short-window filter so it stays eligible until it actually expires. Empty check-in windows are left out. A reset window whose balance is already spent (remaining 0) is treated as spent and written as an exhaustion placeholder, so accounts with no quota left do not keep their reset window in the near-term band.

The ledger is only rewritten when its ordering semantics change: the strategy ranks by expiry timestamps and the presence of `o`/`d`/`x` flags, so jitter in the `o` amount (it shrinks as credits are burned) leaves those discrete features untouched and the write is skipped. This keeps the strategy's band-rotation cursor alive instead of having it cleared by a hot reload on every sync.

For opencode-go, the weekly window is dropped as a ranking key once the monthly window falls below 20% remaining. The weekly window renews on schedule and loses nothing by waiting; using it as the sort key would push the account into the first band and burn the monthly balance early. With the weekly key removed, the account falls back and near-term expiring accounts at other providers take priority. The rule lifts itself when the monthly window renews back to 100%.

An account with no losing or resetting window gets an `x` exhaustion placeholder. The placeholder keeps the account in the ledger, which suppresses any stale `soon` or `lapse` still present on the seat, but contributes no expiry timestamp, so the account is treated as having no expiry data and falls behind. Once a timed allowance is spent, new turns move back to accounts that still have a near-term allowance as soon as the next sync notices. The 5-minute sync interval bounds that delay; with `stays=turn`, stickiness inside one long turn remains under magpie's control and the strategy only affects new turns.

The hooks entry runs a lightweight 5-minute timer inside magpie's plugin host. It has no model-facing tools and does not change request bodies; it only refreshes the middleware source block so magpie hot-reloads the strategy.

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
