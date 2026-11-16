# 马来西亚示例店商品只读接口

本服务让已授权的 Agent 查 `example-shop-my` 的在售商品、SKU 和已核实的商品图。它读取单独导出的目录快照，不需要 TikTok 店铺凭据。

## 在 Windows 导出

```powershell
node scripts/operations/export-agent-catalogue.mjs outputs/agent-catalogue/新批次目录
```

导出器复用官方分页商品目录。只选平台状态为在售的商品，在售状态不代表实物库存。快照中每条商品图与 SKU 图各有自己的字段。未核实的图片为 `null`，商品封面不能当作某个 SKU 的确切图片。

导出目录中只有 `catalogue.json` 和 `images/`。将新批次先复制到隔离目录，验证后再让服务读新目录。切换前保留上一版供回退。

## 云端运行

用 Node.js 22 或更高版本，给该服务单独准备非管理员进程和本机端口。把下列配置放在服务器的私密环境配置中。

| 配置 | 用途 |
| --- | --- |
| `SHOP_AGENT_CATALOGUE` | 指向该批次的 `catalogue.json`，旁边保留 `images/` |
| `SHOP_AGENT_TOKENS` | JSON 对象。键为调用方名称，值为独立的高强度随机令牌 |
| `SHOP_AGENT_PORT` | 本机服务端口，默认 8730 |

启动 `node apps/shop-agent-read/server.mjs`。该进程只监听回环端口。外部访问通过已有的 HTTPS 反向代理或独立 TLS 入口，只转发此服务的路由。使用另一个端口或现有 HTTPS 路由前先核 VPS 上的监听和已有服务。

## Agent 接入

给每个 Agent 一个 HTTPS 基础地址，并把自己的令牌放入该 Agent 的私密配置。调用接口发送 `Authorization: Bearer <该 Agent 的令牌>`。下载受保护的图片地址也使用同样的请求头。

| 入口 | 内容 |
| --- | --- |
| `GET /healthz` | 仅返回服务状态 |
| `GET /v1/products?q=SU-57&limit=8` | 搜索在售目录 |
| `GET /v1/products/{productId}` | 展开商品、SKU 与图片 |
| `GET /v1/images/{文件名}` | 下载目录引用的已核实图片 |

上线验收使用一台真正的云端 Agent：验证无令牌时目录拒绝访问、有令牌时可精确找到原商品及 SKU、能下载已核实图片。随后验证撤销该 Agent 的访问不会影响其他 Agent。只读 API 验收后，若目标 Agent 要求 MCP，再将相同的搜索、详情操作包成 MCP 工具。

当前版的更新时间是目录的官方读取时间。Windows 离线后，云端可以继续查看最后同步的快照。若要离线期间持续更新，需在云端重新接官方只读授权，由云进程定时取数。
