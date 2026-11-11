# magpie-nearest-expiry

[中文文档](README.zh-CN.md)

A magpie directory plugin that registers a routing strategy named `nearest-expiry/nearest-expiry` and keeps its quota book fresh from the local gateway.

The strategy prefers candidate seats whose allowance is lost soonest. It combines:

- the seat data magpie exposes to JavaScript strategies (`soon`, `used`, `resting`, and related fields);
- a compact account-scoped `AUTO_BOOK` injected into the middleware entry file from `/v1/magpie/quotas`;
- a few provider-specific semantic fixes for counters and unmetered daily allowances.

Candidates are ordered by their exact earliest expiry timestamp. The used percentage only breaks ties between candidates expiring at exactly the same timestamp; rounding expiries into hour buckets is deliberately avoided, since a minute-scale difference can otherwise be inverted by unrelated usage percentages. Candidates whose expiry falls within five minutes of the earliest are treated as one band and rotated per group, so minute-scale differences do not pin every turn to the same account. Rotation state lives in the strategy's module scope and is keyed by pool; it resets when the middleware reloads because quota data changed.

The hooks write the ledger only when its content changes, avoiding a periodic timestamp that would otherwise reload the middleware and clear rotation state every 30 minutes. Short rate-limit windows computed relative to the current time are excluded, and timestamps and loss amounts are rounded, so routine quota reads keep producing the same ledger.

Quota windows are keyed per account, so two accounts on the same provider cannot mix their expiry data. For CodeArts, a timed credit bucket is trusted only when the vendor also reports an expiring amount; a short-lived check-in batch's timestamp paired with the whole long-lived bucket's balance is not taken as proof that the balance lapses with it. When no expiring amount is reported, the monthly reset is used instead.

The hooks entry runs a lightweight 30-minute timer inside magpie's plugin host. It has no model-facing tools and does not change request bodies; it only refreshes the middleware source block so magpie hot-reloads the strategy.

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
