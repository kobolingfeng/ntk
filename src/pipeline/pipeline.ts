/**
 * Pipeline — The orchestration engine (v2: Adaptive).
 *
 * Key insight from benchmarks:
 * - NTK's value is COST efficiency (cheap model routing), not raw token reduction.
 * - Over-compression of executor outputs destroys quality.
 * - Simple tasks should bypass most pipeline phases.
 *
 * v2 changes:
 * - Adaptive depth: classify → route to direct/light/standard/full
 * - Report = raw executor outputs + brief summary (no Planner rewrite)
 * - Verify only for standard/full depth
 */

import { Executor } from '../agents/executor.js';
import { Planner } from '../agents/planner.js';
import { Scout } from '../agents/scout.js';
import { Summarizer } from '../agents/summarizer.js';
import { Verifier } from '../agents/verifier.js';
import { Compressor } from '../core/compressor.js';
import { LLMClient } from '../core/llm.js';
import { detectLocale, type Locale, PIPELINE_STRINGS } from '../core/prompts.js';
import type { NTKConfig, Phase, PipelineState } from '../core/protocol.js';
import { Router } from '../core/router.js';

// Submodules
import { classifyDepth } from './classifier.js';
import { runDirect } from './depth-direct.js';
import { runFull } from './depth-full.js';
import { runLight } from './depth-light.js';
import { runStandard } from './depth-standard.js';
import { generateTokenReport } from './helpers.js';

// Re-export types from types.ts
export type { ExecutionResult, PipelineDepth, PipelineEvent, PipelineResult, VerificationResult } from './types.js';

import type { PipelineDepth, PipelineEvent, PipelineResult } from './types.js';

export class Pipeline {
  private config: NTKConfig;
  private router: Router;
  private compressor: Compressor;

  // Agents
  private planner: Planner;
  private scout: Scout;
  private summarizer: Summarizer;
  private executor: Executor;
  private verifier: Verifier;

  // LLM clients (may be different models)
  private plannerLLM: LLMClient;
  private compressorLLM: LLMClient;

  // State
  private state: PipelineState;
  private onEvent?: (event: PipelineEvent) => void;
  private forceDepth?: PipelineDepth;
  private skipScout: boolean = false;
  private locale: Locale = 'zh';
  private get strings() {
    return PIPELINE_STRINGS[this.locale];
  }

  constructor(
    config: NTKConfig,
    onEvent?: (event: PipelineEvent) => void,
    options?: { forceDepth?: PipelineDepth; skipScout?: boolean },
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.forceDepth = options?.forceDepth;
    this.skipScout = options?.skipScout ?? false;

    // Create LLM clients — planner gets the strong model
    this.plannerLLM = new LLMClient(config.planner);
    this.compressorLLM = new LLMClient(config.compressor);

    // Create agents
    this.planner = new Planner(this.plannerLLM);
    this.scout = new Scout(this.compressorLLM);
    this.summarizer = new Summarizer(this.compressorLLM);
    this.executor = new Executor(this.compressorLLM);
    this.verifier = new Verifier(this.compressorLLM);

    // Apply token budgets if configured
    if (config.tokenBudget) {
      const agents = [this.planner, this.scout, this.summarizer, this.executor, this.verifier];
      for (const agent of agents) {
        if (config.tokenBudget[agent.type] !== undefined) {
          agent.tokenBudget = config.tokenBudget[agent.type];
        }
      }
    }

    // Create router & compressor
    this.router = new Router();
    this.compressor = new Compressor(this.compressorLLM);

    // Initialize state
    this.state = {
      phase: 'gather',
      tasks: [],
      messages: [],
      userRequest: '',
    };
  }

  /**
   * Run the pipeline for a user request.
   * v2: Classifies complexity first, then routes to appropriate depth.
   */
  async run(userRequest: string): Promise<PipelineResult> {
    this.state.userRequest = userRequest;

    // Early return for empty / whitespace-only input
    if (!userRequest.trim()) {
      return {
        success: false,
        report: 'No task provided.',
        tokenReport: this.getTokenReport(),
        routerStats: this.router.getStats(),
        blockedMessages: [],
        depth: 'direct',
      };
    }

    // Detect language from user input and propagate to all agents
    this.locale = detectLocale(userRequest);
    const agents = [this.planner, this.scout, this.summarizer, this.executor, this.verifier];
    for (const agent of agents) {
      agent.setLocale(this.locale);
    }
    this.compressor.setLocale(this.locale);

    try {
      // Step 0: Classify task complexity (or use forced depth)
      const depth = this.forceDepth ?? (await classifyDepth(userRequest, this.compressorLLM, this.locale));
      this.emit({ type: 'start', phase: 'gather', detail: `[${depth}] ${userRequest}` });

      switch (depth) {
        case 'direct':
          this.setPhase('execute');
          return await runDirect(
            userRequest,
            this.executor,
            this.locale,
            () => this.getTokenReport(),
            () => this.router.getStats(),
            (e) => this.emit(e),
          );
        case 'light':
          this.setPhase('execute');
          return await runLight(
            userRequest,
            this.executor,
            this.verifier,
            this.router,
            this.strings,
            this.locale,
            () => this.getTokenReport(),
            () => this.router.getStats(),
            (e) => this.emit(e),
          );
        case 'standard':
          this.setPhase('gather');
          return await runStandard(
            userRequest,
            this.executor,
            this.scout,
            this.router,
            this.skipScout,
            this.strings,
            this.locale,
            () => this.getTokenReport(),
            () => this.router.getStats(),
            (e) => this.emit(e),
          );
        case 'full':
          return await runFull({
            config: this.config,
            plannerLLM: this.plannerLLM,
            compressorLLM: this.compressorLLM,
            router: this.router,
            compressor: this.compressor,
            planner: this.planner,
            scout: this.scout,
            summarizer: this.summarizer,
            executor: this.executor,
            verifier: this.verifier,
            strings: this.strings,
            locale: this.locale,
            userRequest,
            getTokenReport: () => this.getTokenReport(),
            getRouterStats: () => this.router.getStats(),
            emit: (e) => this.emit(e),
          });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', phase: this.state.phase, detail: errorMessage });
      return {
        success: false,
        report: `Pipeline failed: ${errorMessage}`,
        tokenReport: this.getTokenReport(),
        routerStats: this.router.getStats(),
        blockedMessages: this.router.getBlockedLog(),
        depth: 'full',
      };
    }
  }

  // ─── Private Helpers ────────────────────────────────

  private setPhase(phase: Phase): void {
    this.state.phase = phase;
    this.planner.setPhase(phase);
    this.scout.setPhase(phase);
    this.summarizer.setPhase(phase);
    this.executor.setPhase(phase);
    this.verifier.setPhase(phase);
  }

  private emit(event: PipelineEvent): void {
    if (this.onEvent) {
      this.onEvent(event);
    }
    if (this.config.debug) {
      console.log(`[${event.phase}] ${event.type}: ${event.detail}`);
    }
  }

  private getTokenReport() {
    const allUsage = [...this.plannerLLM.getTokenLog(), ...this.compressorLLM.getTokenLog()];
    return generateTokenReport(allUsage);
  }
}
