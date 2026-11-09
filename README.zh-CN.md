# magpie-nearest-expiry

这是一个 magpie 目录型插件，注册 `nearest-expiry/nearest-expiry` 路由策略，并从本机网关定时刷新配额账本。

策略会优先选择额度最早失效的候选席位，综合使用：

- magpie 暴露给 JavaScript 策略的 seat 字段，例如 `soon`、`used`、`resting`；
- hooks 从 magpie 本机配额接口提取并写入 `AUTO_BOOK` 的窗口时间戳；
- 少量供应商语义修正，用于区分计数器窗口、每日额度和会作废的积分批次。

hooks 入口在 magpie 插件宿主内运行一个 30 分钟定时器。它不向模型暴露工具，也不改请求体，只刷新 middleware 入口文件里的账本块，由 magpie 热重载策略。

## 安装

```bash
magpie plugin add github:owner/magpie-nearest-expiry
magpie group set <group-id> routing=nearest-expiry/nearest-expiry stays=turn
```

包名使用 `middleware-nearest-expiry`，这样 magpie 的 `ShortName` 仍为 `nearest-expiry`，现有路由 id 不会变化。

## 运行时数据

发布源码只包含空的 `AUTO_BOOK` 占位块。运行时，hooks 使用临时文件加 rename 的方式，把供应商窗口时间戳写入该块。日志保存在：

```text
~/.config/magpie/nearest-expiry/sync-expiry.log
```

仓库不提交账号标识、额度快照或运行日志。

## 文件

- `nearest-expiry.middleware.js`：兼容 moejs 沙箱的路由策略。
- `sync-expiry.hooks.js`：运行在 Bun 宿主中的配额同步与源码注入。
- `package.json`：声明 middleware 与 hooks 两个 magpie 入口。

## 说明

- `package.json` 里的 `magpie.options` 只作为 magpie 选项编辑器的初始示例。运行时配置来自 `plugins.json` 中该插件的 `options` 条目。
- 对 GitHub 来源执行 `magpie plugin update` 可能替换安装目录。hooks 定时器会在重载后很快重新填充 `AUTO_BOOK`。
- 建议保持 `stays=turn` 或 `stays=off`。使用 `stays=auto` 时，magpie 的缓存亲和性可能让自定义路由策略无法在每个新回合重新参与决策。

## 许可

MIT
