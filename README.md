# magpie-nearest-expiry

[中文文档](README.zh-CN.md)

A magpie directory plugin that registers a routing strategy named `nearest-expiry/nearest-expiry` and keeps its quota book fresh from the local gateway.

The strategy prefers candidate seats whose allowance is lost soonest. It combines:

- the seat data magpie exposes to JavaScript strategies (`soon`, `used`, `resting`, and related fields);
- a compact account-scoped `AUTO_BOOK` injected into the middleware entry file from `/v1/magpie/quotas`;
- a few provider-specific semantic fixes for counters and unmetered daily allowances.

Quota windows are keyed per account, so two accounts on the same provider cannot mix their expiry data. For CodeArts, only timed credit buckets with remaining balance are treated as expiring allowances; once those are spent, the monthly reset is used instead of the stale aggregate `runsOut` field.

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
