# 店铺写控制离线影子包 v1

**整个包仅为 fixture 离线样例。`FIXTURE_VERIFIED` /「已核实」只表示样例证据核对通过，不表示真实店铺上架、促销、视频发布或任何业务成功。**

本包没有真实执行器、HTTP 服务、平台适配器、网络调用、线上环境开关或外部依赖。不会读取现有凭据、环境变量或 `.private`，不会连接 TikTok，不会修改原云端只读包、黄色界面或生产脚本。只支持 `listing.create` 与 `promotion.configure` 两种样例提案；退款、广告预算、物流发货和视频发布均不在动作白名单。

## 运行

Node.js 22.16.0 及以上；使用标准库 `node:sqlite`、`node:test`。不需要安装依赖。

```powershell
npm test
npm run demo
```

Node 22 的 SQLite 会输出标准库实验性提示，这是运行时状态。测试和示例使用系统临时目录中的独立新 SQLite 文件，结束后关闭数据库并清理自己的临时目录。示例唯一的“发送”是将内存整数 `fakeSendCount` 加一，最终值为 1。

## 信任边界与固定 API

`createAuthority(configuration)` 的配置只能由受信任的服务启动代码提供。每个配置条目必须有 `principal_id, tenant_id, grant_id, service_id, shop_id, region, capabilities, actions, sku_ids`；身份与 SKU 均使用 `fixture_` 前缀的合成 ID。配置深复制并冻结，后续修改原配置无效。`examples/fixture-config.mjs` 提供三个合成人员。

`authority.principal(trustedPrincipalId)` 只给服务端认证适配代码调用；**不得用请求 body 中的 caller/agent/principal/tenant 值调用它**。本包不提供登录、认证端点或凭据校验，也不能替代认证中间件。返回值是该 authority 私有 WeakMap 中的冻结不透明对象；同名配置的另一 authority、body 对象和复制对象都不能代替它。

| 能力 | 可做的事 | 不可做的事 |
| --- | --- | --- |
| `read` | 查看完全相同主体及绑定范围的提案，生成本地只读任务投影 | 跨主体浏览、提案、审批、领取 |
| `propose` | 在绑定 shop/region、动作白名单、已配置 SKU 目录内提出样例意图 | 将岗位任务授权充当业务审批 |
| `approve_fixture` | 相同 tenant/grant/service/shop/region 下，按准确意图和哈希审批已知请求 | 跨范围审批、任意读取别人的提案、审批真实业务 |
| `claim_fixture` | 原提案主体在准确 fixture 审批后领取一次，或按原领取核对证据 | 接管其他主体、重置 UNKNOWN、重新发送 |

审批人可以是不同 principal，但其余五项绑定必须相同，并且具有该动作权限。审批接口只接受审批人已知的准确意图；请求不存在、绑定范围不符、意图/hash 不匹配统一返回固定 403 `ACCESS_DENIED`，在完整匹配前不暴露请求存在性或动作权限。不开放跨主体的 get/list。普通另一主体无论请求是否存在，都在请求命名空间检查时被拒绝。配置的只读主体不能 propose/approve/claim；同一进程内受信任代码能够创建新配置，属于受信任启动边界，不能把该工厂暴露给外部请求。

```js
const authority = createAuthority(serverFixtureConfiguration);
const store = new WriteStore({
  file: '/absolute/owned/shadow.sqlite', authority,
  // 仅受信任、只读、离线 fixture 数据源；不接受请求 body 传入函数或证明。
  readFixture: async (query) => fixtureDatabaseRead(query)
});
const record = store.propose(authenticatedPrincipal, request);
store.approveFixture(authenticatedApprover, exactApproval);
const once = store.claimFixture(authenticatedPrincipal, originalFixtureIds);
// 包本身从不发送。测试程序只能在 once.claimed === true 后模拟一次发送。
const result = await store.reconcileFixture(authenticatedPrincipal, {
  request_id, shop_id, claim_token: once.claim_token
});
store.get(authenticatedPrincipal, { request_id, shop_id });
store.list(authenticatedPrincipal);
projectTask(result);
store.close();
```

