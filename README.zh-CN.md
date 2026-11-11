# magpie-nearest-expiry

这是一个 magpie 目录型插件，注册 `nearest-expiry/nearest-expiry` 路由策略，并从本机网关定时刷新配额账本。

策略会优先选择额度最早失效的候选席位，综合使用：

- magpie 暴露给 JavaScript 策略的 seat 字段，例如 `soon`、`used`、`resting`；
- hooks 从 magpie 本机配额接口提取、按账号区分并写入 `AUTO_BOOK` 的窗口时间戳；
- 少量供应商语义修正，用于区分计数器窗口、每日额度和会作废的积分批次。

额度窗口按账号分别记录，同一供应商的两个账号不会混用过期数据。针对 CodeArts，只有厂商同时报告即将过期的积分量时，才把限时积分包当作会作废的额度；签到批次的时间戳配上整桶长时效余额，不足以证明余额会随该批次一起失效。没有即将过期的积分量时，改用月度重置时间。

候选按最早到期的精确时间戳排序。只有到期时刻完全相同时，才用已用比例决胜；不把到期时间按小时取整，因为分钟级的先后会被不同额度池的用量比例反转。与最早到期相差 5 分钟内的候选视作同一档，按组轮换，避免分钟级差异把每轮对话都钉在同一个账号上。轮换状态保存在策略模块内、按 pool 区分；额度数据变化导致中间件重载时会清零。

hooks 只在账本内容变化时写文件，不再写入周期性时间戳，避免每 30 分钟重载一次并清空轮换状态。相对当前时间计算的短速率窗会被排除，时间戳与失效量也会取整，使常规额度读数生成相同的账本。

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
