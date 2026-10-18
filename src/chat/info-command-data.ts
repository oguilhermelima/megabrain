export type InfoLimit = { label: string; usedPercent: number; resetsAt: string; window: "5h" | "weekly" | "monthly" | "other" };
export type InfoCommandData = {
  model?: string;
  effort?: string;
  approvals?: string;
  sandbox?: string;
  cwd?: string;
  session?: { id: string; startedAt?: string; turns?: number };
  context?: { used: number; window: number; percent: number };
  limits?: InfoLimit[];
  cost?: { total: number; currency: string; byModel?: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }> };
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
};
