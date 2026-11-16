# TikTok Shop 运营工作台

TikTok Shop 店铺运营源码，包含 Node.js 工作台、商品只读接口、官方 API 上架与促销、选品、经营复盘、仓库影子对照和视频工作流。

## 阅读入口

- `apps/customer-service/` 工作台、店铺授权、本机同步与前端。
- `apps/shop-agent-read/` 给 Agent 的只读商品、SKU 与图片接口。
- `scripts/operations/` 工作台任务、上架、促销、广告、结算和发货影子。
- `scripts/publisher/` 视频发布队列、校验、平台回执和离线测试。
- `scripts/video-production/`、`scripts/video-publishing/` 与 `skills/` 制作、发布和运营辅助源码。

## 本地检查

使用 Node.js 22.16 或更高版本。从本目录运行：

```sh
node --test apps/shop-agent-read/server.test.mjs tests/operations-listing-shadow.test.mjs tests/operations-promotion-outcome.test.mjs tests/daily-role-queue.test.mjs
node apps/customer-service/server.mjs
```

工作台默认监听 `http://127.0.0.1:3377/operations`。公开仓库保留示例配置与脱敏标识。连接自己的店铺需要替换示例店铺标识、提供运行配置并走官方授权。Windows 授权与仓库脚本依赖本机 DPAPI、PowerShell 或供应商账号，云端运行需要适配凭据存储和调度。广告和发布接口各自需要平台授权。

原业务数据库、日志、媒体、授权文件、真实回执及生产配置由原运行环境保管。README 中的核心测试命令适用于干净检出。遗留活动测试依赖原工作目录已有缺口的 activity 模块。依赖原私有发布历史的回放测试需要提供自己的合法输入。外部 FastMoss MCP 适配器需要在自己的开发环境安装 `@modelcontextprotocol/sdk`，并配置提供商凭据。
