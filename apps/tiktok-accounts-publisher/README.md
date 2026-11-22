# TikTok Accounts 发布自测服务

这是华赢自身运营的受控发布验证服务，使用 TikTok API for Business / Accounts API v1.3。健康检查、本地测试、授权成功、取得 share_id 和公开帖子独立回读分别验收。它不提供 Shop 商品挂车、广告、价格、预算、发货接口。

现有 Worker 为 `huaying-business-auth-registration`，保留登记回调 `/oauth/account/callback`，广告授权路径固定返回 503。`wrangler.jsonc` 内的官方授权 URL 来自已批准应用后台原始 URL，保留其全部 19 项 scope；实际授权及最低操作权限仍由 tokenInfo 独立核验。固定可信身份为 `huaying-self` / `dalei-operator`，请求正文不能声明身份或导入 token。

## 配置与本地验证

运行时使用 Workers WebCrypto 与 SQLite Durable Object `AccountsStore`；不依赖本机文件系统。Free SQLite DO migration 使用 `new_sqlite_classes`。部署负责人须先备份现有 Worker 版本，使用同一已登记 URL，然后通过服务器 secrets 设置：

- `APP_SECRET`：本应用服务端密钥。
- `VAULT_KEY`：随机 32 字节的标准 Base64，不带换行。不得换 Key 以规避旧未知状态；更换前需独立迁移已有密文。
- `OPERATOR_KEY`：至少 32 字符的独立随机 Bearer capability，不复用 Shop 只读凭据。

公开配置不是凭据。不要将 `.dev.vars`、真实媒体、运行数据库、授权回调 query、任何密钥或下载 URL 写入公开源码和日志。配置关闭 Worker observability，应用没有 console 日志。运行测试：`npm test`，需要 Node 22.16 或更新版本；Node 22 的 `node:sqlite` 会显示实验性功能提示。测试使用实际 SQLite 事务与本地 mock API，不请求真实 TikTok。

## 操作顺序

所有 `/operator/*` 需要 `Authorization: Bearer <OPERATOR_KEY>`。浏览器写请求若携带 Origin，必须严格等于 `PUBLIC_ORIGIN`；`/oauth/account/start` 必须同源 Origin。以下路由不接受客户端 tenant、actor、token 或 appId。

| 路由 | 行为 |
|---|---|
| GET `/healthz` | 版本与 provider 配置；`livePublishVerified:false`，不证明真实发布 |
| POST `/operator/flows` `{}` | 签发 5 分钟一次 ticket，返回本人账号授权入口 |
| GET `/connect?t=...` | 显示按钮，不消费 ticket |
| POST `/oauth/account/start` | 同源表单消费 ticket，设置 Secure/HttpOnly/Lax cookie，303 官方授权 |
| GET `/oauth/account/callback?auth_code=...&state=...` | 严格校验浏览器证明、一次 state；先持久化 UNKNOWN，再仅交换一次授权码 |
| GET `/operator/accounts` | 仅授权/验证状态、账号元数据、scope 与有效期 |
| POST `/operator/accounts/:connectionId/verify` `{}` | tokenInfo 精确核 app/账号/scope，再只读核 profile/settings |
| PUT `/operator/media/:sha256` | `video/mp4`，1 字节至 20 MiB，核实际 SHA，再存 SQLite 分块，返回 owner 专用源 URL |
| GET/HEAD `/media/...?...` | 短期 token 下载与 Range；没有公开上传 |
| POST `/operator/url-property` | 仅 `{url:PUBLIC_ORIGIN+"/media/",type:2}`，一次添加、落签名文件、验证 |
| GET `/operator/url-property/status` | 必须已有本服务前缀 claim；只读核官方属性列表，精确唯一的 type=2、本人 `/media/`、status=1 才更新验证缓存 |
| POST `/operator/publish` | 精确 connectionId/requestId/assetSha256/videoUrl/postInfo；一次发送 |
| GET `/operator/publish/:requestId/status` | 只查询原 publishId，不创建新发布 |
| GET `/operator/publish/:requestId/posts` | 仅按账本原账号和原 postIds 独立查询 list；精确、完整、无重复且非广告才通过 |

发布前须人工核准确账号、原始素材 SHA、未发及非 UNKNOWN、SKU/文案/AI 与商业内容披露、原账号额度和间隔。服务仅允许已上传、媒体前缀已验证、剩余下载有效期超过 30 分钟的 URL；账号验证须在 15 分钟内且授权未过期。`postInfo` 使用本 API 的原生 snake_case 字段，须显式给出 `is_brand_organic`、`is_branded_content`、`is_ai_generated`。不接受草稿或 ads-only 作为本轮公开发布。

同一 requestId 相同完整意图只返回原账本；改变账号、SHA、URL或参数返回 409。服务全局同一 SHA 只可 claim 一次，不能通过换账号或换 requestId 重发。发布前原子写 UNKNOWN；只允许 claim winner 调用一次 provider。响应或存储不确定不重放。授权码、媒体属性添加也保留一次性状态，重启不会自动重试。AES-GCM 加密整个 normalized token 响应，Aad 绑定 app/tenant/actor/provider/账号，无 HTTP token 出口。

媒体属性添加/验证结果 UNKNOWN 时，允许仅通过上述 GET 查询本应用官方属性列表，核对既有 claim 的固定本人前缀。精确唯一且 verified 才恢复缓存；pending、failed、缺失或重复均为 UNVERIFIED，并撤销旧正向缓存但保留原 claim，不能重新添加。此接口不接收正文、query、外来 URL 或身份，不调用 add、verify 或 publish。这个只读核对例外不改变授权码和发布 UNKNOWN 的禁止重放规则。

## 状态与范围

`PROCESSING`、`FAILED`、`DRAFT`、`UNKNOWN` 分开保留。provider complete 缺帖子 ID 标 `AWAITING_POST_IDS`，继续查原任务；有 ID 标 `COMPLETE` 仅代表状态回执，status中的 `independentlyVerified:false`，仍须通过 posts 按原帖子 ID 独立回读。posts 只在完整匹配原 IDs 且 `isAd:false` 时返回 `independentlyVerified:true`，安全回执另外落账；缺、错、重复或读取故障均未核实。失败原因不会包含原始 provider error、token 或授权 query。

首版不提供自动 refresh、原生定时、webhook、批量循环或 UNKNOWN 恢复写入接口。排程和全店历史防重仍由原业务账本负责；本服务的 SHA 防重只覆盖本服务已有记录。媒体 token 默认 48 小时，过期拒绝下载；首版没有自动删除 SQLite 已存媒体的定时任务。部署、本地测试和真实发帖成功不得互相替代。
