# 店铺云端只读服务与授权中心

Node.js 22+，无第三方运行依赖。面向已获授权的单个 MY seller 店铺；公开源码不含店铺身份、应用密钥、平台授权或服务器配置。测试中的店铺、商品、SKU、令牌均为 fixture。

这是从内部候选包 v3 整理的可公开版本。部署方必须补齐私有配置并独立验收，下载源码不代表已连接 TikTok，也不代表多商家准入或视频发布已获批。

## 可用范围

| 接口 | 数据范围 |
| --- | --- |
| `GET /v1/shop` | 精确核验后的授权店铺身份 |
| `GET /v1/products` | 商品完整分页快照，包含平台返回的各种状态 |
| `GET /v1/orders` | 最近 7 天订单完整分页，响应附准确时间窗口 |
| `GET /v1/inventory?sku_ids=...` | 指定 SKU 的库存；未知为 `null`，未返回项列入 `missingSkuIds` |

业务写入方法返回 405；没有上架、促销、发货、广告、任意 URL 转发或视频发布入口。原项目中其他本地模块的权限不因此增加。

数据为定期查询与缓存，不能称为逐事件实时推送：商品与订单缓存 30 秒，后台每轮完成后至少间隔 60 秒再同步，不重叠。上游失败返回 503，并以 `stale:true`、`lastSuccessfulAt` 标明旧证据；没有成功证据则为 `null`。缓存最多 64 项、不同读取最多 4 项在飞，超出返回 429；同键请求合并。

`GET /healthz` 只说明进程与本进程同步状态：`backgroundSyncCompletedAt` 是一轮完成时间，`backgroundSyncSucceededAt` 是最近一轮商品与订单均成功的时间，不能冒充平台业务发生时间。重启后尚未同步时为 `null`。

## 两类独立凭据

普通 Agent 使用各自随机 Bearer 凭据，只能访问四个业务接口。`config.agents` 保存其 SHA256，不保存明文。

`GET /internal/access-lease` 只给原可信运行器的独立机器凭据，配置在 `legacyBridge.sha256`，不得与普通 Agent 哈希相同。普通 Agent 请求此接口返回 403；机器凭据请求业务接口返回 403；无凭据或错误凭据返回 401。接口不接受查询参数，响应 `Cache-Control:no-store`。

lease 发出前核验店铺 ID、名称、MY 区域与非空 cipher；响应只含 `serviceId`、`shop:{id,name,region}`、`refreshOwner`、24 位小写十六进制 `version`，以及 `tokens` 中的 `access_token`、`access_token_expire_in`、`user_type`、`open_id`、`granted_scopes`。不返回 App Key、App Secret 或 refresh token。`access_token_expire_in` 保留平台实际 Unix 秒绝对到期时间，不当作剩余秒数。

这类 lease 不能让任意 Agent 独立签名调用所有 Shop API。过渡期可信运行器若仍直连官方接口，还需原来受保护的本地 App Secret；普通 Agent 应使用业务 API。

## 唯一刷新负责人

`SHOP_CLOUD_REFRESH_OWNER` 默认 `disabled`。只有完成旧刷新实例停用、可信运行器 delegated 模式验收、在飞调用核查后，才可显式设为 `cloud`。不要同时运行两个刷新负责人。

刷新提前余量为 300 秒，实际期限使用平台返回值，不假定旧令牌一定继续有效。新响应须同一 seller `open_id`、`user_type:0`、完整 token、有效期限与 scopes。

刷新前，以 `wx` 创建持久全局锁和当前授权代次 intent，文件 fsync 后才发请求，Linux 同步目录元数据。成功响应先独立加密保存，再原子替换主 vault、提交账本并释放锁。网络未知、身份错误或持久化失败保留 pending/UNKNOWN 闩锁，跨调用、跨进程不重放。没有自动抢锁、清锁或 HTTP 安装 token 的入口。

`needReconcile:true` 时，负责人须核对原 claim、账本与加密恢复文件。不得删除锁或恢复旧 refresh token 来“修复”。代码回退与授权回退是两件事。尚有效且未被平台拒绝的 access 可继续用于只读请求；到期或明确拒绝时关闭。

## 配置与部署

1. 复制 `config.example.json` 到服务器私有目录，填写真实 `serviceId`、授权店铺身份和不同凭据哈希。配置、密钥、vault、ledger 文件权限 0600，目录 0700；绝不提交到 GitHub。
2. `SHOP_CLOUD_KEY_FILE` 指向独立 32 字节随机密钥的 base64 文件。加密 vault 保存 `{serviceId,appKey,appSecret,tokens}`。Windows DPAPI 文件不能直接交 Linux 解密，应由已授权负责人通过受保护通道迁移。
3. 配置 `SHOP_CLOUD_READ_ENABLED=1`、`SHOP_CLOUD_CONFIG`、`SHOP_CLOUD_KEY_FILE`。默认仅回环 HTTP 8731。公网必须配置独立 TLS 证书/私钥路径，并显式设置 `SHOP_CLOUD_BIND=0.0.0.0` 与合适的 `SHOP_CLOUD_PORT`。不要占用服务器原有服务端口。
4. 以专用非 root 用户运行，参考 `shop-cloud-read.service.example`。将 `WorkingDirectory` 和 `ExecStart` 都替换为同一个真实不可变版本目录。保留旧节点、防火墙与证书服务；TLS 每 60 秒核验独立证书副本并热更新，无效新证书保留旧 context。证书续期和复制链需另行配置及验收。
5. 先 owner=disabled 验收四个接口、身份、鉴权、时间推进和 bridge 隔离，再协调刷新负责人的单次切换。自然到期后的首次真实刷新与跨重启恢复须有独立回执；mock 通过不能代替这项验收。

本服务不记录请求头、token、原始上游错误或 lease 响应体。vault 和 recovery 密文仍属敏感材料，密钥必须独立保管。

## 本地测试与现场验收

```sh
node --test test/*.test.mjs
```

测试用 mock 和回环 HTTPS，不访问真实平台；OpenSSL 仅用于生成临时测试证书，可用 `OPENSSL_BIN` 指定路径。

现场 smoke 必须明确指定预期店铺，不含内置真实身份：

```sh
SHOP_READ_BASE_URL=https://your-api.example.com:8445 \
SHOP_READ_TOKEN_FILE=/private/agent-token \
SHOP_READ_CONFIG=/private/config.json \
node smoke.mjs
```

也可用 `SHOP_READ_EXPECTED_SHOP_ID` 与 `SHOP_READ_EXPECTED_SHOP_NAME` 替代 `SHOP_READ_CONFIG`。smoke 只读验证 401、405、四路数据与精确店铺身份，不刷新或写入真实业务。
