export { Orchestrator } from './orchestrator';
export { ModelPicker } from './modelPicker';
export { TaskDecomposer } from './taskDecomposer';
export { SubagentManager } from './subagentManager';
export { MemorySystem } from './memory';
export { registerJohannParticipant } from './participant';
export * from './types';

// New modules
export * from './templates';
export * from './bootstrap';
export { assembleSystemPrompt } from './systemPrompt';
export type { SystemPromptConfig, PromptMode } from './systemPrompt';
export * from './dailyNotes';
export { SessionTranscript, listSessions, getRecentSessionsSummary } from './sessionTranscript';
export type { TranscriptEntry, SessionMeta } from './sessionTranscript';
export { searchMemory, formatSearchResults } from './memorySearch';
export type { MemorySearchResult, MemorySearchOptions } from './memorySearch';
export { SubagentRegistry, listRegistries, loadRegistrySnapshot } from './subagentRegistry';
export type { SubagentEntry, SubagentStatus, RegistrySnapshot } from './subagentRegistry';
export { WorktreeManager } from './worktreeManager';
export type { WorktreeInfo, WorktreeMergeResult } from './worktreeManager';
export { ExecutionLedger } from './executionLedger';
export type { LedgerState, LedgerSubtaskEntry, FileManifestEntry, JournalEntry } from './executionLedger';
export * from './announceFlow';
export { getConfig, setConfig, getDefaults, onConfigChange, formatConfig } from './config';
export type { JohannConfig } from './config';
export { handleDirective } from './directives';
export type { DirectiveResult } from './directives';
export { discoverSkills, formatSkillsForPrompt, getSkillInstructions, createSkill, readSkillFile } from './skills';
export type { Skill } from './skills';
export { HeartbeatManager } from './heartbeat';
export type { HeartbeatCheck } from './heartbeat';
export { JohannLogger, createLogger, getLogger } from './logger';
export type { LogLevel } from './logger';
export { ChatProgressReporter, buildFileTree } from './chatProgressReporter';
export type {
    ProgressEvent,
    ProgressReporter,
    TaskStartedEvent,
    TaskProgressEvent,
    TaskCompletedEvent,
    TaskFailedEvent,
    FileSetDiscoveredEvent,
    NoteEvent,
} from './progressEvents';
export { SessionPersistence } from './sessionPersistence';
export type { PersistedSubtask, PersistedSession, ResumableSession } from './sessionPersistence';