原始 SQLite 句柄和任意 SQL 不导出。`close()` 可重复调用。首次仅创建自己的新 `.sqlite` 文件；后续重开必须有本包元数据标记，拒绝接管其他数据库。操作使用 WAL、FULL synchronous、5 秒 busy_timeout 与 `BEGIN IMMEDIATE`。不要在多个进程同时初始化一个尚不存在的同名文件；先由一个启动入口创建，再交给各进程重开。该限制不影响已初始化文件的并发领取。

## 严格提案结构

请求只接受以下字段，不允许 metadata、身份字段、额外字段或缺字段。`request_id` 必须是 `${principal_id}:fixture_<request>`，这同时隔离其他主体对已存在 ID 的探测。动作及 shop 必须匹配受信任配置。

```json
{
  "request_id": "fixture_demo_author:fixture_demo_request",
  "shop_id": "fixture_demo_shop",
  "action": "listing.create",
  "listing": { "client_sku": "fixture_demo_new_sku", "quantity": 2, "currency": "MYR", "amount": "12.30" }
}
```

```json
{
  "request_id": "fixture_demo_author:fixture_demo_promotion",
  "shop_id": "fixture_demo_shop",
  "action": "promotion.configure",
  "items": [{ "sku_id": "fixture_demo_existing_sku", "quantity": 2 }],
  "currency": "MYR",
  "amount": "8.00"
}
```

已有 SKU 必须存在于当前主体的服务端 `sku_ids` 样例目录；新 listing 只使用合成 client SKU，不声称已取得真实平台 objectId。促销 items 为 1–100 个不重复 SKU；数组顺序有意义。quantity 是 1–1,000,000 的安全整数；金额为正的两位小数字符串，整数部分最多 9 位，无前导零、指数、负数或浮点数。MY/TH/US 样例区域分别固定 MYR/THB/USD。

`canonicalJson` 只接受普通对象、普通密集数组和受限 JSON 原始值；拒绝非普通原型、prototype/constructor/__proto__ 键、访问器、符号、undefined、稀疏数组、循环、非安全整数、负零、NaN、Infinity 和浮点值。对象键排序，数组不排序。意图哈希是包含服务端六项身份绑定及 `fixture_only:true` 的 canonical JSON SHA-256。输入数量、大小和深度有界。

相同 ID + 相同授权主体 + 完全相同意图返回原记录（原时间戳不变）；同一主体改变意图返回 409 `INTENT_CONFLICT`。原意图和身份字段不可修改，并有数据库触发器保护。

## 审批、一次领取与 UNKNOWN

`approveFixture` 只接受 `request_id, shop_id, intent_hash, intent, authority_ref, fixture_only`。`fixture_only` 必须 true；authority_ref 只能为 `fixture://.../...`；intent 必须与原 immutable JSON 完全一致，因此商品/SKU、数量、金额、币种和身份都绑定到审批。岗位任务通过、ACK、普通角色标签不是业务审批。记录保留批准哈希、审批主体、样例授权引用和时间。

`claimFixture` 只接受 `request_id, shop_id, provider_id, provider_request_id, object_id`，后三项都是合成 fixture ID。样例 provider 的原请求和对象 ID 在领取时固定，不代表真实平台已生成对象。包在同一事务中将 `execution_state` 写成 `UNKNOWN`、保存随机领取令牌的 SHA-256、原 provider/request/object IDs 和时间，**COMMIT 之后**才返回一次原始令牌。公共记录从不返回令牌或令牌哈希。

相同请求的其他连接/进程只能得到 `claimed:false`，不会得到原令牌。进程即使在领取后、假发送前崩溃，也保留 UNKNOWN：不偷锁、不 reset、不清除领取、不 requeue、不尝试补发。包中不存在这些 API。令牌丢失后样例可能永久待核，这是明确的保守边界。不可通过换请求 ID 重放同一业务意图；上层仍须做真实对象防重，本包只保证一个请求 ID 的一次领取。

