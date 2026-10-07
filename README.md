# 保险理赔案件编排与反欺诈调查服务

一个可本地运行的 Node.js + TypeScript 纯后端项目。系统不依赖 Docker、数据库或第三方服务，使用内存事件存储模拟真实的理赔领域基础设施，适合继续扩展 0-1、Feature、Bug 和综合题。

## 核心能力

- 保单版本与事故发生时间的责任快照
- 报案、补件、查勘、核验、理算、支付、结案状态机
- 事件溯源、幂等事件接收、乱序事件重放
- 可冻结、发布和回滚的规则版本
- 证据版本链、哈希、引用快照和审计轨迹
- 分阶段支付、追回、冲正和赔付上限账本
- 多币种结算：损失币种、保单责任币种、支付账户币种、追回币种可不同
- 汇率来源版本、有效时间、换算精度、舍入残差和汇兑差额的领域建模
- 责任快照、理算批准、授权、结算、冲正全程冻结汇率快照，重放只读事件中的汇率事实
- 同一支付重试不重复换算，部分结算与逆向冲正精确回滚到原始汇率依据
- 跨币种余额、汇兑差额和支付对账接口
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

## 多币种结算

```bash
# 登记汇率版本（来源、版本、有效时间）
curl -X POST http://localhost:4100/fx/rates -H 'content-type: application/json' \
  -d '{"pair":"USD/CNY","rateNumerator":710,"rateDenominator":100,"source":"treasury","sourceVersion":"2026-10","effectiveAt":"2026-10-01T00:00:00Z"}'

# 理算批准：按批准时刻汇率折算为保单责任币种并冻结快照
curl -X POST http://localhost:4100/claims/<id>/adjustments -H 'content-type: application/json' \
  -d '{"amount":9000,"currency":"USD"}'

# 授权 / 结算 / 冲正 / 追回（冲正可指定 settlementSourceId 精确回滚原始汇率依据）
curl -X POST http://localhost:4100/claims/<id>/authorizations -d '{"amount":500,"currency":"USD","sourceId":"a-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/<id>/payments       -d '{"amount":1000,"currency":"USD","sourceId":"p-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/<id>/reversals      -d '{"sourceId":"r-1","settlementSourceId":"p-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/<id>/recoveries     -d '{"amount":1000,"currency":"USD","sourceId":"rec-1","againstSourceId":"p-1"}' -H 'content-type: application/json'

# 跨币种余额 / 汇兑差额 / 支付对账
curl http://localhost:4100/claims/<id>/payments/balances
curl http://localhost:4100/claims/<id>/fx/differences
curl http://localhost:4100/claims/<id>/payments/reconciliation
```

## 目录说明

- `src/domain`：理赔领域模型、规则、账本、证据、风险图谱和任务租约
- `src/application`：事件存储、案件编排、支付、风险、任务和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
