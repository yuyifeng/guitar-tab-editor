import { describe, expect, it, vi } from 'vitest'
import {
  SCORE_FORMAT_VERSION,
  createDefaultScore,
  serializeScore,
  type ScoreDocument,
} from '../domain/guitarTab'
import {
  createScoreDownload,
  downloadScoreJson,
  parseImportedScoreJson,
  prepareNewScore,
  prepareScoreImport,
  readScoreFile,
  resolveScoreReplacement,
} from './fileWorkflow'
import type { SaveState } from './persistence'

const savedState: SaveState = {
  status: 'saved',
  hasUnsavedChanges: false,
  error: null,
  lastSavedAt: 1,
}

function validDocument(): ScoreDocument {
  return {
    version: SCORE_FORMAT_VERSION,
    score: createDefaultScore(),
  }
}

describe('score import', () => {
  it.each([
    ['invalid JSON', '{', 'invalid-json'],
    ['null', 'null', 'invalid-score'],
    [
      'unsupported version',
      JSON.stringify({ ...validDocument(), version: SCORE_FORMAT_VERSION + 1 }),
      'unsupported-version',
    ],
  ])('rejects %s with an explicit workflow error', (_label, json, code) => {
    expect(() => parseImportedScoreJson(json)).toThrow(
      expect.objectContaining({ code }),
    )
  })

  it.each([
    ['fret below range', -1],
    ['fret above range', 25],
    ['null fret', null],
  ])('rejects %s', (_label, fret) => {
    const document = validDocument()
    document.score.measures[0].positions = [{
      id: 'position-id',
      duration: 'quarter',
      notes: [{ id: 'note-id', stringNumber: 1, fret: fret as number }],
    }]

    expect(() => parseImportedScoreJson(JSON.stringify(document))).toThrow(
      expect.objectContaining({ code: 'invalid-score' }),
    )
  })

  it('rejects duplicate strings and leaves replacement to explicit confirmation', async () => {
    const document = validDocument()
    document.score.measures[0].positions = [{
      id: 'position-id',
      duration: 'quarter',
      notes: [
        { id: 'note-1', stringNumber: 2, fret: 3 },
        { id: 'note-2', stringNumber: 2, fret: 8 },
      ],
    }]

    await expect(prepareScoreImport(
      { name: 'duplicate.json', text: async () => JSON.stringify(document) },
    )).rejects.toMatchObject({ code: 'invalid-score' })

    const validPlan = await prepareScoreImport(
      { name: 'valid.json', text: async () => serializeScore(validDocument().score) },
    )
    expect(validPlan.requiresConfirmation).toBe(true)
    expect(resolveScoreReplacement(validPlan, false)).toEqual({
      status: 'cancelled',
    })
    expect(resolveScoreReplacement(validPlan, true)).toMatchObject({
      status: 'replace',
      clearHistory: true,
      saveImmediately: true,
    })
  })

  it('reports file read failures separately from validation failures', async () => {
    await expect(readScoreFile({
      name: 'unreadable.json',
      text: async () => {
        throw new DOMException('read failed')
      },
    })).rejects.toMatchObject({
      code: 'file-read-failed',
      message: expect.stringContaining('unreadable.json'),
    })
  })
})

describe('new score and export', () => {
  it('requires confirmation only while changes have not saved successfully', () => {
    const cleanPlan = prepareNewScore(savedState)
    const dirtyPlan = prepareNewScore({
      ...savedState,
      status: 'error',
      hasUnsavedChanges: true,
    })

    expect(cleanPlan.requiresConfirmation).toBe(false)
    expect(resolveScoreReplacement(cleanPlan, false).status).toBe('replace')
    expect(dirtyPlan.requiresConfirmation).toBe(true)
    expect(resolveScoreReplacement(dirtyPlan, false).status).toBe('cancelled')
  })

  it('creates a versioned UTF-8 download and sanitizes its file name', () => {
    const score = {
      ...createDefaultScore(),
      title: '  My / Tab:*?  ',
    }
    const file = createScoreDownload(score)

    expect(file.fileName).toBe('My - Tab---.guitar-tab.json')
    expect(file.mimeType).toBe('application/json;charset=utf-8')
    expect(JSON.parse(file.contents)).toEqual({
      version: SCORE_FORMAT_VERSION,
      score,
    })
  })

  it('uses an injectable download adapter and reports adapter failures', () => {
    const score = createDefaultScore()
    const download = vi.fn()

    const file = downloadScoreJson(score, { download })
    expect(download).toHaveBeenCalledWith(file)

    expect(() =>
      downloadScoreJson(score, {
        download: () => {
          throw new DOMException('blocked')
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'download-failed' }))
  })
})