SQLite 不可用、持久化失败或关闭时返回安全 503，不向调用方交付可发送令牌或宣称成功。提案/审批未完成时保留 pending；已提交领取始终保留 UNKNOWN。调用方不得在存储结果不确定后自动新建 ID、重新领取或重新发送，只能保存原请求并核对。数据库文件被外部篡改/删除、恶意同进程代码和故障磁盘不是本包能够证明的安全边界。

## 只读 fixture 核对

`readFixture` 是构造器固定的受信任离线读源，不从请求动态注入。`reconcileFixture` 请求只含原 request_id/shop_id/claim_token；不接受客户端 proof/ACK。只有原主体、原领取令牌与原意图一致才能核对。读取异常、缺证、对象或请求不同、意图不同、scope 不同、hash 不符均保留 UNKNOWN，无写回平台的回调。

读源收到冻结 query，包含准确 identity、action、原 request/intent/claim hash、provider/request/object IDs。有效证明只接受以下五个字段：

```js
const observed_at = new Date().toISOString();
const observation = { fixture_only: true, outcome: 'FIXTURE_CONFIRMED', ...query };
return {
  fixture_only: true, observed_at, observation,
  evidence_ref: 'fixture://evidence/read-001',
  evidence_sha256: sha256(canonicalJson({ observed_at, observation }))
};
```

observation 必须等于全部原 query；时间必须是 UTC ISO，不能早于领取，距离核对完成不超过 60 秒。异步读取完成及事务持久化两处都要求观察时间不晚于当前时钟；即使只在未来 1 毫秒也保持 UNKNOWN。哈希覆盖时间和完整观察。**SHA-256 只能校验证据内容一致，不是平台签名**；可信度来自服务端固定且独立的样例读源。本证明不能用于认证真实 TikTok 结果，需另行设计官方只读证据、权限与审批后才可考虑生产集成。

## 本地只读任务投影

`projectTask(record)` 提供 shop、准确 client SKU/促销 SKU 与数量、样例 provider objectId、负责主体、下一步、状态、来源时间、证据引用/hash、缺失证据。未知 deadline/priority/objectId 返回 null。所有投影始终带有全局 fixture-only 标签。

| 内部状态 | 展示 | 含义 |
| --- | --- | --- |
| PENDING / NOT_CLAIMED | 需要确认 | 等准确样例审批或一次样例领取 |
| UNKNOWN | 结果待核 | 仅只读核对原样例，不得重发 |
| FIXTURE_VERIFIED | 已核实 | 离线样例证据匹配；真实上线仍需独立授权和验收 |

没有修改或重建现有黄色 UI。示例逐阶段输出该投影。

## 错误与验证范围

公开错误只有固定 `status`/`code`/同值 message，不拼接 bearer、输入、SQL 或内部异常。主要类别：401 UNAUTHENTICATED；403 ACCESS_DENIED/ACTION_DENIED/TARGET_DENIED/CLAIM_MISMATCH；400 INVALID_REQUEST；404 REQUEST_NOT_FOUND；409 INTENT_CONFLICT/APPROVAL_MISMATCH/APPROVAL_REQUIRED/CLAIM_REQUIRED；503 STORE_UNCERTAIN/STORE_CLOSED。`APPROVAL_MISMATCH` 仅用于已知准确意图后再次批准时的原审批人/授权引用冲突；不准确意图统一 403，不返回 409。同主体提案改变意图仍返回 409 `INTENT_CONFLICT`。异常信息可安全地按 code 分类；应用仍不得记录认证资料或原始领取令牌。

自动化测试覆盖：跨 tenant/shop/action、只读凭据与伪造 agent、跨 authority 不透明主体、规范化键和数组、金额/数量/未知 SKU/非普通输入、重复 ID 与审批篡改、两连接和真实子进程并发、领取后崩溃再打开、缺失/陈旧/未来/外来/不完整/错误证据、ACK 不能成功、准确 fixture 证明、异步读回后的证据时效、核对后持久化关闭仍保持 UNKNOWN。测试不是实际业务验收。
