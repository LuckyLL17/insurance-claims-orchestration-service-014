# 保险理赔案件编排与反欺诈调查服务

一个可本地运行的 Node.js + TypeScript 纯后端项目。系统不依赖 Docker、数据库或第三方服务，使用内存事件存储模拟真实的理赔领域基础设施，适合继续扩展 0-1、Feature、Bug 和综合题。

## 核心能力

- 保单版本与事故发生时间的责任快照
- 报案、补件、查勘、核验、理算、支付、结案状态机
- 事件溯源、幂等事件接收、乱序事件重放
- 可冻结、发布和回滚的规则版本
- 证据版本链、哈希、引用快照和审计轨迹
- 分阶段支付、追回、冲正和赔付上限账本
- 跨境多币种结算：损失币种、保单责任币种、支付账户币种、追回币种可以不同
- 汇率来源版本/有效时间/换算精度（bigint 精确换算）、舍入残差（分数精确值）与汇兑差额领域模型
- 责任快照、理算批准、授权、结算、冲正、追回各环节冻结汇率事实；支付重试不重复换算
- 部分结算末笔吸收累计舍入残差精确闭合；逆向冲正负镜像回滚到原始汇率依据
- 跨币种余额、汇兑差额、支付对账接口；事件重放只读冻结事实、禁止读取当前汇率
- 设备、车辆、人员、维修厂、账户的风险关联图
- 调查任务租约、过期提交保护和重派
- 单案件及跨案件风险解释

## 启动

```bash
npm install
npm run build
npm test
npm start
```

服务默认监听 `http://localhost:4100`，可用 `PORT=4200 npm start` 修改端口。

## 示例

```bash
curl http://localhost:4100/health
curl -X POST http://localhost:4100/claims \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-claim-1' \
  -d '{"policyId":"P-100","lossAt":"2026-10-06T08:00:00Z","reportedAt":"2026-10-06T09:00:00Z","participants":[{"kind":"person","id":"person-1"},{"kind":"vehicle","id":"car-1"}],"loss":{"currency":"CNY","gross":18000},"channel":"mobile"}'
```

### 跨境多币种结算

```bash
# 理算批准：按保单责任币种核定，事件中冻结 损失币种->责任币种 汇率
curl -X POST http://localhost:4100/claims/$CID/adjustments/approve
# 授权：责任币种金额 -> 支付账户币种，冻结授权汇率事实
curl -X POST http://localhost:4100/claims/$CID/payment-authorizations \
  -d '{"sourceId":"auth-1","amount":1000,"accountCurrency":"EUR","at":"2026-09-20T10:00:00Z"}'
# 部分结算（可带渠道实际成交汇率 explicitRate，差额计入汇兑差额）
curl -X POST http://localhost:4100/claims/$CID/payments \
  -d '{"sourceId":"pay-1","authorizationSourceId":"auth-1","liabilityAmount":300}'
# 冲正：不填 amount 为全额负镜像（精确回滚原始汇率依据），也可部分冲正
curl -X POST http://localhost:4100/claims/$CID/reversals -d '{"sourceId":"rev-1","reversesSourceId":"pay-1"}'
# 追回：币种可与损失/责任/支付币种都不同
curl -X POST http://localhost:4100/claims/$CID/recoveries -d '{"sourceId":"rec-1","currency":"JPY","amount":10000}'
# 跨币种余额 / 汇兑差额 / 支付对账
curl http://localhost:4100/claims/$CID/fx-balances
curl http://localhost:4100/claims/$CID/fx-differences
curl http://localhost:4100/claims/$CID/payment-reconciliation
# 发布新汇率版本
curl -X POST http://localhost:4100/fx-rates -d '{"sourceId":"ECB","sourceVersion":"2026-10-07","quotes":[{"from":"USD","to":"CNY","rate":"7.25","effectiveAt":"2026-10-07T00:00:00Z","rateType":"SPOT"}]}'
```


## 目录说明

- `src/domain`：理赔领域模型、规则、账本、证据、风险图谱和任务租约
- `src/application`：事件存储、案件编排、支付、风险、任务和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
