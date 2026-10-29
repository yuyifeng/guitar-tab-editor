import {
  parseScoreJson,
  serializeScore,
  type Score,
} from '../domain/guitarTab'

export const SCORE_DRAFT_STORAGE_KEY = 'guitar-tab-editor:score-draft'
export const DEFAULT_AUTO_SAVE_DELAY_MS = 600

export type SaveStatus = 'saving' | 'saved' | 'error'

export interface SaveState {
  status: SaveStatus
  hasUnsavedChanges: boolean
  error: PersistenceError | null
  lastSavedAt: number | null
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(timerId: unknown): void
}

export type DraftRecoveryResult =
  | { status: 'empty'; writeProtected: false }
  | { status: 'restored'; score: Score; writeProtected: false }
  | {
      status: 'corrupt'
      rawData: string
      error: PersistenceError
      writeProtected: true
    }
  | { status: 'error'; error: PersistenceError; writeProtected: true }

export type PersistenceErrorCode =
  | 'storage-read-failed'
  | 'storage-write-failed'
  | 'corrupt-draft'
  | 'protected-draft'

export class PersistenceError extends Error {
  constructor(
    public readonly code: PersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PersistenceError'
  }
}

export interface ScoreAutoSaveOptions {
  storage?: StorageLike
  storageKey?: string
  delayMs?: number
  scheduler?: TimerScheduler
  now?: () => number
  writeProtected?: boolean
  onStateChange?: (state: SaveState) => void
}

export interface ScoreAutoSave {
  getState(): SaveState
  schedule(score: Score): SaveState
  flush(): SaveState
  cancel(): void
  allowProtectedDraftReplacement(): void
}

const browserScheduler: TimerScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timerId) =>
    globalThis.clearTimeout(timerId as ReturnType<typeof setTimeout>),
}

function browserStorage(): StorageLike {
  return globalThis.localStorage
}

export function restoreScoreDraft(
  storage?: StorageLike,
  storageKey = SCORE_DRAFT_STORAGE_KEY,
): DraftRecoveryResult {
  let rawData: string | null
  try {
    rawData = (storage ?? browserStorage()).getItem(storageKey)
  } catch (cause) {
    return {
      status: 'error',
      error: new PersistenceError(
        'storage-read-failed',
        '无法读取本地草稿，浏览器存储当前不可用。',
        { cause },
      ),
      writeProtected: true,
    }
  }

  if (rawData === null) {
    return { status: 'empty', writeProtected: false }
  }

  try {
    return {
      status: 'restored',
      score: parseScoreJson(rawData),
      writeProtected: false,
    }
  } catch (cause) {
    return {
      status: 'corrupt',
      rawData,
      error: new PersistenceError(
        'corrupt-draft',
        `本地草稿已损坏或版本不兼容，原数据已保留且不会被自动覆盖：${errorMessage(cause)}`,
        { cause },
      ),
      writeProtected: true,
    }
  }
}

export function saveScoreDraft(
  score: Score,
  storage?: StorageLike,
  storageKey = SCORE_DRAFT_STORAGE_KEY,
): void {
  const serialized = serializeScore(score)
  try {
    (storage ?? browserStorage()).setItem(storageKey, serialized)
  } catch (cause) {
    throw new PersistenceError(
      'storage-write-failed',
      '无法保存本地草稿，请检查浏览器存储权限或可用空间。',
      { cause },
    )
  }
}

export function createScoreAutoSave(
  options: ScoreAutoSaveOptions = {},
): ScoreAutoSave {
  const storage = options.storage
  const storageKey = options.storageKey ?? SCORE_DRAFT_STORAGE_KEY
  const delayMs = options.delayMs ?? DEFAULT_AUTO_SAVE_DELAY_MS
  const scheduler = options.scheduler ?? browserScheduler
  const now = options.now ?? Date.now
  const onStateChange = options.onStateChange ?? (() => undefined)

  let writeProtected = options.writeProtected ?? false
  let pendingScore: Score | null = null
  let timerId: unknown = null
  let state: SaveState = writeProtected
    ? {
        status: 'error',
        hasUnsavedChanges: true,
        error: protectedDraftError(),
        lastSavedAt: null,
      }
    : {
        status: 'saved',
        hasUnsavedChanges: false,
        error: null,
        lastSavedAt: null,
      }

  const publish = (nextState: SaveState): SaveState => {
    state = nextState
    onStateChange(state)
    return state
  }

  const clearTimer = (): void => {
    if (timerId === null) return
    scheduler.clearTimeout(timerId)
    timerId = null
  }

  const flush = (): SaveState => {
    clearTimer()
    if (pendingScore === null) return state

    if (writeProtected) {
      pendingScore = null
      return publish({
        ...state,
        status: 'error',
        hasUnsavedChanges: true,
        error: protectedDraftError(),
      })
    }

    const score = pendingScore
    pendingScore = null
    try {
      saveScoreDraft(score, storage, storageKey)
      return publish({
        status: 'saved',
        hasUnsavedChanges: false,
        error: null,
        lastSavedAt: now(),
      })
    } catch (cause) {
      const error = cause instanceof PersistenceError
        ? cause
        : new PersistenceError(
            'storage-write-failed',
            '无法保存本地草稿。',
            { cause },
          )
      return publish({
        ...state,
        status: 'error',
        hasUnsavedChanges: true,
        error,
      })
    }
  }

  return {
    getState: () => state,
    schedule: (score) => {
      clearTimer()
      pendingScore = score
      const savingState = publish({
        ...state,
        status: 'saving',
        hasUnsavedChanges: true,
        error: null,
      })
      timerId = scheduler.setTimeout(flush, delayMs)
      return savingState
    },
    flush,
    cancel: () => {
      clearTimer()
      pendingScore = null
    },
    allowProtectedDraftReplacement: () => {
      writeProtected = false
    },
  }
}

export function requiresUnsavedChangesConfirmation(state: SaveState): boolean {
  return state.hasUnsavedChanges
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function protectedDraftError(): PersistenceError {
  return new PersistenceError(
    'protected-draft',
    '检测到损坏或不可读取的本地草稿。请先确认新建或导入，再允许覆盖原数据。',
  )
}
