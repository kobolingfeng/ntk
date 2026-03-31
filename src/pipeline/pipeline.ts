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
import { ResponseCache } from '../core/cache.js';
import { Compressor } from '../core/compressor.js';
import { LLMClient } from '../core/llm.js';
import { preFilter } from '../core/pre-filter.js';
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
export type {
  ExecutionResult,
  PipelineDepth,
  PipelineEvent,
  PipelineResult,
  PreFilterSavings,
  VerificationResult,
} from './types.js';

import type { PipelineDepth, PipelineEvent, PipelineResult, PreFilterSavings } from './types.js';

/** Shared cache across Pipeline instances within the same process */
const sharedCache = new ResponseCache();

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
  private pipelinePreFilterCharsRemoved = 0;
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

    // Cache hit — return immediately with zero token cost
    const cached = sharedCache.get(userRequest);
    if (cached) {
      this.emit({ type: 'message', phase: 'gather', detail: `Cache hit (saved ${cached.tokensSaved} tokens)` });
      return {
        success: true,
        report: cached.result,
        tokenReport: this.getTokenReport(),
        routerStats: this.router.getStats(),
        blockedMessages: [],
        depth: cached.depth as PipelineDepth,
        cached: true,
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
      // Step 0a: Pipeline-level pre-filter (RTK-compatible, zero token cost)
      const pfResult = preFilter(userRequest);
      const cleanRequest = pfResult.filtered;
      if (pfResult.charsRemoved > 0) {
        this.pipelinePreFilterCharsRemoved = pfResult.charsRemoved;
        this.emit({
          type: 'message',
          phase: 'gather',
          detail: `Pre-filter: removed ${pfResult.charsRemoved} noise chars (${((pfResult.charsRemoved / pfResult.originalLength) * 100).toFixed(0)}%)`,
        });
      }

      // Step 0b: Classify task complexity (or use forced depth)
      const depth = this.forceDepth ?? (await classifyDepth(cleanRequest, this.compressorLLM, this.locale));
      this.emit({ type: 'start', phase: 'gather', detail: `[${depth}] ${cleanRequest}` });

      let result: PipelineResult;
      switch (depth) {
        case 'direct':
          this.setPhase('execute');
          result = await runDirect(
            cleanRequest,
            this.executor,
            this.locale,
            () => this.getTokenReport(),
            () => this.router.getStats(),
            (e) => this.emit(e),
            this.compressorLLM,
          );
          break;
        case 'light':
          this.setPhase('execute');
          result = await runLight(
            cleanRequest,
            this.executor,
            this.verifier,
            this.router,
            this.strings,
            this.locale,
            () => this.getTokenReport(),
            () => this.router.getStats(),
            (e) => this.emit(e),
          );
          break;
        case 'standard':
          this.setPhase('gather');
          result = await runStandard(
            cleanRequest,
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
          break;
        case 'full':
          result = await runFull({
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
            userRequest: cleanRequest,
            getTokenReport: () => this.getTokenReport(),
            getRouterStats: () => this.router.getStats(),
            emit: (e) => this.emit(e),
          });
          break;
      }

      result.preFilterSavings = this.getPreFilterSavings();

      // Cache successful results
      if (result.success) {
        const totalTok = result.tokenReport.totalInput + result.tokenReport.totalOutput;
        sharedCache.set(userRequest, result.report, result.depth ?? 'direct', totalTok);
      }

      return result;
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
        preFilterSavings: this.getPreFilterSavings(),
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

  private getPreFilterSavings(): PreFilterSavings {
    const stats = this.compressor.getTotalPreFilterSavings();
    const totalRemoved = stats.totalCharsRemoved + this.pipelinePreFilterCharsRemoved;
    const totalOrig =
      stats.totalOriginal + (this.pipelinePreFilterCharsRemoved > 0 ? this.state.userRequest.length : 0);
    return {
      totalCharsRemoved: totalRemoved,
      totalOriginal: totalOrig,
      callCount: stats.callCount + (this.pipelinePreFilterCharsRemoved > 0 ? 1 : 0),
      reductionPercent: totalOrig > 0 ? (totalRemoved / totalOrig) * 100 : 0,
    };
  }
}
