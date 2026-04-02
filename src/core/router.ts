/**
 * Information Router — The heart of NTK.
 *
 * This is what makes NTK different from every other multi-agent framework.
 * Messages are NOT broadcast to everyone. They are routed based on:
 * 1. Who needs to know (routing rules)
 * 2. How much they need to know (compression)
 * 3. When they need to know (priority)
 */

import type { AgentType, Message, Phase, RoutingRule } from './protocol.js';

/** Module-level immutable default rules — avoids re-creating the array per Pipeline */
const DEFAULT_RULES: readonly RoutingRule[] = Object.freeze([
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
    compress: true,
  },
  {
    name: 'plan-dispatch',
    phase: 'plan',
    allow: [
      ['planner', 'executor'],
      ['planner', 'scout'],
    ],
    block: [
      ['executor', 'scout'],
      ['verifier', 'planner'],
    ],
    compress: false,
  },
  {
    name: 'execute-local-loop',
    phase: 'execute',
    allow: [
      ['executor', 'verifier'],
      ['verifier', 'executor'],
    ],
    block: [
      ['executor', 'planner'],
      ['verifier', 'planner'],
      ['executor', 'scout'],
      ['verifier', 'scout'],
    ],
    compress: false,
  },
  {
    name: 'verify-escalate',
    phase: 'verify',
    allow: [
      ['verifier', 'planner'],
      ['planner', 'executor'],
    ],
    block: [
      ['verifier', 'scout'],
      ['verifier', 'summarizer'],
    ],
    compress: true,
  },
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
]);

/** Pre-computed route lookup: phase -> "from->to" -> { allowed, compress, ruleName } */
type RouteLookup = Map<string, Map<string, { allowed: boolean; compress: boolean; ruleName: string }>>;

function buildRouteLookup(rules: readonly RoutingRule[]): RouteLookup {
  const lookup: RouteLookup = new Map();
  for (const rule of rules) {
    if (!lookup.has(rule.phase)) lookup.set(rule.phase, new Map());
    const phaseMap = lookup.get(rule.phase)!;
    // Blocks take priority — register first
    for (const [from, to] of rule.block) {
      phaseMap.set(`${from}->${to}`, { allowed: false, compress: false, ruleName: rule.name });
    }
  }
  for (const rule of rules) {
    const phaseMap = lookup.get(rule.phase)!;
    for (const [from, to] of rule.allow) {
      const key = `${from}->${to}`;
      if (!phaseMap.has(key)) { // Don't override blocks
        phaseMap.set(key, { allowed: true, compress: rule.compress, ruleName: rule.name });
      }
    }
  }
  return lookup;
}

const DEFAULT_LOOKUP = buildRouteLookup(DEFAULT_RULES);

export class Router {
  private rules: readonly RoutingRule[] = DEFAULT_RULES;
  private routeLookup: RouteLookup = DEFAULT_LOOKUP;
  private messageLog: Message[] = [];
  private blockedLog: Array<{ message: Message; reason: string }> = [];
  /** Per-agent message index: agent → messages where agent is sender or receiver */
  private agentIndex: Map<AgentType, Message[]> = new Map();
  /** Incrementally maintained route counts — avoids O(n) rebuild in getStats() */
  private routeCounts: Record<string, number> = {};

  /**
   * Route a message. Returns true if delivered, false if blocked.
   *
   * This is the core "need-to-know" filter:
   * - Check if the route is allowed in the current phase
   * - If blocked, log it and return false
   * - If allowed but requires compression, flag it
   */
  canRoute(message: Message, currentPhase: Phase): RouteDecision {
    const routeKey = `${message.from}->${message.to}`;

    // Check wildcard phase first (blocks from wildcard take priority)
    const wildcardMap = this.routeLookup.get('*');
    if (wildcardMap) {
      const entry = wildcardMap.get(routeKey);
      if (entry && !entry.allowed) {
        const decision: RouteDecision = {
          allowed: false,
          reason: `Blocked by rule "${entry.ruleName}": ${message.from} → ${message.to} not allowed (wildcard phase)`,
          needsCompression: false,
        };
        this.blockedLog.push({ message, reason: decision.reason });
        return decision;
      }
    }

    const phaseMap = this.routeLookup.get(currentPhase);

    if (phaseMap) {
      const entry = phaseMap.get(routeKey);
      if (entry) {
        if (!entry.allowed) {
          const decision: RouteDecision = {
            allowed: false,
            reason: `Blocked by rule "${entry.ruleName}": ${message.from} → ${message.to} not allowed in ${currentPhase} phase`,
            needsCompression: false,
          };
          this.blockedLog.push({ message, reason: decision.reason });
          return decision;
        }
        return {
          allowed: true,
          reason: `Allowed by rule "${entry.ruleName}"`,
          needsCompression: entry.compress,
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
      // Increment route count inline — avoids O(n) rebuild in getStats()
      const route = `${message.from}→${message.to}`;
      this.routeCounts[route] = (this.routeCounts[route] || 0) + 1;
      // Maintain per-agent index
      const fromList = this.agentIndex.get(message.from);
      if (fromList) fromList.push(message);
      else this.agentIndex.set(message.from, [message]);
      if (message.to !== message.from) {
        const toList = this.agentIndex.get(message.to);
        if (toList) toList.push(message);
        else this.agentIndex.set(message.to, [message]);
      }
    }
    return decision;
  }

  /**
   * Get visible messages for a specific agent.
   * This is the "selective information" implementation:
   * Each agent only sees messages addressed to them.
   */
  getVisibleMessages(agent: AgentType): Message[] {
    return this.agentIndex.get(agent) ?? [];
  }

  /** Add a custom routing rule (creates a mutable copy and rebuilds lookup) */
  addRule(rule: RoutingRule): void {
    if (this.rules === DEFAULT_RULES) {
      this.rules = [...DEFAULT_RULES];
    }
    (this.rules as RoutingRule[]).push(rule);
    this.routeLookup = buildRouteLookup(this.rules);
  }

  /** Get blocked message log (useful for debugging) */
  getBlockedLog(): readonly { message: Message; reason: string }[] {
    return this.blockedLog;
  }

  /** Get all routed messages */
  getAllMessages(): readonly Message[] {
    return this.messageLog;
  }

  /** Get stats */
  getStats(): RouterStats {
    return {
      totalRouted: this.messageLog.length,
      totalBlocked: this.blockedLog.length,
      blockRate: this.blockedLog.length / (this.messageLog.length + this.blockedLog.length) || 0,
      byRoute: this.routeCounts,
    };
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
