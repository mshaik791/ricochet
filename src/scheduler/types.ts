import type { ScheduledStep } from "../domain/types.js";

export interface Scheduler {
  schedule(step: Omit<ScheduledStep, "id" | "attempts">): Promise<ScheduledStep>;
  reschedule(id: string, runAt: Date): Promise<void>;
  complete(id: string): Promise<void>;
  cancelForLead(leadId: string): Promise<number>;
  due(now: Date): Promise<ScheduledStep[]>;
  pendingForLead(leadId: string): Promise<ScheduledStep[]>;
}
