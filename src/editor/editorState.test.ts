import { describe, expect, it } from 'vitest'
import {
  createDefaultScore,
  createMeasure,
  createStringNote,
  createTimePosition,
  type IdFactory,
  type Score,
} from '../domain/guitarTab'
import {
  createEditorReducer,
  createEditorState,
  getSelectedPositionRefs,
  type EditorAction,
  type EditorState,
} from './editorState'

function sequentialIds(start = 0): IdFactory {
  let nextId = start
  return () => `id-${++nextId}`
}

function scoreWithPositions(): Score {
  const ids = sequentialIds()
  const score = createDefaultScore(ids)
  const first = createTimePosition(
    'quarter',
    [createStringNote(1, 3, ids), createStringNote(2, 5, ids)],
    ids,
  )
  const second = createTimePosition(
    'eighth',
    [createStringNote(3, 7, ids)],
    ids,
  )
  const third = createTimePosition('half', [], ids)
  const secondMeasure = createMeasure([third], ids)
  return {
    ...score,
    measures: [
      { ...score.measures[0], positions: [first, second] },
      secondMeasure,
    ],
  }
}

function reduce(
  state: EditorState,
  actions: EditorAction[],
  ids: IdFactory = sequentialIds(100),
): EditorState {
  const reducer = createEditorReducer(ids)
  return actions.reduce(reducer, state)
}

describe('editor cursor and selections', () => {
  it('moves across all six strings and across measure boundaries', () => {
    const score = scoreWithPositions()
    const initial = createEditorState(score)
    const moved = reduce(initial, [
      { type: 'move-cursor', direction: 'string-up' },
      { type: 'move-cursor', direction: 'string-down' },
      { type: 'move-cursor', direction: 'string-down' },
      { type: 'move-cursor', direction: 'position-next' },
      { type: 'move-cursor', direction: 'position-next' },
      { type: 'move-cursor', direction: 'string-down' },
      { type: 'move-cursor', direction: 'string-down' },
      { type: 'move-cursor', direction: 'string-down' },
      { type: 'move-cursor', direction: 'string-down' },
      { type: 'move-cursor', direction: 'string-down' },
    ])

    expect(moved.cursor).toEqual({
      measureId: score.measures[1].id,
      positionId: score.measures[1].positions[0].id,
      stringNumber: 6,
    })
  })

  it('represents note, full-position, and normalized continuous range selections', () => {
    const score = scoreWithPositions()
    const [first, second] = score.measures[0].positions
    const third = score.measures[1].positions[0]
    const initial = createEditorState(score)

    const noteSelected = reduce(initial, [{
      type: 'select-note',
      target: { measureId: score.measures[0].id, positionId: first.id },
      stringNumber: 2,
    }])
    expect(noteSelected.selection.type).toBe('note')

    const positionSelected = reduce(noteSelected, [{
      type: 'select-position',
      target: { measureId: score.measures[0].id, positionId: second.id },
    }])
    expect(positionSelected.selection.type).toBe('position')

    const rangeSelected = reduce(positionSelected, [{
      type: 'select-range',
      anchor: { measureId: score.measures[1].id, positionId: third.id },
      focus: { measureId: score.measures[0].id, positionId: first.id },
    }])
    expect(getSelectedPositionRefs(score, rangeSelected.selection)).toEqual([
      { measureId: score.measures[0].id, positionId: first.id },
      { measureId: score.measures[0].id, positionId: second.id },
      { measureId: score.measures[1].id, positionId: third.id },
    ])
  })
})

describe('fret entry', () => {
  it('buffers one digit until Enter or timeout and commits a valid second digit together', () => {
    const score = scoreWithPositions()
    const initial = createEditorState(score)
    const buffered = reduce(initial, [{ type: 'input-fret-digit', digit: 1 }])

    expect(buffered.fretInput).toEqual({ digits: '1' })
    expect(buffered.score).toBe(score)

    const twoDigit = reduce(buffered, [{ type: 'input-fret-digit', digit: 2 }])
    expect(twoDigit.fretInput).toBeNull()
    expect(twoDigit.score.measures[0].positions[0].notes[0]).toMatchObject({
      stringNumber: 1,
      fret: 12,
    })
    expect(twoDigit.past).toHaveLength(1)

    const timeoutCommit = reduce(
      createEditorState(score),
      [
        { type: 'input-fret-digit', digit: 0 },
        { type: 'expire-fret-input' },
      ],
    )
    expect(timeoutCommit.score.measures[0].positions[0].notes[0].fret).toBe(0)

    const enterCommit = reduce(
      createEditorState(score),
      [
        { type: 'input-fret-digit', digit: 7 },
        { type: 'commit-fret-input' },
      ],
    )
    expect(enterCommit.score.measures[0].positions[0].notes[0].fret).toBe(7)
  })

  it('rejects invalid digit combinations without writing an out-of-range fret', () => {
    const score = scoreWithPositions()
    const state = reduce(createEditorState(score), [
      { type: 'input-fret-digit', digit: 2 },
      { type: 'input-fret-digit', digit: 5 },
    ])

    expect(state.fretInput).toEqual({ digits: '2' })
    expect(state.score).toBe(score)
  })

  it('replaces a note in place or inserts a new position before the cursor', () => {
    const score = scoreWithPositions()
    const originalPosition = score.measures[0].positions[0]
    const originalNote = originalPosition.notes[0]
    const replaced = reduce(createEditorState(score), [
      { type: 'write-fret', fret: 24, mode: 'replace' },
    ])

    expect(replaced.score.measures[0].positions[0].id).toBe(originalPosition.id)
    expect(replaced.score.measures[0].positions[0].notes[0]).toEqual({
      ...originalNote,
      fret: 24,
    })

    const inserted = reduce(createEditorState(score), [
      { type: 'write-fret', fret: 9, mode: 'insert', duration: 'sixteenth' },
    ])
    expect(inserted.score.measures[0].positions).toHaveLength(3)
    expect(inserted.score.measures[0].positions[0]).toMatchObject({
      duration: 'sixteenth',
      notes: [expect.objectContaining({ stringNumber: 1, fret: 9 })],
    })
    expect(inserted.score.measures[0].positions[1]).toBe(originalPosition)
  })
})

