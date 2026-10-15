/**
 * @liwencode/core — the LIWENCode kernel.
 * Depends only on zod; no UI, no provider SDKs, no global state (NFR-012/015).
 */

// errors
export { ERROR_REGISTRY, ALL_ERROR_CODES, lookupError, requireError } from './errors/registry';
export type { ErrorCategory, ErrorDomain, ErrorCodeEntry, Recovery, Severity } from './errors/registry';
export { LiwenError, ProviderError, ToolError, PermissionError, FsError, ContextError, SessionError, InternalError } from './errors/liwen-error';
export type { ErrorInit, SerializedError } from './errors/liwen-error';
export { MESSAGES_ZH_CN } from './errors/messages-zh';

// types
export type { ContentBlock, ImageSource, Message, MessageMeta, Role, StopReason, ToolCall, ToolResultBlock, ToolResultContent, ToolUseBlock, Usage } from './types';
export { textOf, toolCallsOf, userText, assistantText } from './types';

// runtime
export type { Clock, DirEntry, Env, FileStat, FileSystem, HttpClient, HttpResponse, IdGenerator, LogLevel, Logger, ProcessHandle, Runtime, Shell, ShellSpawnOptions } from './runtime';
export { MemoryLogger, noopLogger } from './runtime';
export { nodeRuntime, contentHash } from './runtime/node';

// events
export type { AgentEvent, EndReason, PermissionMode, UsageEvent } from './events';
export { EventBus } from './events';

// provider
export type { Capabilities, ModelRequest, ModelStreamEvent, Pricing, Provider, RetryPolicy, ToolDefinition } from './provider';
export { withRetry, DEFAULT_RETRY_POLICY, mapHttpStatus } from './provider';

// tool
export type { PermissionSubject, PromptContext, Tool, ToolContext, ToolOutput, ToolProgress, ToolRisk } from './tool';
export { ToolRegistry, zodToJsonSchema, textContent } from './tool';

// permissions
export type { EngineOutcome, EngineOptions, PermissionDecision, PermissionHandler, PermissionRequest, PermissionRule, CommandClass } from './permissions';
export { PermissionEngine, classifyCommand, globMatch } from './permissions';

// pipeline
export { executeToolCall, truncateOutput, TRUNCATION_MAX_CHARS, TRUNCATION_MAX_LINES } from './pipeline';
export type { PipelineEvents } from './pipeline';

// context
export type { ContextConfig } from './context';
export { assembleSystemPrompt, estimateTokens, estimateMessagesTokens, trimOldToolResults } from './context';

// config
export type { LiwenConfig, LoadConfigOptions } from './config';
export { configSchema, loadConfig, permissionRuleSchema, rulesFromConfig } from './config';

// session
export type { LogEntry, SessionFilter, SessionInfo, SessionStore } from './session';
export { MemorySessionStore, FileSessionStore, projectHashOf } from './session';

// redact
export { Redactor } from './redact';

// agent
export type { Agent, AgentConfig, Limits, RunOptions, RunSummary } from './agent';
export { createAgent, planBatches } from './agent';
