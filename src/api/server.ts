/**
 * NTK API Server — HTTP interface for AI-to-AI calling.
 *
 * Endpoints:
 *   POST /run          — Run a full pipeline task
 *   POST /compress     — Compress text (standalone utility)
 *   GET  /health       — Health check
 *   GET  /stats        — Get last run stats
 *
 * This lets other AI agents (like Antigravity, Codex, etc.)
 * call NTK as a tool via HTTP.
 */

import http from 'node:http';
import { Compressor } from '../core/compressor.js';
import type { EndpointManager } from '../core/llm.js';
import { LLMClient } from '../core/llm.js';
import type { NTKConfig } from '../core/protocol.js';
import type { PipelineEvent, PipelineResult } from '../pipeline/pipeline.js';
import { Pipeline } from '../pipeline/pipeline.js';

export class NTKServer {
  private server: http.Server;
  private config: NTKConfig;
  private endpointManager?: EndpointManager;
  private lastResult: PipelineResult | null = null;
  private runHistory: Array<{
    request: string;
    success: boolean;
    reportPreview: string;
    totalTokens: number;
    depth: string;
    timestamp: number;
    durationMs: number;
  }> = [];
  private rateLimiter = new Map<string, { count: number; resetAt: number }>();
  private readonly rateLimit = { windowMs: 60_000, maxRequests: 30 };
  private readonly requestTimeoutMs = 300_000; // 5 minutes max per request

  constructor(config: NTKConfig, endpointManager?: EndpointManager) {
    this.config = config;
    this.endpointManager = endpointManager;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  start(port: number = 3210): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        console.log(`🔒 NTK API Server running on http://localhost:${port}`);
        console.log(`   POST /run          — Run a pipeline task`);
        console.log(`   POST /compress     — Compress text`);
        console.log(`   GET  /health       — Health check`);
        console.log(`   GET  /stats        — Run statistics`);
        console.log(`   GET  /history      — Run history`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers for flexibility
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!this.checkRateLimit(clientIp)) {
      this.sendJson(res, 429, { error: 'Too many requests. Try again later.' });
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      switch (path) {
        case '/health':
          this.handleHealth(res);
          break;
        case '/run':
          await this.handleRun(req, res);
          break;
        case '/run/stream':
          await this.handleRunStream(req, res);
          break;
        case '/compress':
          await this.handleCompress(req, res);
          break;
        case '/stats':
          this.handleStats(res);
          break;
        case '/history':
          this.handleHistory(res);
          break;
        default:
          this.sendJson(res, 404, {
            error: 'Not found',
            endpoints: ['/run', '/run/stream', '/compress', '/health', '/stats', '/history'],
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('too large') ? 413 : 500;
      this.sendJson(res, status, { error: message });
    }
  }

  private handleHealth(res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      status: 'ok',
      framework: 'NTK — NeedToKnow',
      version: '0.1.0',
      model: this.config.planner.model,
      uptime: process.uptime(),
      totalRuns: this.runHistory.length,
    });
  }

  private async handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed, use POST' });
      return;
    }

