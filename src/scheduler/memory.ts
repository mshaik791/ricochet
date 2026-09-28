import { randomUUID } from "node:crypto";
import type { ScheduledStep } from "../domain/types.js";
import type { Scheduler } from "./types.js";

/** Dev/test scheduler. Prod replaces this with a scheduled_steps table + runner. */
export class MemoryScheduler implements Scheduler {
  steps = new Map<string, ScheduledStep>();

  async schedule(step: Omit<ScheduledStep, "id" | "attempts">) {
    const s: ScheduledStep = { ...step, id: randomUUID(), attempts: 0 };
    this.steps.set(s.id, s);
    return s;
  }
  async reschedule(id: string, runAt: Date) {
    const s = this.steps.get(id);
    if (s) this.steps.set(id, { ...s, runAt, attempts: s.attempts + 1 });
  }
  async complete(id: string) { this.steps.delete(id); }
  async cancelForLead(leadId: string) {
    let n = 0;
    for (const [id, s] of this.steps) if (s.leadId === leadId) { this.steps.delete(id); n++; }
    return n;
  }
  async due(now: Date) {
    return [...this.steps.values()].filter((s) => s.runAt.getTime() <= now.getTime()).sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }
  async pendingForLead(leadId: string) {
    return [...this.steps.values()].filter((s) => s.leadId === leadId).sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }
}
