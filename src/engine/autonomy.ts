import type { AutonomyLevel } from "../types.js";

export type AutonomyPolicy = {
  /** Auto-approve a `planFirst` task without asking the user. */
  autoApprovePlan: boolean;
  /** Auto-approve plans whose confidence is below `planFirstThreshold`. */
  autoApproveLowConfidence: boolean;
  /** Failure streak size at which we escalate rather than retry. */
  failureStreakToEscalate: number;
  /** Escalate on denied tool calls (the usual hard safety boundary). Only
   *  `super-yolo` sets this to false. */
  escalateOnDeniedTool: boolean;
  /** When true, the allowlist/denylist layers are entirely skipped and the
   *  generated PreToolUse hook always returns "allow". Only `super-yolo`. */
  disableToolGuards: boolean;
};

const POLICIES: Record<AutonomyLevel, AutonomyPolicy> = {
  strict: {
    autoApprovePlan: false,
    autoApproveLowConfidence: false,
    failureStreakToEscalate: 2,
    escalateOnDeniedTool: true,
    disableToolGuards: false,
  },
  normal: {
    autoApprovePlan: false,
    autoApproveLowConfidence: false,
    failureStreakToEscalate: 3,
    escalateOnDeniedTool: true,
    disableToolGuards: false,
  },
  high: {
    autoApprovePlan: true,
    autoApproveLowConfidence: true,
    failureStreakToEscalate: 5,
    escalateOnDeniedTool: true,
    disableToolGuards: false,
  },
  yolo: {
    autoApprovePlan: true,
    autoApproveLowConfidence: true,
    failureStreakToEscalate: 10,
    escalateOnDeniedTool: true,
    disableToolGuards: false,
  },
  "super-yolo": {
    autoApprovePlan: true,
    autoApproveLowConfidence: true,
    failureStreakToEscalate: 999,
    escalateOnDeniedTool: false,   // bypass even denied tools
    disableToolGuards: true,        // bypass allowlist/denylist/path-scope
  },
};

export function policyFor(level: AutonomyLevel): AutonomyPolicy {
  return POLICIES[level] ?? POLICIES.normal;
}

const VALID = new Set<AutonomyLevel>(["strict", "normal", "high", "yolo", "super-yolo"]);

export function isAutonomyLevel(x: unknown): x is AutonomyLevel {
  return typeof x === "string" && VALID.has(x as AutonomyLevel);
}

export function parseAutonomyLevel(x: unknown): AutonomyLevel | null {
  if (!x || typeof x !== "string") return null;
  const normalized = x.toLowerCase().trim();
  if (
    normalized === "super-yolo" || normalized === "superyolo" ||
    normalized === "unsafe" || normalized === "no-guard" ||
    normalized === "no-guards" || normalized === "bypass"
  ) return "super-yolo";
  if (normalized === "yolo" || normalized === "full-yolo" || normalized === "auto-approve") return "yolo";
  if (normalized === "high" || normalized === "fast") return "high";
  if (normalized === "normal" || normalized === "default" || normalized === "balanced") return "normal";
  if (normalized === "strict" || normalized === "careful" || normalized === "paranoid") return "strict";
  return null;
}

export function isSuperYolo(level: AutonomyLevel): boolean {
  return level === "super-yolo";
}
