import { describe, expect, it, vi } from 'vitest'
import {
  SCORE_DRAFT_STORAGE_KEY,
  createScoreAutoSave,
  restoreScoreDraft,
  saveScoreDraft,
  type StorageLike,
  type TimerScheduler,
} from './persistence'
import {
  SCORE_FORMAT_VERSION,
  createDefaultScore,
  serializeScore,
} from '../domain/guitarTab'

function memoryStorage(initial?: string): StorageLike & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value
    },
    setItem(_key, value) {
      this.value = value
    },
  }
}

function manualScheduler(): TimerScheduler & { run(): void; pending(): number } {
  let callback: (() => void) | null = null
  return {
    setTimeout(nextCallback) {
      callback = nextCallback
      return nextCallback
    },
    clearTimeout(timerId) {
      if (callback === timerId) callback = null
    },
    run() {
      const pendingCallback = callback
      callback = null
      pendingCallback?.()
    },
    pending: () => Number(callback !== null),
  }
}

describe('draft recovery', () => {
  it('restores a valid versioned score and reports an empty store', () => {
    const score = createDefaultScore(() => 'score-or-measure-id')
    score.measures[0].id = 'measure-id'

    expect(restoreScoreDraft(memoryStorage())).toEqual({
      status: 'empty',
      writeProtected: false,
    })
    expect(restoreScoreDraft(memoryStorage(serializeScore(score)))).toEqual({
      status: 'restored',
      score,
      writeProtected: false,
    })
  })

  it.each([
    ['invalid JSON', '{'],
    ['null', 'null'],
    [
      'unsupported version',
      JSON.stringify({
        version: SCORE_FORMAT_VERSION + 1,
        score: createDefaultScore(),
      }),
    ],
  ])('preserves corrupt raw data for %s', (_label, rawData) => {
    const storage = memoryStorage(rawData)
    const result = restoreScoreDraft(storage)

    expect(result).toMatchObject({
      status: 'corrupt',
      rawData,
      writeProtected: true,
      error: { code: 'corrupt-draft' },
    })
    expect(storage.value).toBe(rawData)
  })

  it('reports storage read failures without attempting a write', () => {
    const setItem = vi.fn()
    const result = restoreScoreDraft({
      getItem: () => {
        throw new DOMException('denied')
      },
      setItem,
    })

    expect(result).toMatchObject({
      status: 'error',
      writeProtected: true,
      error: { code: 'storage-read-failed' },
    })
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('draft saving', () => {
  it('debounces writes, saves only the latest score, and publishes states', () => {
    const storage = memoryStorage()
    const scheduler = manualScheduler()
    const states: string[] = []
    const first = createDefaultScore()
    const second = { ...first, title: '最终标题' }
    const autoSave = createScoreAutoSave({
      storage,
      scheduler,
      delayMs: 300,
      now: () => 1234,
      onStateChange: ({ status }) => states.push(status),
    })

    autoSave.schedule(first)
    autoSave.schedule(second)
    expect(scheduler.pending()).toBe(1)
    expect(autoSave.getState()).toMatchObject({
      status: 'saving',
      hasUnsavedChanges: true,
    })

    scheduler.run()
    expect(storage.value).toBe(serializeScore(second))
    expect(autoSave.getState()).toEqual({
      status: 'saved',
      hasUnsavedChanges: false,
      error: null,
      lastSavedAt: 1234,
    })
    expect(states).toEqual(['saving', 'saving', 'saved'])
  })

  it('reports storage write failures and keeps changes unsaved', () => {
    const score = createDefaultScore()
    const autoSave = createScoreAutoSave({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('quota exceeded')
        },
      },
      scheduler: manualScheduler(),
    })

    autoSave.schedule(score)
    const result = autoSave.flush()

    expect(result).toMatchObject({
      status: 'error',
      hasUnsavedChanges: true,
      error: { code: 'storage-write-failed' },
    })
    expect(result.error?.message).toMatch(/无法保存/)
  })

  it('does not overwrite protected corrupt data until explicitly allowed', () => {
    const rawData = '{broken'
    const storage = memoryStorage(rawData)
    const scheduler = manualScheduler()
    const autoSave = createScoreAutoSave({
      storage,
      scheduler,
      writeProtected: true,
    })

    autoSave.schedule(createDefaultScore())
    scheduler.run()
    expect(storage.value).toBe(rawData)
    expect(autoSave.getState().error).toMatchObject({
      code: 'protected-draft',
    })

    autoSave.allowProtectedDraftReplacement()
    autoSave.schedule(createDefaultScore())
    scheduler.run()
    expect(storage.value).not.toBe(rawData)
    expect(autoSave.getState().status).toBe('saved')
  })

  it('wraps direct storage failures with a stable error code', () => {
    expect(() =>
      saveScoreDraft(createDefaultScore(), {
        getItem: () => null,
        setItem: () => {
          throw new Error('full')
        },
      }, SCORE_DRAFT_STORAGE_KEY),
    ).toThrow(expect.objectContaining({
      code: 'storage-write-failed',
    }))
  })
})
