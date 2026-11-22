# Business API 注册阶段 HTTPS 回调接收端

Node.js 22+，无第三方运行依赖。这是 **provider 保持关闭** 的注册阶段接收器，不携带真实应用凭据、证书、店铺授权、服务器地址或 token 交换适配器。公开版本由部署者显式配置 `PUBLIC_ORIGIN`，不内置生产 IP。

| 路径 | 当前行为 |
| --- | --- |
| `GET /healthz` | 200，`configuredProviders:[]`、`liveIntegrationVerified:false`，只证明进程运行 |
| `/oauth/advertiser/callback` | 503，明确未配置 provider，没有处理授权 |
| `/oauth/account/callback` | 同上，没有伪造 Accounts API token 参数 |
| `/oauth/advertiser/start`、`/oauth/account/start` | 503，不启动授权或获取 token |
| 其他路径 | 404 |

接收端上线与应用提交、权限批准、账号授权、官方 API 视频实发是不同验收阶段。此包没有启用 provider 的环境开关，不能把 503 改成伪报授权成功的 200。

## 配置

参考 `.env.example` 和 `huaying-business-callback.service.example`，把示例域名换成实际 HTTPS 域名。`PUBLIC_ORIGIN` 必须是无路径、查询、片段或登录信息的完整 origin，端口固定 8444；`PORT` 也只能为 8444。绑定默认 `0.0.0.0`，可明确改为回环 `127.0.0.1`。这只是进程本身配置，不会修改防火墙或 DNS。

示例回调地址：

- `https://callbacks.example.com:8444/oauth/advertiser/callback`
- `https://callbacks.example.com:8444/oauth/account/callback`

证书从独立副本 `/etc/huaying-shop-cloud/tls/server.crt` 与 `server.key` 加载，私钥须为专用用户可读的 0600 普通文件。源证书续期、校验、受控复制链由部署负责人另行配置；本进程不会去读取其他代理服务的私钥目录。每 60 秒核验副本并热更新，配对或有效期异常时保留上一有效 context。

使用专用非 root 用户、数据目录 `/var/lib/huaying-business-callback`。systemd 的工作目录与 Node 入口都指向同一真实不可变版本目录；不要将示例 `REPLACE_VERSION` 直接运行，也不要重启或占用原有代理。日志不包含原始 query、授权码、凭据或请求 URL，只输出固定服务事件。

## 接入后续步骤

部署者须先独立验证 HTTPS、后台回调 URL 校验及审核结果；不能保证平台接受任意 IP、非标准端口或未配置 provider 的组合。Webhook 与 OAuth 的响应语义不同，不应混用。

真正启用授权需在另一个已审版本接入实际 App ID/Secret、官方授权参数、可信商家登录、state 校验、加密 token 存储与独立结果回读。此包未实现视频上传、发布或广告写入。

## 验证

```sh
node --test test/*.test.mjs
```

测试仅使用临时回环 HTTPS 和自签测试 CA，不跳过 TLS 校验、不访问 TikTok、不读真实凭据。覆盖配置边界、两类关闭的回调、无 token 写入、TLS 热更新和 CLI 隐私。

已部署环境可只读检查：

```sh
CALLBACK_PUBLIC_ORIGIN=https://callbacks.example.com:8444 node smoke.mjs
```

结果应明确 `liveIntegrationVerified:false` 与两类 callback 503；smoke 成功不代表视频接口接通。
