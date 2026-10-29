import z from '@deepseek-ai/schemastery';

/** Hard product limits from the v0.1 specification. */
export const HARD_MAX_RECALL_CHARS = 1200;
export const HARD_MAX_RECALL_TIMEOUT_MS = 1500;
export const HARD_MAX_CAPTURE_TIMEOUT_MS = 90000;

export const DEFAULT_CONFIG = Object.freeze({
  project: 'personal',
  autoRecall: true,
  autoCapture: true,
  maxRecallNotes: 3,
  maxContextChars: 2400,
  recentContext: true,
  recentContextTokens: 16384,
  maxIndexNotes: 1,
  maxIndexChars: 600,
  maxTimelineEntries: 8,
  maxTimelineChars: 500,
  timelineHours: 48,
  maxRecallChars: HARD_MAX_RECALL_CHARS,
  recallTimeoutMs: HARD_MAX_RECALL_TIMEOUT_MS,
  captureTimeoutMs: HARD_MAX_CAPTURE_TIMEOUT_MS,
  captureFolder: 'chats',
  minRecallScore: 0.0,
  captureMaxTokens: 8192,
  maxAutomaticFailures: 3,
  captureProvider: '',
  captureModel: '',
  personalRecall: true,
  personalRecallMaxNotes: 2,
  personalRecallMaxChars: 1600,
  vaultPath: '',
  softenFactor: 0.5,
  halfLifeDays: 30,
  priorityFloor: 0.01,
});

/** Schemastery schema used by the DSH plugin loader. */
export const Config = z.object({
  project: z.string().default('personal'),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  maxRecallNotes: z.number().min(1).max(10).default(3),
  maxContextChars: z.number().min(400).max(8000).default(2400),
  recentContext: z.boolean().default(true),
  recentContextTokens: z.number().min(1024).max(131072).default(16384),
  maxIndexNotes: z.number().min(0).max(2).default(1),
  maxIndexChars: z.number().min(200).max(900).default(600),
  maxTimelineEntries: z.number().min(0).max(8).default(8),
  maxTimelineChars: z.number().min(200).max(800).default(500),
  timelineHours: z.number().min(1).max(168).default(48),
  maxRecallChars: z.number().min(200).max(HARD_MAX_RECALL_CHARS).default(HARD_MAX_RECALL_CHARS),
  recallTimeoutMs: z.number().min(100).max(HARD_MAX_RECALL_TIMEOUT_MS).default(HARD_MAX_RECALL_TIMEOUT_MS),
  captureTimeoutMs: z.number().min(1000).max(HARD_MAX_CAPTURE_TIMEOUT_MS).default(HARD_MAX_CAPTURE_TIMEOUT_MS),
  captureFolder: z.string().default('chats'),
  minRecallScore: z.number().min(0).max(1).default(0.0),
  maxAutomaticFailures: z.number().min(1).max(10).default(3),
  captureMaxTokens: z.number().min(64).max(8192).default(8192),
  captureProvider: z.string().default(''),
  captureModel: z.string().default(''),
  personalRecall: z.boolean().default(true),
  personalRecallMaxNotes: z.number().min(1).max(2).default(2),
  personalRecallMaxChars: z.number().min(200).max(1600).default(1600),
  vaultPath: z.string().default(''),
  softenFactor: z.number().min(0.05).max(0.95).default(0.5),
  halfLifeDays: z.number().min(1).max(3650).default(30),
  priorityFloor: z.number().min(0.000001).max(0.5).default(0.01),
});

function integerInRange(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function numberInRange(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Normalize loader-provided or test-provided configuration without trusting it.
 * Invalid individual fields fall back to safe defaults instead of disabling chat.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};

  return Object.freeze({
    project: nonEmptyString(input.project, DEFAULT_CONFIG.project),
    autoRecall: typeof input.autoRecall === 'boolean' ? input.autoRecall : DEFAULT_CONFIG.autoRecall,
    autoCapture: typeof input.autoCapture === 'boolean' ? input.autoCapture : DEFAULT_CONFIG.autoCapture,
    maxRecallNotes: integerInRange(input.maxRecallNotes, DEFAULT_CONFIG.maxRecallNotes, 1, 10),
    maxContextChars: integerInRange(input.maxContextChars, DEFAULT_CONFIG.maxContextChars, 400, 8000),
    recentContext: typeof input.recentContext === 'boolean' ? input.recentContext : DEFAULT_CONFIG.recentContext,
    recentContextTokens: integerInRange(input.recentContextTokens, DEFAULT_CONFIG.recentContextTokens, 1024, 131072),
    maxIndexNotes: integerInRange(input.maxIndexNotes, DEFAULT_CONFIG.maxIndexNotes, 0, 2),
    maxIndexChars: integerInRange(input.maxIndexChars, DEFAULT_CONFIG.maxIndexChars, 200, 900),
    maxTimelineEntries: integerInRange(input.maxTimelineEntries, DEFAULT_CONFIG.maxTimelineEntries, 0, 8),
    maxTimelineChars: integerInRange(input.maxTimelineChars, DEFAULT_CONFIG.maxTimelineChars, 200, 800),
    timelineHours: numberInRange(input.timelineHours, DEFAULT_CONFIG.timelineHours, 1, 168),
    maxRecallChars: integerInRange(input.maxRecallChars, DEFAULT_CONFIG.maxRecallChars, 200, HARD_MAX_RECALL_CHARS),
    recallTimeoutMs: integerInRange(input.recallTimeoutMs, DEFAULT_CONFIG.recallTimeoutMs, 100, HARD_MAX_RECALL_TIMEOUT_MS),
    captureTimeoutMs: integerInRange(input.captureTimeoutMs, DEFAULT_CONFIG.captureTimeoutMs, 1000, HARD_MAX_CAPTURE_TIMEOUT_MS),
    captureFolder: nonEmptyString(input.captureFolder, DEFAULT_CONFIG.captureFolder),
    minRecallScore: numberInRange(input.minRecallScore, DEFAULT_CONFIG.minRecallScore, 0, 1),
    maxAutomaticFailures: integerInRange(input.maxAutomaticFailures, DEFAULT_CONFIG.maxAutomaticFailures, 1, 10),
    captureMaxTokens: integerInRange(input.captureMaxTokens, DEFAULT_CONFIG.captureMaxTokens, 64, 8192),
    captureProvider: typeof input.captureProvider === 'string' ? input.captureProvider.trim() : '',
    captureModel: typeof input.captureModel === 'string' ? input.captureModel.trim() : '',
    personalRecall: typeof input.personalRecall === 'boolean' ? input.personalRecall : DEFAULT_CONFIG.personalRecall,
    personalRecallMaxNotes: integerInRange(input.personalRecallMaxNotes, DEFAULT_CONFIG.personalRecallMaxNotes, 1, 2),
    personalRecallMaxChars: integerInRange(input.personalRecallMaxChars, DEFAULT_CONFIG.personalRecallMaxChars, 200, 1600),
    vaultPath: typeof input.vaultPath === 'string' ? input.vaultPath.trim() : '',
    softenFactor: numberInRange(input.softenFactor, DEFAULT_CONFIG.softenFactor, 0.05, 0.95),
    halfLifeDays: numberInRange(input.halfLifeDays, DEFAULT_CONFIG.halfLifeDays, 1, 3650),
    priorityFloor: numberInRange(input.priorityFloor, DEFAULT_CONFIG.priorityFloor, 0.000001, 0.5),
  });
}
