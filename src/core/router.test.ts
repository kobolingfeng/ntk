import { beforeEach, describe, expect, it } from 'vitest';
import type { Phase } from './protocol.js';
import { createMessage } from './protocol.js';
import { Router } from './router.js';

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    router = new Router();
  });

  // ─── Gather Phase ────────────────────────────────

  describe('gather phase routing', () => {
    const phase: Phase = 'gather';

    it('allows scout → planner', () => {
      const msg = createMessage('scout', 'planner', 'report', 'data');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
      expect(d.needsCompression).toBe(true);
    });

    it('allows summarizer → planner', () => {
      const msg = createMessage('summarizer', 'planner', 'summary', 'data');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
      expect(d.needsCompression).toBe(true);
    });

    it('allows planner → scout', () => {
      const msg = createMessage('planner', 'scout', 'gather', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
    });

    it('allows planner → summarizer', () => {
      const msg = createMessage('planner', 'summarizer', 'summarize', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
    });

    it('blocks scout → executor', () => {
      const msg = createMessage('scout', 'executor', 'run', 'data');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain('gather-to-planner');
    });

    it('blocks scout → verifier', () => {
      const msg = createMessage('scout', 'verifier', 'check', 'data');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks summarizer → executor', () => {
      const msg = createMessage('summarizer', 'executor', 'run', 'data');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks summarizer → verifier', () => {
      const msg = createMessage('summarizer', 'verifier', 'check', 'data');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });
  });

  // ─── Plan Phase ──────────────────────────────────

  describe('plan phase routing', () => {
    const phase: Phase = 'plan';

    it('allows planner → executor', () => {
      const msg = createMessage('planner', 'executor', 'execute', 'task');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
      expect(d.needsCompression).toBe(false);
    });

    it('allows planner → scout', () => {
      const msg = createMessage('planner', 'scout', 'research', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
    });

    it('blocks executor → scout', () => {
      const msg = createMessage('executor', 'scout', 'ask', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks verifier → planner', () => {
      const msg = createMessage('verifier', 'planner', 'feedback', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });
  });

  // ─── Execute Phase ───────────────────────────────

  describe('execute phase routing', () => {
    const phase: Phase = 'execute';

    it('allows executor → verifier', () => {
      const msg = createMessage('executor', 'verifier', 'verify', 'code');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
      expect(d.needsCompression).toBe(false);
    });

    it('allows verifier → executor', () => {
      const msg = createMessage('verifier', 'executor', 'fix', 'issue');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
    });

    it('blocks executor → planner', () => {
      const msg = createMessage('executor', 'planner', 'help', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks verifier → planner', () => {
      const msg = createMessage('verifier', 'planner', 'report', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks executor → scout', () => {
      const msg = createMessage('executor', 'scout', 'ask', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks verifier → scout', () => {
      const msg = createMessage('verifier', 'scout', 'ask', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });
  });

  // ─── Verify Phase ────────────────────────────────

  describe('verify phase routing', () => {
    const phase: Phase = 'verify';

    it('allows verifier → planner (escalation)', () => {
      const msg = createMessage('verifier', 'planner', 'escalate', 'failed');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
      expect(d.needsCompression).toBe(true);
    });

    it('allows planner → executor (re-assign)', () => {
      const msg = createMessage('planner', 'executor', 'redo', 'fix this');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
    });

    it('blocks verifier → scout', () => {
      const msg = createMessage('verifier', 'scout', 'ask', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks verifier → summarizer', () => {
      const msg = createMessage('verifier', 'summarizer', 'summarize', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });
  });

  // ─── Report Phase ────────────────────────────────

  describe('report phase routing', () => {
    const phase: Phase = 'report';

    it('allows planner → summarizer', () => {
      const msg = createMessage('planner', 'summarizer', 'report', 'data');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
      expect(d.needsCompression).toBe(true);
    });

    it('allows summarizer → planner', () => {
      const msg = createMessage('summarizer', 'planner', 'summary', 'report');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(true);
    });

    it('blocks executor → planner', () => {
      const msg = createMessage('executor', 'planner', 'done', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks verifier → planner', () => {
      const msg = createMessage('verifier', 'planner', 'done', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });

    it('blocks scout → planner', () => {
      const msg = createMessage('scout', 'planner', 'info', '');
      const d = router.canRoute(msg, phase);
      expect(d.allowed).toBe(false);
    });
  });

  // ─── Default behavior ───────────────────────────

  describe('default behavior', () => {
    it('allows unmatched routes by default', () => {
      // planner → verifier has no explicit rule in gather phase
      const msg = createMessage('planner', 'verifier', 'check', '');
      const d = router.canRoute(msg, 'gather');
      expect(d.allowed).toBe(true);
      expect(d.reason).toContain('No explicit rule');
      expect(d.needsCompression).toBe(false);
    });

    it('block takes priority over allow', () => {
      // In report phase, scout→planner is blocked by 'report-aggregate'
      // even though it's allowed by 'gather-to-planner' (different phase)
      const msg = createMessage('scout', 'planner', 'info', 'data');
      const d = router.canRoute(msg, 'report');
      expect(d.allowed).toBe(false);
    });
  });

  // ─── route() method ─────────────────────────────

  describe('route()', () => {
    it('adds allowed messages to message log', () => {
      const msg = createMessage('planner', 'executor', 'do', 'task');
      router.route(msg, 'plan');
      expect(router.getAllMessages()).toHaveLength(1);
      expect(router.getAllMessages()[0]).toBe(msg);
    });

    it('does not add blocked messages to message log', () => {
      const msg = createMessage('scout', 'executor', 'run', '');
      router.route(msg, 'gather');
      expect(router.getAllMessages()).toHaveLength(0);
    });

    it('adds blocked messages to blocked log', () => {
      const msg = createMessage('scout', 'executor', 'run', '');
      router.route(msg, 'gather');
      expect(router.getBlockedLog()).toHaveLength(1);
      expect(router.getBlockedLog()[0].message).toBe(msg);
    });
  });

  // ─── getVisibleMessages() ───────────────────────

  describe('getVisibleMessages()', () => {
    it('returns messages where agent is sender or receiver', () => {
      const m1 = createMessage('planner', 'executor', 'do', 'task1');
      const m2 = createMessage('executor', 'verifier', 'verify', 'result');
      const m3 = createMessage('verifier', 'executor', 'fix', 'bug');
      router.route(m1, 'plan');
      router.route(m2, 'execute');
      router.route(m3, 'execute');

      const executorMsgs = router.getVisibleMessages('executor');
      expect(executorMsgs).toHaveLength(3); // m1 (to), m2 (from), m3 (to)

      const plannerMsgs = router.getVisibleMessages('planner');
      expect(plannerMsgs).toHaveLength(1); // m1 (from)

      const scoutMsgs = router.getVisibleMessages('scout');
      expect(scoutMsgs).toHaveLength(0);
    });
  });

  // ─── getStats() ─────────────────────────────────

  describe('getStats()', () => {
    it('calculates block rate correctly', () => {
      const allowed = createMessage('planner', 'executor', 'do', 'task');
      const blocked = createMessage('scout', 'executor', 'run', '');
      router.route(allowed, 'plan');
      router.route(blocked, 'gather');

      const stats = router.getStats();
      expect(stats.totalRouted).toBe(1);
      expect(stats.totalBlocked).toBe(1);
      expect(stats.blockRate).toBe(0.5);
    });

    it('returns 0 blockRate when no messages', () => {
      const stats = router.getStats();
      expect(stats.blockRate).toBe(0);
    });

    it('counts routes correctly', () => {
      router.route(createMessage('planner', 'executor', 'a', ''), 'plan');
      router.route(createMessage('planner', 'executor', 'b', ''), 'plan');
      router.route(createMessage('executor', 'verifier', 'c', ''), 'execute');

      const stats = router.getStats();
      expect(stats.byRoute['planner→executor']).toBe(2);
      expect(stats.byRoute['executor→verifier']).toBe(1);
    });
  });

  // ─── addRule() ──────────────────────────────────

  describe('addRule()', () => {
    it('custom rule can block previously allowed routes', () => {
      router.addRule({
        name: 'custom-block',
        phase: 'plan',
        allow: [],
        block: [['planner', 'executor']],
        compress: false,
      });

      const msg = createMessage('planner', 'executor', 'do', 'task');
      const d = router.canRoute(msg, 'plan');
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain('custom-block');
    });

    it('custom wildcard rule applies to all phases', () => {
      router.addRule({
        name: 'global-block',
        phase: '*' as any,
        allow: [],
        block: [['scout', 'summarizer']],
        compress: false,
      });

      const msg = createMessage('scout', 'summarizer', 'test', '');
      expect(router.canRoute(msg, 'gather').allowed).toBe(false);
      expect(router.canRoute(msg, 'plan').allowed).toBe(false);
      expect(router.canRoute(msg, 'execute').allowed).toBe(false);
    });
  });
});
