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
import type { ToolDefinition } from '../tools/definitions.js';

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

/** Reusable empty stats object — avoids allocating a new one for each directCtx call */
const EMPTY_ROUTER_STATS = Object.freeze({ totalRouted: 0, totalBlocked: 0, blockRate: 0, byRoute: {} }) as import('../core/router.js').RouterStats;

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
  private _router?: Router;
  private _compressor?: Compressor;

  // Agents — lazy-initialized (direct depth only needs executor)
  private _planner?: Planner;
  private _scout?: Scout;
  private _summarizer?: Summarizer;
  private executor: Executor;
  private _verifier?: Verifier;

  // LLM clients (may be different models)
  private plannerLLM: LLMClient;
  private compressorLLM: LLMClient;
  private em?: EndpointManager;

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
  private tools?: ToolDefinition[];
  private toolsCwd?: string;

  // Lazy accessors for agents/infrastructure only needed in non-direct paths
  private get planner(): Planner {
    if (!this._planner) {
      this._planner = new Planner(this.plannerLLM);
      if (this.config.tokenBudget?.planner !== undefined) this._planner.tokenBudget = this.config.tokenBudget.planner;
    }
    return this._planner;
  }
  private get scout(): Scout {
    if (!this._scout) {
      this._scout = new Scout(this.compressorLLM);
      if (this.config.tokenBudget?.scout !== undefined) this._scout.tokenBudget = this.config.tokenBudget.scout;
    }
    return this._scout;
  }
  private get summarizer(): Summarizer {
    if (!this._summarizer) {
      this._summarizer = new Summarizer(this.compressorLLM);
      if (this.config.tokenBudget?.summarizer !== undefined) this._summarizer.tokenBudget = this.config.tokenBudget.summarizer;
    }
    return this._summarizer;
  }
  private get verifier(): Verifier {
    if (!this._verifier) {
      this._verifier = new Verifier(this.compressorLLM);
      if (this.config.tokenBudget?.verifier !== undefined) this._verifier.tokenBudget = this.config.tokenBudget.verifier;
    }
    return this._verifier;
  }
  private get router(): Router {
    return this._router ??= new Router();
  }
  private get compressor(): Compressor {
    return this._compressor ??= new Compressor(this.compressorLLM);
  }

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
  private traceRetryCount = 0;

  constructor(
    config: NTKConfig,
    onEvent?: (event: PipelineEvent) => void,
    options?: {
      forceDepth?: PipelineDepth;
      skipScout?: boolean;
      speculative?: boolean;
      onToken?: (token: string) => void;
      endpointManager?: EndpointManager;
      tools?: ToolDefinition[];
      toolsCwd?: string;
    },
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.forceDepth = options?.forceDepth;
    this.skipScout = options?.skipScout ?? false;
    this.speculative = options?.speculative ?? true;
    this.onToken = options?.onToken;
    this.tools = options?.tools;
    this.toolsCwd = options?.toolsCwd;

    this.em = options?.endpointManager;

    // Create LLM clients eagerly — lightweight objects
    this.plannerLLM = new LLMClient(config.planner, this.em);
    this.compressorLLM = new LLMClient(config.compressor, this.em);

    // Only executor is created eagerly — always needed
    this.executor = new Executor(this.compressorLLM);

    // Apply executor token budget
    if (config.tokenBudget?.executor !== undefined) {
      this.executor.tokenBudget = config.tokenBudget.executor;
    }

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
    this.traceRetryCount = 0;

    // Early return for empty / whitespace-only input
    if (!userRequest.trim()) {
      return {
        success: false,
        report: 'No task provided.',
        tokenReport: this.getTokenReport(),
        routerStats: this._router?.getStats() ?? EMPTY_ROUTER_STATS,
        blockedMessages: [],
        depth: 'direct',
      };
    }

    // Detect language from user input and propagate
    this.locale = detectLocale(userRequest);
    // Defer full agent locale propagation — only executor is guaranteed to be used
    this.executor.setLocale(this.locale);
    // Compressor locale deferred to runNonDirectDepth() to avoid premature lazy init

    // Step 0a: Pipeline-level pre-filter (zero token cost, before cache to normalize keys)
    // Fast skip: short single-line clean inputs won't be changed by preFilter
    const skipPreFilter = userRequest.length < 200 && !userRequest.includes('\n') && !userRequest.includes('\x1b');
    const pfResult = skipPreFilter ? null : preFilter(userRequest);
    const cleanRequest = pfResult ? pfResult.filtered : userRequest;
    if (pfResult && pfResult.charsRemoved > 0) {
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
      if (pfResult && pfResult.charsRemoved > 0) {
        this.emit({
          type: 'message',
          phase: 'gather',
          detail: `Pre-filter: removed ${pfResult.charsRemoved} noise chars (${((pfResult.charsRemoved / pfResult.originalLength) * 100).toFixed(0)}%)`,
        });
      }

      // Step 0b: Classify + speculative direct execution
      // If fast path returns a depth, skip classifier entirely
      let result: PipelineResult;
      const fastPathDepth = this.forceDepth ?? classifyDepthFastPath(cleanRequest);
      this.traceFastPathResult = fastPathDepth;

      if (fastPathDepth) {
        // Fast path hit — skip classifier LLM call, execute at determined depth
        this.emit({ type: 'start', phase: 'gather', detail: `[${fastPathDepth}/fast] ${cleanRequest}` });
        if (fastPathDepth === 'direct') {
          this.setPhase('execute');
          result = await runDirect(this.directCtx(cleanRequest, { onToken: this.onToken }));
        } else {
          result = await this.runNonDirectDepth(fastPathDepth, cleanRequest);
        }
        recordDepth(cleanRequest, fastPathDepth);
      } else if (this.speculative) {
        // Smart speculative execution: use history to predict depth
        // Lower threshold for 'direct' (safe to speculate, common case)
        const prediction = predictDepth(cleanRequest);

        // Very high confidence prediction — skip classifier entirely
        // This saves ~50 tokens per call for well-known task patterns
        if (prediction && prediction.confidence >= 0.9) {
          const predictedDepth = prediction.depth;
          this.tracePredictionConfidence = prediction.confidence;
          this.traceClassifierResult = null;
          this.emit({
            type: 'start',
            phase: 'gather',
            detail: `[${predictedDepth}/predicted@${(prediction.confidence * 100).toFixed(0)}%] ${cleanRequest}`,
          });
          if (predictedDepth === 'direct') {
            this.setPhase('execute');
            result = await runDirect(this.directCtx(cleanRequest, { onToken: this.onToken }));
          } else {
            result = await this.runNonDirectDepth(predictedDepth, cleanRequest);
          }
          recordDepth(cleanRequest, predictedDepth);
        } else {
          const speculateDepth = prediction
            ? (prediction.depth === 'direct' && prediction.confidence > 0.5
                ? 'direct'
                : prediction.confidence > 0.7 ? prediction.depth : 'direct')
            : 'direct';

          // Only speculate if high confidence — launch classifier + direct execution in parallel
          // Uses AbortController to cancel speculative LLM request on miss
          let speculativePromise: Promise<PipelineResult> | null = null;
          let speculativeAbort: AbortController | null = null;
          if (speculateDepth === 'direct') {
            speculativeAbort = new AbortController();
            speculativePromise = runDirect(this.directCtx(cleanRequest, { emit: () => {}, signal: speculativeAbort.signal }));
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
            // Speculation missed — abort the speculative LLM request to save bandwidth
            if (speculativeAbort) {
              speculativeAbort.abort();
            }
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
        }
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
    // Propagate locale/phase only to agents the depth actually uses
    // Avoids triggering lazy init of unused agents (e.g. planner/scout for light depth)
    const phase = this.state.phase;

    switch (depth) {
      case 'light':
        this.verifier.setLocale(this.locale);
        this.verifier.setPhase(phase);
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
        this.scout.setLocale(this.locale);
        this.scout.setPhase(phase);
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
        // Full depth uses all agents — propagate locale/phase to all
        this.compressor.setLocale(this.locale);
        this.planner.setLocale(this.locale);
        this.scout.setLocale(this.locale);
        this.summarizer.setLocale(this.locale);
        this.verifier.setLocale(this.locale);
        this.planner.setPhase(phase);
        this.scout.setPhase(phase);
        this.summarizer.setPhase(phase);
        this.verifier.setPhase(phase);
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
    // Only executor phase is read in direct/light paths.
    // Other agents get phase set lazily in runNonDirectDepth.
    this.executor.setPhase(phase);
  }

  private emit(event: PipelineEvent): void {
    this.traceEvents.push(event);
    if (event.type === 'retry') this.traceRetryCount++;
    if (this.onEvent) {
      this.onEvent(event);
    }
    if (this.config.debug) {
      console.log(`[${event.phase}] ${event.type}: ${event.detail}`);
    }
  }

  private getTokenReport() {
    // If plannerLLM was never created (direct depth), skip its log entirely
    const plannerLog = this.plannerLLM.getTokenLog();
    const compressorLog = this.compressorLLM.getTokenLog();
    if (!plannerLog || plannerLog.length === 0) return generateTokenReport(compressorLog);
    if (compressorLog.length === 0) return generateTokenReport(plannerLog);
    return generateTokenReport(plannerLog, compressorLog);
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
        llmCompressionCalls: this._compressor?.getPreFilterStats().length ?? 0,
        teeEntriesStored: this._compressor?.teeSize ?? 0,
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
        apiRetries: this.traceRetryCount,
      },
      cached: result.cached ?? false,
      events: this.traceEvents,
    };
  }

  private directCtx(
    userRequest: string,
    overrides?: { onToken?: (token: string) => void; emit?: (e: PipelineEvent) => void; signal?: AbortSignal },
  ): DirectDepthContext {
    return {
      userRequest,
      executor: this.executor,
      locale: this.locale,
      getTokenReport: () => this.getTokenReport(),
      getRouterStats: () => this._router?.getStats() ?? EMPTY_ROUTER_STATS,
      emit: overrides?.emit ?? ((e) => this.emit(e)),
      llm: this.compressorLLM,
      plannerLLM: this.plannerLLM,
      onToken: overrides?.onToken,
      tools: this.tools,
      toolsCwd: this.toolsCwd,
      signal: overrides?.signal,
    };
  }

  private getPreFilterSavings(): PreFilterSavings {
    const stats = this._compressor?.getTotalPreFilterSavings() ?? { totalCharsRemoved: 0, totalOriginal: 0, callCount: 0 };
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