describe('delete, clipboard, and history', () => {
  it('deletes only one string note for note selection', () => {
    const score = scoreWithPositions()
    const position = score.measures[0].positions[0]
    const state = reduce(createEditorState(score), [
      {
        type: 'select-note',
        target: { measureId: score.measures[0].id, positionId: position.id },
        stringNumber: 1,
      },
      { type: 'delete-selection' },
    ])

    expect(state.score.measures[0].positions[0]).toMatchObject({
      id: position.id,
      duration: position.duration,
      notes: [expect.objectContaining({ stringNumber: 2, fret: 5 })],
    })
  })

  it('deletes complete positions for a position or range selection', () => {
    const score = scoreWithPositions()
    const [first, second] = score.measures[0].positions
    const state = reduce(createEditorState(score), [
      {
        type: 'select-range',
        anchor: { measureId: score.measures[0].id, positionId: first.id },
        focus: { measureId: score.measures[0].id, positionId: second.id },
      },
      { type: 'delete-selection' },
    ])

    expect(state.score.measures[0].positions).toEqual([])
    expect(state.score.measures[1].positions).toHaveLength(1)
    expect(state.cursor.positionId).toBe(state.score.measures[1].positions[0].id)
  })

  it('copies a range and pastes structurally equal positions with all-new IDs', () => {
    const score = scoreWithPositions()
    const [first, second] = score.measures[0].positions
    const target = score.measures[1].positions[0]
    const state = reduce(createEditorState(score), [
      {
        type: 'select-range',
        anchor: { measureId: score.measures[0].id, positionId: first.id },
        focus: { measureId: score.measures[0].id, positionId: second.id },
      },
      { type: 'copy-selection' },
      {
        type: 'set-cursor',
        cursor: {
          measureId: score.measures[1].id,
          positionId: target.id,
          stringNumber: 4,
        },
      },
      { type: 'paste-positions' },
    ])

    const pasted = state.score.measures[1].positions.slice(0, 2)
    const sourceIds = new Set([
      first.id,
      second.id,
      ...first.notes.map(({ id }) => id),
      ...second.notes.map(({ id }) => id),
    ])
    const pastedIds = [
      ...pasted.map(({ id }) => id),
      ...pasted.flatMap(({ notes }) => notes.map(({ id }) => id)),
    ]

    expect(pasted.map(({ duration, notes }) => ({ duration, notes: notes.map(
      ({ stringNumber, fret }) => ({ stringNumber, fret }),
    ) }))).toEqual([first, second].map(({ duration, notes }) => ({
      duration,
      notes: notes.map(({ stringNumber, fret }) => ({ stringNumber, fret })),
    })))
    expect(pastedIds.every((id) => !sourceIds.has(id))).toBe(true)
    expect(new Set(pastedIds).size).toBe(pastedIds.length)
  })

  it('undoes and redoes score changes while retaining playback and scroll state', () => {
    const score = scoreWithPositions()
    const edited = reduce(createEditorState(score), [
      { type: 'set-playback', playback: { status: 'playing', positionId: 'playing-id' } },
      { type: 'set-scroll', scroll: { left: 30, top: 80 } },
      { type: 'write-fret', fret: 12 },
    ])
    const undone = reduce(edited, [{ type: 'undo' }])
    const redone = reduce(undone, [{ type: 'redo' }])

    expect(undone.score).toBe(score)
    expect(undone.playback).toEqual({
      status: 'playing',
      positionId: 'playing-id',
    })
    expect(undone.scroll).toEqual({ left: 30, top: 80 })
    expect(undone.past).toHaveLength(0)
    expect(undone.future).toHaveLength(1)
    expect(redone.score.measures[0].positions[0].notes[0].fret).toBe(12)
    expect(redone.playback).toBe(undone.playback)
    expect(redone.scroll).toBe(undone.scroll)
  })

  it('does not create history entries for cursor, selection, clipboard, playback, or scroll', () => {
    const score = scoreWithPositions()
    const first = score.measures[0].positions[0]
    const state = reduce(createEditorState(score), [
      { type: 'move-cursor', direction: 'string-down' },
      {
        type: 'select-position',
        target: { measureId: score.measures[0].id, positionId: first.id },
      },
      { type: 'copy-selection' },
      { type: 'set-playback', playback: { status: 'paused', positionId: first.id } },
      { type: 'set-scroll', scroll: { left: 10, top: 20 } },
    ])

    expect(state.past).toEqual([])
    expect(state.future).toEqual([])
    expect(state.score).toBe(score)
  })
})
