import { ClaimService } from './claim-service';
import { FxReconciler, FxReconciliationReport } from '../domain/fx-reconciliation';

export class FxReportingService {
  constructor(private readonly claims: ClaimService, private readonly reconciler: FxReconciler) {}

  /** 跨币种余额接口。 */
  balances(claimId: string) {
    const claim = this.claims.get(claimId);
    return { claimId: claim.id, liabilityCurrency: claim.liabilityCurrency, balances: this.reconciler.balances(claim) };
  }

  /** 汇兑差额接口。 */
  differences(claimId: string) {
    const claim = this.claims.get(claimId);
    return { claimId: claim.id, ...this.reconciler.fxDifferences(claim) };
  }

  /** 支付对账接口：跨币种余额、分期闭合、冲正回滚与汇兑差额一并核对。 */
  reconcile(claimId: string): FxReconciliationReport {
    return this.reconciler.report(this.claims.get(claimId));
  }
}
