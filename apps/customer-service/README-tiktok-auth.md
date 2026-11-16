# TikTok Shop 官方接入与店铺运营计划

Partner Center 中的重定向地址为 `https://localhost:3000/tts/authorize`。授权服务只监听本机，使用与客服工作台分开的端口。

## 开始店铺授权

1. 打开 Partner Center 中已建好的「示例马来店运营助手」。在正式发布前确认应用类型为自定义、覆盖马来西亚跨境卖家，并核对首轮需要的 Shop Authorized Information、Product Basic、Order Information。发布清单允许后，发布应用并从详情页复制私有授权链接。
2. 初次可双击 `start-tiktok-auth.cmd`，在本机窗口输入授权链接中 `service_id` 的值、App Key 和 App Secret。App Secret 输入时隐藏。也可以使用下面的一次性加密保存流程。
3. 保持窗口运行。用这台 Windows 电脑上的 Chrome 或 Edge 打开 `https://localhost:3000/tts/connect`，点击页面里的授权链接，使用马来店铺账号核对权限并确认。默认使用本机自签名证书，浏览器可能显示证书未受信任。可用自己的受信任 localhost 证书替换 `data/tiktok-auth/localhost.crt` 和 `localhost.key`。
4. 结果页会列出已授权的马来西亚店铺。按店名和店铺 ID 选择，再分别读取商品样本和近 7 天订单样本，与 Seller Center 对照商品 ID、SKU、订单状态。每项只查询一页、最多 10 条。订单结果只保留对账需要的编号、状态、时间和 SKU 字段。
5. 再次启动后，可在官方接入页选择「使用已保存的店铺授权」。令牌通过 Windows DPAPI 保存于 `data/tiktok-auth/authorization.dpapi`，绑定当前 Windows 用户。该文件和证书私钥不应打包或分享。新版在取数时检查过期时间并自动续期，刷新令牌到期后通过官方入口重新授权。

## 本机自动启动

从本目录运行 `.\start-tiktok-auth.cmd -RememberCredentials`，按提示输入同一组应用凭据一次。凭据经 Windows DPAPI 加密保存于 `data/tiktok-auth/app-credentials.dpapi`，和店铺授权分开保存。已有保存记录时，默认启动器会读取当前 Windows 用户的记录，重复运行 `-RememberCredentials` 也会直接使用保存的记录启动。同步命令会优先使用运行中的服务，端口尚未监听时会启动本机后台服务，然后复用已保存的店铺授权。更换应用凭据或需要重新录入时，使用 `.\start-tiktok-auth.cmd -ReplaceCredentials`。凭据、令牌和证书私钥均只留本机。

手动双击 `start-tiktok-auth.cmd` 时，服务已在运行会显示地址并等待按键。此时按任意键可关闭提示窗口，原服务仍可使用。

## 同步 SKU 账本所需数据

在项目根目录执行以下命令。参数是马来西亚示例店 `example-shop-my` 店铺在授权结果页的 ID。

```powershell
node apps/customer-service/sync-tiktok-shop.mjs --shop 9000000000000000099
```

每次取全量商品目录和固定近 7 天窗口内的订单，按商品 ID 和 SKU ID 核对订单明细。完成两路分页后才生成带时间戳的本机快照；失败时保留已有快照。快照保留经营对账字段，收件信息和令牌留在接口处理流程内。退款、结算、成本及广告需分别接入利润账本。

对同一批订单补退款和结算时，传入上一步生成的快照文件名。

```powershell
node apps/customer-service/sync-tiktok-shop.mjs --shop 9000000000000000099 --finance <订单快照文件名>
```

本机财务快照保留订单和 SKU 对照、退款申请与完成状态、结算单及打款状态。结算单金额与买家退款金额分别保留原币种和原始精度。未命中扫描结算单的订单保留待核对状态，某路接口读取失败时对应金额和计数留空。退款金额用于与平台结算明细核对，已体现在结算金额里的退款不再次扣减。

客服权限已提交申请，按 Partner Center 中 Customer Service 的单项状态确认。待获批且需要接入时，再根据页面提示重新授权并验收。挂车视频发布另核 Content Posting（`creator.video.write`）和发片 TikTok 账号的授权，要求是这款马来跨境自定义应用和对应账号有资格。后台查不到该权限时，请已对接的生态同事按应用和账号核对是否开放、入口和材料。

