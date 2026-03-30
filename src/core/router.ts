/**
 * Information Router — The heart of NTK.
 *
 * This is what makes NTK different from every other multi-agent framework.
 * Messages are NOT broadcast to everyone. They are routed based on:
 * 1. Who needs to know (routing rules)
 * 2. How much they need to know (compression)
 * 3. When they need to know (priority)
 */

import type {
  Message,
  AgentType,
  Phase,
  RoutingRule,
  InfoLevel,
  AGENT_INFO_LEVEL,
} from './protocol.js';

export class Router {
  private rules: RoutingRule[] = [];
  private messageLog: Message[] = [];
  private blockedLog: Array<{ message: Message; reason: string }> = [];

  constructor() {
    this.loadDefaultRules();
  }

  /** Load the default routing rules based on NTK philosophy */
  private loadDefaultRules(): void {
    this.rules = [
      // ─── Gather Phase ───────────────────────
      {
        name: 'gather-to-planner',
        phase: 'gather',
        allow: [
          ['scout', 'planner'],
          ['summarizer', 'planner'],
          ['planner', 'scout'],
          ['planner', 'summarizer'],
        ],
        block: [
          ['scout', 'executor'],
          ['scout', 'verifier'],
          ['summarizer', 'executor'],
          ['summarizer', 'verifier'],
        ],
        compress: true, // Low→High must compress
      },

      // ─── Plan Phase ─────────────────────────
      {
        name: 'plan-dispatch',
        phase: 'plan',
        allow: [
          ['planner', 'executor'],
          ['planner', 'scout'],
        ],
        block: [
          ['executor', 'scout'],
          ['verifier', 'planner'], // Verifier has nothing to say during planning
        ],
        compress: false, // Planner's instructions are already concise
      },

      // ─── Execute Phase ──────────────────────
      {
        name: 'execute-local-loop',
        phase: 'execute',
        allow: [
          ['executor', 'verifier'],
          ['verifier', 'executor'],
        ],
        block: [
          ['executor', 'planner'],  // Don't bother planner with execution details
          ['verifier', 'planner'],  // Don't bother planner with test details
          ['executor', 'scout'],
          ['verifier', 'scout'],
        ],
        compress: false, // Local loop needs full error details
      },

      // ─── Verify Phase ───────────────────────
      {
        name: 'verify-escalate',
        phase: 'verify',
        allow: [
          ['verifier', 'planner'],  // Only when escalating
          ['planner', 'executor'],  // Planner can re-assign
        ],
        block: [
          ['verifier', 'scout'],
          ['verifier', 'summarizer'],
        ],
        compress: true, // Verifier→Planner must compress (just pass/fail + reason)
      },

      // ─── Report Phase ───────────────────────
      {
        name: 'report-aggregate',
        phase: 'report',
        allow: [
          ['planner', 'summarizer'],
          ['summarizer', 'planner'],
        ],
        block: [
          ['executor', 'planner'],
          ['verifier', 'planner'],
          ['scout', 'planner'],
        ],
        compress: true,
      },
    ];
  }

  /**
   * Route a message. Returns true if delivered, false if blocked.
   *
   * This is the core "need-to-know" filter:
   * - Check if the route is allowed in the current phase
   * - If blocked, log it and return false
   * - If allowed but requires compression, flag it
   */
  canRoute(message: Message, currentPhase: Phase): RouteDecision {
    // Find applicable rules
    const applicableRules = this.rules.filter(
      (r) => r.phase === currentPhase || r.phase === '*'
    );

    // Check blocks first (blocks take priority)
    for (const rule of applicableRules) {
      const isBlocked = rule.block.some(
        ([from, to]) => message.from === from && message.to === to
      );
      if (isBlocked) {
        const decision: RouteDecision = {
          allowed: false,
          reason: `Blocked by rule "${rule.name}": ${message.from} → ${message.to} not allowed in ${currentPhase} phase`,
          needsCompression: false,
        };
        this.blockedLog.push({ message, reason: decision.reason });
        return decision;
      }
    }

    // Check allows
    for (const rule of applicableRules) {
      const isAllowed = rule.allow.some(
        ([from, to]) => message.from === from && message.to === to
      );
      if (isAllowed) {
        return {
          allowed: true,
          reason: `Allowed by rule "${rule.name}"`,
          needsCompression: rule.compress,
        };
      }
    }

    // Default: allow but warn (flexible fallback)
    return {
      allowed: true,
      reason: 'No explicit rule found, allowing by default',
      needsCompression: false,
    };
  }

  /** Route a message and record it */
  route(message: Message, currentPhase: Phase): RouteDecision {
    const decision = this.canRoute(message, currentPhase);
    if (decision.allowed) {
      this.messageLog.push(message);
    }
    return decision;
  }

  /**
   * Get visible messages for a specific agent.
   * This is the "selective information" implementation:
   * Each agent only sees messages addressed to them.
   */
  getVisibleMessages(agent: AgentType): Message[] {
    return this.messageLog.filter(
      (m) => m.to === agent || m.from === agent
    );
  }

  /** Add a custom routing rule */
  addRule(rule: RoutingRule): void {
    this.rules.push(rule);
  }

  /** Get blocked message log (useful for debugging) */
  getBlockedLog(): Array<{ message: Message; reason: string }> {
    return [...this.blockedLog];
  }

  /** Get all routed messages */
  getAllMessages(): Message[] {
    return [...this.messageLog];
  }

  /** Get stats */
  getStats(): RouterStats {
    return {
      totalRouted: this.messageLog.length,
      totalBlocked: this.blockedLog.length,
      blockRate: this.blockedLog.length / (this.messageLog.length + this.blockedLog.length) || 0,
      byRoute: this.getRouteCounts(),
    };
  }

  private getRouteCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const msg of this.messageLog) {
      const route = `${msg.from}→${msg.to}`;
      counts[route] = (counts[route] || 0) + 1;
    }
    return counts;
  }
}

export interface RouteDecision {
  allowed: boolean;
  reason: string;
  needsCompression: boolean;
}

export interface RouterStats {
  totalRouted: number;
  totalBlocked: number;
  blockRate: number;
  byRoute: Record<string, number>;
}
