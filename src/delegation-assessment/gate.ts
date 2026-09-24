import type { Assessment, Mode } from "./policy.ts";

export interface GateSnapshot { requestId: string; generation: number; identity?: string; }
export interface GateState {
  requestId?: string; generation: number; assessment?: Assessment; assessmentGeneration?: number;
  pending?: GateSnapshot; dispatches: Map<string, GateSnapshot>;
  deviation?: { identity: string; reason: string }; disabled: boolean; warned: boolean;
}
export class Gate {
  readonly state: GateState = { generation: 0, dispatches: new Map(), disabled: false, warned: false };
  newRequest(requestId: string): void {
    const accepted = !this.state.pending ? this.state.assessment : undefined;
    this.state.requestId = requestId; this.advance();
    if (accepted) { this.state.assessment = accepted; this.state.assessmentGeneration = this.state.generation; }
  }
  resetSession(): void { this.state.requestId = undefined; this.advance(); this.state.disabled = false; this.state.warned = false; }
  private advance(): void { this.state.generation++; this.state.assessment = undefined; this.state.assessmentGeneration = undefined; this.state.pending = undefined; this.state.dispatches.clear(); this.state.deviation = undefined; }
  snapshot(): GateSnapshot | undefined { return this.state.requestId ? { requestId: this.state.requestId, generation: this.state.generation } : undefined; }
  beginAssessment(identity: string): GateSnapshot | undefined {
    const current = this.snapshot();
    if (!current) return undefined;
    if (this.state.pending?.identity === identity) return this.state.pending;
    if (this.state.assessment?.identity === identity && this.state.assessmentGeneration === current.generation) return { ...current, identity };
    this.advance();
    const snapshot = this.snapshot();
    if (snapshot) { snapshot.identity = identity; this.state.pending = snapshot; }
    return snapshot;
  }
  isCurrent(snapshot: GateSnapshot): boolean { return this.state.requestId === snapshot.requestId && this.state.generation === snapshot.generation && !this.state.disabled; }
  record(snapshot: GateSnapshot, assessment: Assessment): boolean {
    if (!this.isCurrent(snapshot)) return false;
    if (this.state.assessmentGeneration === snapshot.generation && this.state.assessment?.identity === assessment.identity) return true;
    this.state.pending = undefined; this.state.assessment = assessment; this.state.assessmentGeneration = snapshot.generation;
    this.state.dispatches.clear(); this.state.deviation = undefined; return true;
  }
  invalidateAssessment(): void { this.advance(); }
  assessmentNeed(contextTokens: number | null, growth: number): "missing" | "pending" | "context_growth" | null {
    if (this.state.pending) return "pending";
    const assessment = this.state.assessment;
    if (!this.state.requestId || !assessment || this.state.assessmentGeneration !== this.state.generation) return "missing";
    return contextTokens !== null && assessment.contextTokens !== null && contextTokens - assessment.contextTokens >= growth ? "context_growth" : null;
  }
  needsAssessment(contextTokens: number | null, growth: number): boolean { return this.assessmentNeed(contextTokens, growth) !== null; }
  mayWork(mode: Mode, contextTokens: number | null, growth: number): { allowed: boolean; reason?: string } {
    if ((mode !== "enforce" && mode !== "rules-only") || this.state.disabled) return { allowed: true };
    if (this.needsAssessment(contextTokens, growth)) return { allowed: false, reason: "A fresh delegation assessment is required before working tools. Call delegation_assess with bounded English dynamic options." };
    return { allowed: true };
  }
  markDispatch(toolCallId: string): void { const snapshot = this.snapshot(); if (snapshot) this.state.dispatches.set(toolCallId, snapshot); }
  settleDispatch(toolCallId: string, confirmed: boolean): "confirmed" | "current-failed" | "stale" {
    const snapshot = this.state.dispatches.get(toolCallId); this.state.dispatches.delete(toolCallId);
    if (!snapshot || !this.isCurrent(snapshot)) return "stale";
    return confirmed ? "confirmed" : "current-failed";
  }
  recordDeviation(reason: string, contextTokens: number | null, growth: number): boolean {
    const assessment = this.state.assessment;
    if (this.state.disabled || !assessment || this.needsAssessment(contextTokens, growth)) return false;
    this.state.deviation = { identity: assessment.identity, reason }; return true;
  }
  disable(): boolean { if (this.state.disabled) return false; this.state.disabled = true; this.state.pending = undefined; this.state.dispatches.clear(); const first = !this.state.warned; this.state.warned = true; return first; }
}
