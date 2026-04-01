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
import { predictDepth, recordDepth } from '../core/depth-predictor.js';
import type { EndpointManager } from '../core/llm.js';
import { LLMClient } from '../core/llm.js';
import { preFilter } from '../core/pre-filter.js';
import { detectLocale, type Locale, PIPELINE_STRINGS } from '../core/prompts.js';
import type { NTKConfig, Phase, PipelineState } from '../core/protocol.js';
import { Router } from '../core/router.js';

// Submodules
import { classifyDepth, classifyDepthFastPath } from './classifier.js';
import { type DirectDepthContext, runDirect } from './depth-direct.js';
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
  PipelineTrace,
  PreFilterSavings,
  VerificationResult,
} from './types.js';

import type { PipelineDepth, PipelineEvent, PipelineResult, PipelineTrace, PreFilterSavings } from './types.js';

/** Shared cache across Pipeline instances within the same process */
const sharedCache = new ResponseCache();

export class Pipeline {
  /** Clear the shared response cache (useful for interactive mode / testing) */
  static clearCache(): void {
    sharedCache.clear();
  }

  /** Get shared cache stats */
  static getCacheStats() {
    return sharedCache.getStats();
  }

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

  private speculative: boolean;
  private onToken?: (token: string) => void;

  // Trace collection
  private traceEvents: PipelineEvent[] = [];
  private traceStartedAt = 0;
  private traceFastPathResult: PipelineDepth | null = null;
  private traceClassifierResult: PipelineDepth | null = null;
  private traceSpeculativeHit: boolean | null = null;
  private tracePredictionConfidence: number | null = null;
  private traceTeeRetrieved = 0;
  private traceCompressionFallbacks = 0;
  private traceTeeRecoveryAttempts = 0;
  private traceTeeRecoverySuccesses = 0;