### 挂车账号授权影子验收

本机回调已支持按原 TikTok 账号及商品 ID 验证达人授权。验收用两个环境变量指定 `TTS_CREATOR_TRIAL_ACCOUNT` 和 `TTS_CREATOR_TRIAL_PRODUCT_ID`，通过 `/tts/creator/connect` 发起，同用已登记的 `/tts/authorize` 回调。回调核对本机一次性会话、应用、`user_type=1`、发布权限、MY 原账号及可挂车商品后，才把达人令牌加密写到 `data/tiktok-auth/creators/<账号>/authorization.dpapi`。官方号和营销号查询绑定店铺商品，联盟达人查询可用橱窗商品。店铺令牌保存路径为 `data/tiktok-auth/authorization.dpapi`。

当前运行中的店铺授权服务尚未启用该入口。实店验收前在 Partner Center 的 App & Service → Manage API 核对本应用 Content Posting 和达人授权资格，并确认达人可在应用里撤销授权。权限核实后由账号本人从该入口完成登录和授权。回调测试只覆盖授权与商品回读。视频上传、预检、提交及平台发布状态各需独立验收。 [达人授权](https://partner.tiktokshop.com/docv2/page/affiliate-integration) · [挂车发布官方流程](https://partner.tiktokshop.com/docv2/page/ng0l9170)

## 从官方只读到店铺运营

| 阶段 | 接入范围 | 验收 |
|---|---|---|
| 官方只读联通 | 店铺、商品样本和近 7 天订单样本 | 真实马来店授权后，样本与 Seller Center 对得上，保存授权后可以再次打开 |
| SKU 利润账本 | 商品与订单分页、退款、平台结算、采购和履约成本、广告素材表现 | 用店铺 ID、商品 ID、SKU ID、订单 ID 和真实视频 ID 对齐来源，历史回放和人工抽样一致，缺失项保留未知 |
| 履约与商品管理 | 先演练选仓、核价和改动方案，再按现有权限小量执行 | 同笔订单或 SKU 的写动作有唯一记录，执行后独立回查 |
| 发布与客服 | 挂车发布通道取决于官方权限和账号资格，客服取决于权限审核及消息联调 | 已验证的官方通道逐项替换紫鸟操作，发布脚本共用原规划、去重和账本 |

工作台沿用项目运营模块登记与现有执行记录。商品和订单使用同一套店铺、商品、SKU 和订单标识，视频使用视频 ID，广告使用广告账户和素材 ID。任务从建议、演练、执行到回查各自保留回执。

| 工作台板块 | 接入入口 |
|---|---|
| 总指挥与经营复盘 | 现有任务、决策日志、人工处理事项和复盘 |
| 选品、核价、上架、促销 | 现有选品和商品资料、成本表、审核和执行回执 |
| 内容制作、发布、投流、达人 | 现有素材及发布台账，按权限分别接官方 API 或原执行入口 |
| 采购、库存、履约、客服售后 | 仓库和订单记录、履约判例、售后与异常记录 |
| 订单财务 | 官方商品订单快照、退款、结算及之后的采购履约成本对账 |

经营决策沿用原手册和决策日志。脚本负责取数、核算、限额、防重和执行后回查。模型依据账本提出下一步，记录依据、预期及复查日期，超出现有授权的动作交给负责人。

2026-11-12，马来西亚示例店商品和近 7 天订单的真实分页已验收。后台启动已复用实际加密凭据和店铺授权。以同一批 118 笔订单复验，售后接口返回 0 条记录，结算匹配到 15 笔订单及其 SKU 明细。只读接口遇到限流时按平台返回的等待时间有限重试。客服工作台使用测试数据。

[自定义应用发布流程](https://partner.tiktokshop.com/docv2/page/64f198e74830a5028854bf8f) · [已授权店铺](https://partner.tiktokshop.com/docv2/page/6507ead7b99d5302be949ba9) · [商品搜索](https://partner.tiktokshop.com/docv2/page/6503081a56e2bb0289dd6d7d) · [挂车视频方案](https://partner.tiktokshop.com/docv2/page/ng0l9170)
