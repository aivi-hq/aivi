/**
 * The host's surface. The shared contracts — run shapes, tracker stages,
 * channel vocabulary, the module contract — are declared in `@aivi/plugin`
 * and re-exported from their homes; the names below that are the host's own
 * machinery: the classes that implement those contracts and the host's
 * internals that modules build on.
 */

export type {
  AddJobOptions,
  AuditEntry,
  ExecutionContext,
  ExecutionResult,
  JobEntry,
  Lease,
  RunFilter,
} from '@aivi/core';
export type {
  ChannelDelivery,
  ChannelModule,
  ChannelPlatform,
  ChatCommand,
  ChatCommandArgument,
  ChatCommandName,
  DeliveryContext,
  EngineNotices,
  ModelRef,
  ReentryContext,
  Turn,
  TurnKind,
  TurnState,
} from '@aivi/plugin/channel';
export type {
  AiviModule,
  AiviServices,
  OpenCodeClient,
  PublicRequest,
  PublicRouteHandler,
  RunningModule,
  SessionEvent,
  SessionEventListener,
  SessionEvents,
  TaskClaims,
  TaskHandler,
  ToolClaims,
  ToolHandler,
} from '@aivi/plugin/module';
export type {
  FailureCode,
  RunOption,
  RunOutcome,
  RunPlan,
  RunPlanStep,
  RunQuestion,
  RunState,
  RunView,
  WorkRequest,
} from '@aivi/plugin/run';
export { isTerminal } from '@aivi/plugin/run';
export type { Tracker } from '@aivi/plugin/tracker';
export type { HostApiOptions } from './api/app.ts';
export { createApp, serveApp } from './api/app.ts';
export { bearerPerson } from './api/person.ts';
export { PublicRoutes } from './api/public.ts';
export { status } from './api/status.ts';
export type { HostResources, RunHostOptions } from './application.ts';
export { runHost } from './application.ts';
export {
  CHAT_COMMANDS,
  chatCommand,
  describeJobs,
  helpText,
  INTERJECTED,
  interject,
  isChatCommand,
  redeemLink,
  stopTurn,
  usageHint,
} from './channel/commands.ts';
export { describeConversation, describeSession } from './channel/context.ts';
export type { Ask, EngineLimits, EngineOptions, Send } from './channel/engine.ts';
export {
  ChannelEngine,
  OFFLINE_MID_REPLY,
  OFFLINE_QUEUED,
  STOPPED_NOTICE,
  STOPPED_REASON,
  splitReply,
} from './channel/engine.ts';
export type { ModelChoice } from './channel/model.ts';
export { describeModel, formatModel, listModels, matchModels, resolveModel, switchModel } from './channel/model.ts';
export { announce, OFFLINE_NOTICE, ONLINE_NOTICE } from './channel/presence.ts';
export type { Progress, ProgressClock, ProgressMode, ToolCall, ToolState } from './channel/progress.ts';
export {
  DEFAULT_CLOCK,
  describeToolCall,
  formatDuration,
  nextRenderChange,
  reduceProgress,
  renderProgress,
  startProgress,
} from './channel/progress.ts';
export type { ProgressOptions } from './channel/reporter.ts';
export { ProgressReporter } from './channel/reporter.ts';
export type { NativeReentry } from './channel/router.ts';
export { Channels } from './channel/router.ts';
export { ConversationStore } from './channel/store.ts';
export { createTurnRunner, messageIdFor } from './channel/turns.ts';
export type { Refusal } from './dispatcher/dispatcher.ts';
export { Dispatcher } from './dispatcher/dispatcher.ts';
export type { DispatcherLease, LeaseKind, LeaseState } from './dispatcher/leases.ts';
export { LeaseStore, UNLIMITED } from './dispatcher/leases.ts';
export type { DreamingResult } from './dreaming.ts';
export { collectSessions, dream, readCursor, renderTranscript, writeCursor } from './dreaming.ts';
export { EVENTS_RETRY, EventStream } from './events.ts';
export { Forges } from './forges.ts';
export type { JobHandler, JobHandlerDeps } from './jobs.ts';
export { createJobHandler, JobRefused } from './jobs.ts';
export type { RetryPolicy } from './modules.ts';
export { ConfigurationError, DEFAULT_RETRY, ModuleSupervisor } from './modules.ts';
export type { DiscoveredEndpoint } from './opencode.ts';
export { connectOpenCode, discoverTolerant } from './opencode.ts';
export type { Run, RunRequest } from './orchestrator/ledger.ts';
export { RunLedger, view } from './orchestrator/ledger.ts';
export type { OrchestratorDeps } from './orchestrator/orchestrator.ts';
export { Orchestrator } from './orchestrator/orchestrator.ts';
export { describeOutcome, reentryPrompt, reportTarget, SESSION_DESTINATION, shouldReport } from './reports.ts';
export type { ExecutorDeps } from './runtime.ts';
export { createExecutor, SECRET_ENV, shellEnvironment } from './runtime.ts';
export type { Execute, OnFinished } from './scheduler.ts';
export { Scheduler } from './scheduler.ts';
export type { TurnInput, TurnOptions, TurnResult } from './session.ts';
export {
  connectForTurn,
  finalAnswer,
  PendingAnswer,
  PermissionRequired,
  runTurn,
  TurnNotStarted,
  turnIdsFor,
} from './session.ts';
export { Store } from './store.ts';
export { TaskRegistry } from './tasks.ts';
export { ToolError, ToolRegistry } from './tools.ts';