  constructor(
    config: NTKConfig,
    onEvent?: (event: PipelineEvent) => void,
    options?: {
      forceDepth?: PipelineDepth;
      skipScout?: boolean;
      speculative?: boolean;
      onToken?: (token: string) => void;
      endpointManager?: EndpointManager;
    },
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.forceDepth = options?.forceDepth;
    this.skipScout = options?.skipScout ?? false;
    this.speculative = options?.speculative ?? true;
    this.onToken = options?.onToken;

    const em = options?.endpointManager;

    // Create LLM clients — planner gets the strong model
    this.plannerLLM = new LLMClient(config.planner, em);
    this.compressorLLM = new LLMClient(config.compressor, em);

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
    this.traceStartedAt = Date.now();
    this.traceEvents = [];

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

    // Step 0a: Pipeline-level pre-filter (zero token cost, before cache to normalize keys)
    const pfResult = preFilter(userRequest);
    const cleanRequest = pfResult.filtered;
    if (pfResult.charsRemoved > 0) {
      this.pipelinePreFilterCharsRemoved = pfResult.charsRemoved;
    }

    // Cache hit — use cleanRequest as key for noise-invariant matching
    const cached = sharedCache.get(cleanRequest);
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

    try {
      if (pfResult.charsRemoved > 0) {
        this.emit({
          type: 'message',
          phase: 'gather',
          detail: `Pre-filter: removed ${pfResult.charsRemoved} noise chars (${((pfResult.charsRemoved / pfResult.originalLength) * 100).toFixed(0)}%)`,
        });
      }

      // Step 0b: Classify + speculative direct execution
      // If fast path already returns "direct", skip classifier entirely
      let result: PipelineResult;
      const fastPathDepth = this.forceDepth ?? classifyDepthFastPath(cleanRequest);
      this.traceFastPathResult = fastPathDepth;

      if (fastPathDepth === 'direct') {
        // Fast path hit — skip classifier LLM call, execute directly
        this.emit({ type: 'start', phase: 'gather', detail: `[direct/fast] ${cleanRequest}` });
        this.setPhase('execute');
        result = await runDirect(this.directCtx(cleanRequest, { onToken: this.onToken }));
      } else if (this.forceDepth) {
        // Forced depth — no speculation needed
        const depth = this.forceDepth;
        this.emit({ type: 'start', phase: 'gather', detail: `[${depth}] ${cleanRequest}` });
        switch (depth) {
          case 'direct':
            this.setPhase('execute');
            result = await runDirect(this.directCtx(cleanRequest));
            break;
          default: {
            const d = await this.runNonDirectDepth(depth, cleanRequest);
            result = d;
            break;
          }
        }
      } else if (this.speculative) {
        // Smart speculative execution: use history to predict depth
        const prediction = predictDepth(cleanRequest);
        const speculateDepth = prediction && prediction.confidence > 0.7 ? prediction.depth : 'direct';

        // Only speculate if high confidence — launch classifier + direct execution in parallel
        // When speculation misses, the direct result is awaited and discarded to avoid leaked promises
        let speculativePromise: Promise<PipelineResult> | null = null;
        if (speculateDepth === 'direct') {
          speculativePromise = runDirect(this.directCtx(cleanRequest, { emit: () => {} }));
        }

        const depth = await classifyDepth(cleanRequest, this.compressorLLM, this.locale);
        this.traceClassifierResult = depth;
        this.tracePredictionConfidence = prediction?.confidence ?? null;
        const predictionInfo = prediction ? ` pred=${speculateDepth}@${(prediction.confidence * 100).toFixed(0)}%` : '';
        this.emit({
          type: 'start',
          phase: 'gather',
          detail: `[${depth}/speculative${predictionInfo}] ${cleanRequest}`,
        });

        if (depth === speculateDepth && speculativePromise) {
          this.traceSpeculativeHit = true;
          this.setPhase('execute');
          try {
            result = await speculativePromise;
          } catch {
            result = await runDirect(this.directCtx(cleanRequest));
          }
          this.emit({ type: 'complete', phase: 'report', detail: `Done (${depth}/speculative-hit)` });
        } else {
          this.traceSpeculativeHit = speculativePromise ? false : null;
          // Speculation missed — await and discard the speculative result to prevent leaked promises
          if (speculativePromise) {
            speculativePromise.catch(() => {});
          }

          if (depth === 'direct') {
            this.setPhase('execute');
            result = await runDirect(this.directCtx(cleanRequest));
          } else {
            result = await this.runNonDirectDepth(depth, cleanRequest);
          }
        }

        recordDepth(cleanRequest, depth);
      } else {
        // Sequential: classify first, then execute
        const depth = await classifyDepth(cleanRequest, this.compressorLLM, this.locale);
        this.traceClassifierResult = depth;
        this.emit({ type: 'start', phase: 'gather', detail: `[${depth}] ${cleanRequest}` });

        if (depth === 'direct') {
          this.setPhase('execute');
          result = await runDirect(this.directCtx(cleanRequest));
        } else {
          result = await this.runNonDirectDepth(depth, cleanRequest);
        }

        recordDepth(cleanRequest, depth);
      }

      result.preFilterSavings = this.getPreFilterSavings();
      result.trace = this.buildTrace(result);

      // Cache successful results (keyed by cleanRequest for noise-invariant matching)
      if (result.success) {
        const totalTok = result.tokenReport.totalInput + result.tokenReport.totalOutput;
        sharedCache.set(cleanRequest, result.report, result.depth ?? 'direct', totalTok);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', phase: this.state.phase, detail: errorMessage });
      const errorResult: PipelineResult = {
        success: false,
        report: `Pipeline failed: ${errorMessage}`,
        tokenReport: this.getTokenReport(),
        routerStats: this.router.getStats(),
        blockedMessages: this.router.getBlockedLog(),
        depth: 'full',
        preFilterSavings: this.getPreFilterSavings(),
      };
      errorResult.trace = this.buildTrace(errorResult);
      return errorResult;
    }
  }

  private async runNonDirectDepth(depth: PipelineDepth, cleanRequest: string): Promise<PipelineResult> {
    switch (depth) {
      case 'light':
        this.setPhase('execute');
        return await runLight({
          userRequest: cleanRequest,
          executor: this.executor,
          verifier: this.verifier,
          router: this.router,
          strings: this.strings,
          locale: this.locale,
          getTokenReport: () => this.getTokenReport(),
          getRouterStats: () => this.router.getStats(),
          emit: (e) => this.emit(e),
          llm: this.compressorLLM,
          onToken: this.onToken,
        });
      case 'standard':
        this.setPhase('gather');
        return await runStandard({
          userRequest: cleanRequest,
          executor: this.executor,
          scout: this.scout,
          router: this.router,
          skipScout: this.skipScout,
          strings: this.strings,
          locale: this.locale,
          getTokenReport: () => this.getTokenReport(),
          getRouterStats: () => this.router.getStats(),
          emit: (e) => this.emit(e),
          llm: this.compressorLLM,
          onToken: this.onToken,
        });
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
          userRequest: cleanRequest,
          getTokenReport: () => this.getTokenReport(),
          getRouterStats: () => this.router.getStats(),
          emit: (e) => this.emit(e),
          onToken: this.onToken,
        });
      default:
        this.setPhase('execute');
        return await runDirect(this.directCtx(cleanRequest));
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
    this.traceEvents.push(event);
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

  private buildTrace(result: PipelineResult): PipelineTrace {
    const now = Date.now();
    const tokenReport = result.tokenReport;
    const totalTokens = tokenReport.totalInput + tokenReport.totalOutput;
    const strongTokens =
      (tokenReport.byAgent.planner?.input ?? 0) + (tokenReport.byAgent.planner?.output ?? 0);
    const cheapTokens = totalTokens - strongTokens;
    const preFilter = result.preFilterSavings;

    return {
      startedAt: this.traceStartedAt,
      finishedAt: now,
      durationMs: now - this.traceStartedAt,
      routing: {
        fastPathResult: this.traceFastPathResult,
        classifierResult: this.traceClassifierResult,
        finalDepth: (result.depth ?? 'direct') as PipelineDepth,
        speculativeHit: this.traceSpeculativeHit,
        predictionConfidence: this.tracePredictionConfidence,
      },
      compression: {
        preFilterCharsRemoved: preFilter?.totalCharsRemoved ?? 0,
        preFilterOriginalChars: preFilter?.totalOriginal ?? 0,
        preFilterReductionPercent: preFilter?.reductionPercent ?? 0,
        llmCompressionCalls: this.compressor.getPreFilterStats().length,
        teeEntriesStored: this.compressor.teeSize,
        teeRetrieved: this.traceTeeRetrieved,
      },
      tokens: {
        totalInput: tokenReport.totalInput,
        totalOutput: tokenReport.totalOutput,
        total: totalTokens,
        strongModelTokens: strongTokens,
        cheapModelTokens: cheapTokens,
        strongModelPercent: totalTokens > 0 ? (strongTokens / totalTokens) * 100 : 0,
        estimatedCostSavingsPercent: tokenReport.estimatedSavingsVsTraditional,
        byAgent: tokenReport.byAgent as Record<string, { input: number; output: number }>,
      },
      errors: {
        compressionFallbacks: this.traceCompressionFallbacks,
        teeRecoveryAttempts: this.traceTeeRecoveryAttempts,
        teeRecoverySuccesses: this.traceTeeRecoverySuccesses,
        apiRetries: this.traceEvents.filter((e) => e.type === 'retry').length,
      },
      cached: result.cached ?? false,
      events: [...this.traceEvents],
    };
  }

  private directCtx(
    userRequest: string,
    overrides?: { onToken?: (token: string) => void; emit?: (e: PipelineEvent) => void },
  ): DirectDepthContext {
    return {
      userRequest,
      executor: this.executor,
      locale: this.locale,
      getTokenReport: () => this.getTokenReport(),
      getRouterStats: () => this.router.getStats(),
      emit: overrides?.emit ?? ((e) => this.emit(e)),
      llm: this.compressorLLM,
      plannerLLM: this.plannerLLM,
      onToken: overrides?.onToken,
    };
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
