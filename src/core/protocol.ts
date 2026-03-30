/**
 * NTK Protocol — The communication standard between agents.
 *
 * Design principle: MINIMUM tokens, MAXIMUM clarity.
 * Every field exists for a reason. No fluff.
 */

// ─── Agent Types ───────────────────────────────────────

/** The two fundamental information density levels */
export type InfoLevel = 'high' | 'low';

/** Agent types in the NTK system */
export type AgentType = 'planner' | 'scout' | 'summarizer' | 'executor' | 'verifier' | 'classifier';

/** Map each agent to its information level */
export const AGENT_INFO_LEVEL: Record<AgentType, InfoLevel> = {
  planner: 'high',
  scout: 'low',
  summarizer: 'low',
  executor: 'low',
  verifier: 'low',
  classifier: 'low',
};

// ─── Messages ──────────────────────────────────────────

/** Priority determines execution order */
export type Priority = 'now' | 'next' | 'later';

/** The universal message format. Intentionally minimal. */
export interface Message {
  /** Unique message ID */
  id: string;
  /** Who sent this */
  from: AgentType;
  /** Who should receive this */
  to: AgentType;
  /** What to do — a verb phrase, ≤10 words */
  action: string;
  /** The payload — compressed information, ≤200 tokens ideal */
  payload: string;
  /** Execution priority */
  priority: Priority;
  /** Timestamp */
  timestamp: number;
  /** Optional: reference to the message this is replying to */
  replyTo?: string;
}

/** Create a message with defaults */
export function createMessage(
  from: AgentType,
  to: AgentType,
  action: string,
  payload: string,
  priority: Priority = 'now',
  replyTo?: string
): Message {
  return {
    id: generateId(),
    from,
    to,
    action,
    payload,
    priority,
    timestamp: Date.now(),
    replyTo,
  };
}

// ─── Tasks ─────────────────────────────────────────────

/** Task status */
export type TaskStatus = 'pending' | 'active' | 'done' | 'failed' | 'blocked';

/** A unit of work */
export interface Task {
  id: string;
  /** Human-readable description, kept short */
  description: string;
  /** Who is responsible */
  assignee: AgentType;
  /** Current status */
  status: TaskStatus;
  /** Input to this task (compressed) */
  input: string;
  /** Output from this task (compressed) */
  output?: string;
  /** Sub-tasks for decomposition */
  subtasks?: Task[];
  /** Which task this depends on */
  dependsOn?: string[];
  /** Created timestamp */
  createdAt: number;
  /** Completed timestamp */
  completedAt?: number;
}

export function createTask(
  description: string,
  assignee: AgentType,
  input: string,
  dependsOn?: string[]
): Task {
  return {
    id: generateId(),
    description,
    assignee,
    status: 'pending',
    input,
    dependsOn,
    createdAt: Date.now(),
  };
}

// ─── Pipeline ──────────────────────────────────────────

/** Pipeline phase */
export type Phase = 'gather' | 'plan' | 'execute' | 'verify' | 'report';

/** Pipeline state */
export interface PipelineState {
  /** Current phase */
  phase: Phase;
  /** All tasks */
  tasks: Task[];
  /** Message history (kept minimal via routing) */
  messages: Message[];
  /** The original user request */
  userRequest: string;
  /** Final output for the user */
  finalReport?: string;
}

// ─── LLM Configuration ────────────────────────────────

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface NTKConfig {
  /** LLM config for the planner (high-info agent) */
  planner: LLMConfig;
  /** LLM config for compressors (low-info agents) */
  compressor: LLMConfig;
  /** Maximum retries in local verification loops */
  maxLocalRetries: number;
  /** Whether to print debug info */
  debug: boolean;
  /** Run independent executor tasks in parallel */
  parallelExecution?: boolean;
  /** Max output tokens budget per agent type per call */
  tokenBudget?: Partial<Record<AgentType, number>>;
}

// ─── Agent Interface ──────────────────────────────────

/** The base interface every agent must implement */
export interface Agent {
  type: AgentType;
  infoLevel: InfoLevel;

  /** Process an incoming message and return a response */
  process(message: Message, context: AgentContext): Promise<Message>;

  /** Get this agent's system prompt */
  getSystemPrompt(): string;
}

/** Context available to an agent — deliberately limited */
export interface AgentContext {
  /** Only the messages this agent is allowed to see */
  visibleMessages: Message[];
  /** The current task assigned to this agent */
  currentTask?: Task;
  /** Shared scratchpad for local loops (e.g., executor↔verifier) */
  localScratchpad?: string;
}

// ─── Routing ──────────────────────────────────────────

/** Defines who can talk to whom and what gets compressed */
export interface RoutingRule {
  /** Name of this rule */
  name: string;
  /** When this rule applies */
  phase: Phase | '*';
  /** Allowed communication pairs */
  allow: [AgentType, AgentType][];
  /** Blocked communication pairs */
  block: [AgentType, AgentType][];
  /** Whether messages on this route must be compressed */
  compress: boolean;
}

// ─── Token Tracking ───────────────────────────────────

/** Track token usage for comparison metrics */
export interface TokenUsage {
  agent: AgentType;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
  phase: Phase;
}

export interface TokenReport {
  totalInput: number;
  totalOutput: number;
  byAgent: Record<AgentType, { input: number; output: number }>;
  byPhase: Record<Phase, { input: number; output: number }>;
  estimatedSavingsVsTraditional: number;
}

// ─── Utilities ────────────────────────────────────────

let counter = 0;
export function generateId(): string {
  counter++;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}
