import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
import { FxRateBoard } from '../domain/fx';

export class ReplayService {
  constructor(private readonly events: EventStore, private readonly claims: ClaimService, private readonly fx: FxRateBoard) {}

  execute(claimId: string, until?: number) {
    const events = this.events.list(claimId).filter((event) => until === undefined || event.sequence <= until);
    // 双重保险：ReplayService 自己也把重放包在 blockReads 中，确保事件重放只能
    // 使用事件中冻结的汇率事实，任何尝试读取当前汇率的行为立即失败。
    const state = this.fx.blockReads(() => this.claims.replay(claimId, events));
    return { claimId, eventCount: events.length, state, events };
  }
}