    const body = await this.readBody(req);
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON in request body' });
      return;
    }
    const { task, debug } = parsed;

    if (!task || typeof task !== 'string') {
      this.sendJson(res, 400, { error: 'Missing or invalid "task" field in request body (must be a string)' });
      return;
    }

    if (task.length > 10000) {
      this.sendJson(res, 400, { error: 'Task too long (max 10000 characters)' });
      return;
    }

    const config = { ...this.config, debug: debug === true ? true : this.config.debug };
    const events: PipelineEvent[] = [];

    const pipeline = new Pipeline(
      config,
      (event) => {
        events.push(event);
      },
      { endpointManager: this.endpointManager },
    );

    const startTime = Date.now();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pipeline.run(task),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error('Request timeout: pipeline exceeded 5 minute limit')), this.requestTimeoutMs);
        }),
      ]);
      const durationMs = Date.now() - startTime;

      this.lastResult = result;
      this.addToHistory(task, result, startTime, durationMs);

      this.sendJson(res, 200, {
        success: result.success,
        report: result.report,
        tokenUsage: result.tokenReport,
        routerStats: result.routerStats,
        blockedCount: result.blockedMessages.length,
        events: events.map((e) => ({ type: e.type, phase: e.phase, detail: e.detail })),
        durationMs,
      });
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private async handleRunStream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed, use POST' });
      return;
    }

    const body = await this.readBody(req);
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON in request body' });
      return;
    }
    const { task, debug } = parsed;

    if (!task || typeof task !== 'string') {
      this.sendJson(res, 400, { error: 'Missing or invalid "task" field (must be a string)' });
      return;
    }

    if (task.length > 10000) {
      this.sendJson(res, 400, { error: 'Task too long (max 10000 characters)' });
      return;
    }

    // Server-Sent Events for streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const config = { ...this.config, debug: debug === true ? true : this.config.debug };

    const pipeline = new Pipeline(
      config,
      (event) => {
        try {
          if (!res.destroyed) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        } catch {
          // Response destroyed mid-write, safe to ignore
        }
      },
      { endpointManager: this.endpointManager },
    );

    const startTime = Date.now();
    let streamTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pipeline.run(task),
        new Promise<never>((_, reject) => {
          streamTimeoutTimer = setTimeout(() => reject(new Error('Stream timeout: pipeline exceeded 5 minute limit')), this.requestTimeoutMs);
        }),
      ]);
      const durationMs = Date.now() - startTime;

      this.lastResult = result;
      this.addToHistory(task, result, startTime, durationMs);

      if (!res.destroyed) {
        res.write(
          `data: ${JSON.stringify({
            type: 'final',
            phase: 'report',
            detail: JSON.stringify({
              success: result.success,
              report: result.report,
              tokenUsage: result.tokenReport,
              routerStats: result.routerStats,
              durationMs,
            }),
          })}\n\n`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'error', phase: 'report', detail: message })}\n\n`);
      }
    } finally {
      clearTimeout(streamTimeoutTimer);
      res.end();
    }
  }

  private async handleCompress(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed, use POST' });
      return;
    }

    const body = await this.readBody(req);
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON in request body' });
      return;
    }
    const { text, level } = parsed;

    if (!text || typeof text !== 'string') {
      this.sendJson(res, 400, { error: 'Missing or invalid "text" field (must be a non-empty string)' });
      return;
    }

    const validLevels = ['minimal', 'standard', 'aggressive'];
    if (level && !validLevels.includes(level)) {
      this.sendJson(res, 400, { error: `Invalid "level" value. Valid: ${validLevels.join(', ')}` });
      return;
    }

    const llm = new LLMClient(this.config.compressor, this.endpointManager);
    const compressor = new Compressor(llm);
    const result = await compressor.compress(text, level || 'standard');

    this.sendJson(res, 200, result);
  }

  private handleStats(res: http.ServerResponse): void {
    if (!this.lastResult) {
      this.sendJson(res, 200, { message: 'No runs yet' });
      return;
    }

    const totalRuns = this.runHistory.length;
    const avgDuration = this.runHistory.reduce((sum, r) => sum + r.durationMs, 0) / totalRuns;
    const totalTokens = this.runHistory.reduce(
      (sum, r) => sum + r.totalTokens,
      0,
    );

    this.sendJson(res, 200, {
      totalRuns,
      avgDurationMs: Math.round(avgDuration),
      totalTokensUsed: totalTokens,
      avgTokensPerRun: Math.round(totalTokens / totalRuns),
      lastRun: {
        tokenReport: this.lastResult.tokenReport,
        routerStats: this.lastResult.routerStats,
        blockedCount: this.lastResult.blockedMessages.length,
      },
    });
  }

  private handleHistory(res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      total: this.runHistory.length,
      runs: this.runHistory.map((r) => ({
        request: r.request,
        success: r.success,
        reportPreview: r.reportPreview,
        totalTokens: r.totalTokens,
        depth: r.depth,
        durationMs: r.durationMs,
        timestamp: new Date(r.timestamp).toISOString(),
      })),
    });
  }

  // ─── Utilities ────────────────────────────────────────

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = this.rateLimiter.get(ip);
    if (!entry || now > entry.resetAt) {
      this.rateLimiter.set(ip, { count: 1, resetAt: now + this.rateLimit.windowMs });
      this.pruneRateLimiter(now);
      return true;
    }
    entry.count++;
    return entry.count <= this.rateLimit.maxRequests;
  }

  private pruneRateLimiter(now: number): void {
    if (this.rateLimiter.size <= 50) return;
    for (const [ip, entry] of this.rateLimiter) {
      if (now > entry.resetAt) this.rateLimiter.delete(ip);
    }
  }

  /** Cap history to prevent unbounded memory growth */
  private addToHistory(request: string, result: PipelineResult, timestamp: number, durationMs: number): void {
    this.runHistory.push({
      request,
      success: result.success,
      reportPreview: result.report.slice(0, 200),
      totalTokens: result.tokenReport.totalInput + result.tokenReport.totalOutput,
      depth: result.depth ?? 'full',
      timestamp,
      durationMs,
    });
    if (this.runHistory.length > 100) {
      this.runHistory.shift();
    }
  }

  private readBody(req: http.IncomingMessage, maxBytes: number = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const settle = (fn: typeof resolve | typeof reject, value: any) => {
        if (!settled) {
          settled = true;
          fn(value);
        }
      };
      const bodyTimeout = setTimeout(() => {
        req.destroy();
        settle(reject, new Error('Request body read timeout'));
      }, 30_000);
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          clearTimeout(bodyTimeout);
          req.destroy();
          settle(reject, new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { clearTimeout(bodyTimeout); settle(resolve, Buffer.concat(chunks).toString('utf-8')); });
      req.on('error', (err) => { clearTimeout(bodyTimeout); settle(reject, err); });
      req.on('close', () => { clearTimeout(bodyTimeout); settle(reject, new Error('Connection closed before request completed')); });
    });
  }
}
