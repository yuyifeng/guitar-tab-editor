import {
  createStableId,
  createStringNote,
  createTimePosition,
  setStringNote,
  type EntityId,
  type Fret,
  type IdFactory,
  type NoteDuration,
  type Score,
  type StringNumber,
  type TimePosition,
} from '../domain/guitarTab'

export interface PositionRef {
  measureId: EntityId
  positionId: EntityId
}

export interface EditorCursor {
  measureId: EntityId
  positionId: EntityId | null
  stringNumber: StringNumber
}

export type EditorSelection =
  | { type: 'none' }
  | ({ type: 'note'; stringNumber: StringNumber } & PositionRef)
  | ({ type: 'position' } & PositionRef)
  | { type: 'range'; anchor: PositionRef; focus: PositionRef }

export type EntryMode = 'insert' | 'replace'

export interface FretInput {
  digits: string
}

export interface PlaybackState {
  status: 'stopped' | 'playing' | 'paused'
  positionId: EntityId | null
}

export interface ScrollState {
  left: number
  top: number
}

export interface EditorState {
  score: Score
  cursor: EditorCursor
  selection: EditorSelection
  entryMode: EntryMode
  fretInput: FretInput | null
  clipboard: TimePosition[]
  past: Score[]
  future: Score[]
  playback: PlaybackState
  scroll: ScrollState
}

export type CursorDirection = 'string-up' | 'string-down' | 'position-previous' | 'position-next'

export type EditorAction =
  | { type: 'set-cursor'; cursor: EditorCursor }
  | { type: 'move-cursor'; direction: CursorDirection }
  | { type: 'select-note'; target: PositionRef; stringNumber: StringNumber }
  | { type: 'select-position'; target: PositionRef }
  | { type: 'select-range'; anchor: PositionRef; focus: PositionRef }
  | { type: 'clear-selection' }
  | { type: 'set-entry-mode'; mode: EntryMode }
  | { type: 'input-fret-digit'; digit: number }
  | { type: 'commit-fret-input' }
  | { type: 'expire-fret-input' }
  | { type: 'cancel-fret-input' }
  | { type: 'write-fret'; fret: Fret; mode?: EntryMode; duration?: NoteDuration }
  | { type: 'delete-selection' }
  | { type: 'copy-selection' }
  | { type: 'paste-positions' }
  | { type: 'replace-score'; score: Score }
  | { type: 'reset-score'; score: Score }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'set-playback'; playback: PlaybackState }
  | { type: 'set-scroll'; scroll: ScrollState }

const NO_SELECTION: EditorSelection = { type: 'none' }
const HISTORY_LIMIT = 100

interface PositionedEntry extends PositionRef {
  position: TimePosition
}

export function createEditorState(score: Score): EditorState {
  const firstMeasure = score.measures[0]
  return {
    score,
    cursor: {
      measureId: firstMeasure.id,
      positionId: firstMeasure.positions[0]?.id ?? null,
      stringNumber: 1,
    },
    selection: NO_SELECTION,
    entryMode: 'replace',
    fretInput: null,
    clipboard: [],
    past: [],
    future: [],
    playback: { status: 'stopped', positionId: null },
    scroll: { left: 0, top: 0 },
  }
}

export function createEditorReducer(
  idFactory: IdFactory = createStableId,
): (state: EditorState, action: EditorAction) => EditorState {
  return (state, action) => reduceEditorState(state, action, idFactory)
}

export const editorReducer = createEditorReducer()

export function getSelectedPositionRefs(
  score: Score,
  selection: EditorSelection,
): PositionRef[] {
  if (selection.type === 'none') return []
  if (selection.type === 'note' || selection.type === 'position') {
    return positionExists(score, selection) ? [toPositionRef(selection)] : []
  }

  const entries = flattenPositions(score)
  const anchorIndex = findEntryIndex(entries, selection.anchor)
  const focusIndex = findEntryIndex(entries, selection.focus)
  if (anchorIndex === -1 || focusIndex === -1) return []

  const start = Math.min(anchorIndex, focusIndex)
  const end = Math.max(anchorIndex, focusIndex)
  return entries.slice(start, end + 1).map(toPositionRef)
}

function reduceEditorState(
  state: EditorState,
  action: EditorAction,
  idFactory: IdFactory,
): EditorState {
  switch (action.type) {
    case 'set-cursor':
      return {
        ...state,
        cursor: normalizeCursor(state.score, action.cursor),
        fretInput: null,
      }
    case 'move-cursor':
      return {
        ...state,
        cursor: moveCursor(state.score, state.cursor, action.direction),
        fretInput: null,
      }
    case 'select-note':
      if (!positionExists(state.score, action.target)) return state
      return {
        ...state,
        cursor: {
          ...action.target,
          stringNumber: action.stringNumber,
        },
        selection: {
          type: 'note',
          ...action.target,
          stringNumber: action.stringNumber,
        },
        fretInput: null,
      }
    case 'select-position':
      if (!positionExists(state.score, action.target)) return state
      return {
        ...state,
        cursor: {
          ...action.target,
          stringNumber: state.cursor.stringNumber,
        },
        selection: { type: 'position', ...action.target },
        fretInput: null,
      }
    case 'select-range':
      if (
        !positionExists(state.score, action.anchor)
        || !positionExists(state.score, action.focus)
      ) {
        return state
      }
      return {
        ...state,
        selection: {
          type: 'range',
          anchor: action.anchor,
          focus: action.focus,
        },
        cursor: {
          ...action.focus,
          stringNumber: state.cursor.stringNumber,
        },
        fretInput: null,
      }
    case 'clear-selection':
      return { ...state, selection: NO_SELECTION }
    case 'set-entry-mode':
      return { ...state, entryMode: action.mode, fretInput: null }
    case 'input-fret-digit':
      return inputFretDigit(state, action.digit, idFactory)
    case 'commit-fret-input':
    case 'expire-fret-input':
      return commitFretInput(state, idFactory)
    case 'cancel-fret-input':
      return { ...state, fretInput: null }
    case 'write-fret':
      return writeFret(
        state,
        action.fret,
        action.mode ?? state.entryMode,
        action.duration ?? 'quarter',
        idFactory,
      )
    case 'delete-selection':
      return deleteSelection(state)
    case 'copy-selection':
      return copySelection(state)
    case 'paste-positions':
      return pastePositions(state, idFactory)
    case 'replace-score':
      return recordScoreChange(state, action.score)
    case 'reset-score':
      return createEditorState(action.score)
    case 'undo':
      return undo(state)
    case 'redo':
      return redo(state)
    case 'set-playback':
      return { ...state, playback: action.playback }
    case 'set-scroll':
      return { ...state, scroll: action.scroll }
  }
}

function inputFretDigit(
  state: EditorState,
  digit: number,
  idFactory: IdFactory,
): EditorState {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return state

  const digits = `${state.fretInput?.digits ?? ''}${digit}`
  const fret = Number(digits)
  if (digits.length > 2 || fret > 24) return state

  if (digits.length === 2) {
    return writeFret(state, fret, state.entryMode, 'quarter', idFactory)
  }

  return { ...state, fretInput: { digits } }
}

function commitFretInput(state: EditorState, idFactory: IdFactory): EditorState {
  if (!state.fretInput) return state
  return writeFret(
    state,
    Number(state.fretInput.digits),
    state.entryMode,
    'quarter',
    idFactory,
  )
}

function writeFret(
  state: EditorState,
  fret: Fret,
  mode: EntryMode,
  duration: NoteDuration,
  idFactory: IdFactory,
): EditorState {
  if (!Number.isInteger(fret) || fret < 0 || fret > 24) return state

  const measureIndex = state.score.measures.findIndex(
    ({ id }) => id === state.cursor.measureId,
  )
  if (measureIndex === -1) return state

  const measure = state.score.measures[measureIndex]
  const positionIndex = measure.positions.findIndex(
    ({ id }) => id === state.cursor.positionId,
  )
  let nextPosition: TimePosition
  let nextPositionIndex: number

  if (mode === 'insert' || positionIndex === -1) {
    const note = createStringNote(state.cursor.stringNumber, fret, idFactory)
    nextPosition = createTimePosition(duration, [note], idFactory)
    nextPositionIndex = positionIndex === -1
      ? measure.positions.length
      : positionIndex
  } else {
    const position = measure.positions[positionIndex]
    const existingNote = position.notes.find(
      ({ stringNumber }) => stringNumber === state.cursor.stringNumber,
    )
    const note = existingNote
      ? { ...existingNote, fret }
      : createStringNote(state.cursor.stringNumber, fret, idFactory)
    nextPosition = setStringNote(position, note)
    nextPositionIndex = positionIndex
  }

  const positions = [...measure.positions]
  if (mode === 'insert' || positionIndex === -1) {
    positions.splice(nextPositionIndex, 0, nextPosition)
  } else {
    positions[nextPositionIndex] = nextPosition
  }

  const score = replaceMeasurePositions(state.score, measureIndex, positions)
  return recordScoreChange(state, score, {
    cursor: {
      measureId: measure.id,
      positionId: nextPosition.id,
      stringNumber: state.cursor.stringNumber,
    },
    selection: {
      type: 'note',
      measureId: measure.id,
      positionId: nextPosition.id,
      stringNumber: state.cursor.stringNumber,
    },
  })
}

function deleteSelection(state: EditorState): EditorState {
  const { selection } = state
  if (selection.type === 'none') return state

  if (selection.type === 'note') {
    const location = findPosition(state.score, selection)
    if (!location) return state
    const notes = location.position.notes.filter(
      ({ stringNumber }) => stringNumber !== selection.stringNumber,
    )
    if (notes.length === location.position.notes.length) return state

    const positions = [...location.measure.positions]
    positions[location.positionIndex] = { ...location.position, notes }
    const score = replaceMeasurePositions(state.score, location.measureIndex, positions)
    return recordScoreChange(state, score, {
      cursor: {
        ...toPositionRef(selection),
        stringNumber: selection.stringNumber,
      },
      selection: NO_SELECTION,
    })
  }

  const refs = getSelectedPositionRefs(state.score, selection)
  if (refs.length === 0) return state
  const removedIds = new Set(refs.map(({ positionId }) => positionId))
  const score: Score = {
    ...state.score,
    measures: state.score.measures.map((measure) => ({
      ...measure,
      positions: measure.positions.filter(({ id }) => !removedIds.has(id)),
    })),
  }
  const cursor = cursorAfterPositionDeletion(state.score, score, refs[0], state.cursor)
  return recordScoreChange(state, score, { cursor, selection: NO_SELECTION })
}

function copySelection(state: EditorState): EditorState {
  const { selection } = state
  if (selection.type === 'none') return state

  if (selection.type === 'note') {
    const location = findPosition(state.score, selection)
    const note = location?.position.notes.find(
      ({ stringNumber }) => stringNumber === selection.stringNumber,
    )
    if (!location || !note) return state
    return {
      ...state,
      clipboard: [{ ...location.position, notes: [{ ...note }] }],
    }
  }

  const selectedIds = new Set(
    getSelectedPositionRefs(state.score, selection).map(({ positionId }) => positionId),
  )
  const clipboard = flattenPositions(state.score)
    .filter(({ positionId }) => selectedIds.has(positionId))
    .map(({ position }) => clonePosition(position))
  return clipboard.length === 0 ? state : { ...state, clipboard }
}

function pastePositions(state: EditorState, idFactory: IdFactory): EditorState {
  if (state.clipboard.length === 0) return state
  const measureIndex = state.score.measures.findIndex(
    ({ id }) => id === state.cursor.measureId,
  )
  if (measureIndex === -1) return state

  const measure = state.score.measures[measureIndex]
  const cursorIndex = measure.positions.findIndex(
    ({ id }) => id === state.cursor.positionId,
  )
  const insertIndex = cursorIndex === -1 ? measure.positions.length : cursorIndex
  const pasted = state.clipboard.map((position) => ({
    ...position,
    id: idFactory(),
    notes: position.notes.map((note) => ({ ...note, id: idFactory() })),
  }))
  const positions = [...measure.positions]
  positions.splice(insertIndex, 0, ...pasted)
  const score = replaceMeasurePositions(state.score, measureIndex, positions)
  const first = pasted[0]
  const last = pasted[pasted.length - 1]
  const selection: EditorSelection = pasted.length === 1
    ? { type: 'position', measureId: measure.id, positionId: first.id }
    : {
        type: 'range',
        anchor: { measureId: measure.id, positionId: first.id },
        focus: { measureId: measure.id, positionId: last.id },
      }

  return recordScoreChange(state, score, {
    cursor: {
      measureId: measure.id,
      positionId: first.id,
      stringNumber: state.cursor.stringNumber,
    },
    selection,
  })
}

function recordScoreChange(
  state: EditorState,
  score: Score,
  editorChanges: Partial<Pick<EditorState, 'cursor' | 'selection'>> = {},
): EditorState {
  if (score === state.score) return state
  return {
    ...state,
    ...editorChanges,
    score,
    past: [...state.past, state.score].slice(-HISTORY_LIMIT),
    future: [],
    fretInput: null,
  }
}

function undo(state: EditorState): EditorState {
  const score = state.past.at(-1)
  if (!score) return state
  return {
    ...state,
    score,
    cursor: normalizeCursor(score, state.cursor),
    selection: NO_SELECTION,
    fretInput: null,
    past: state.past.slice(0, -1),
    future: [state.score, ...state.future],
  }
}

function redo(state: EditorState): EditorState {
  const score = state.future[0]
  if (!score) return state
  return {
    ...state,
    score,
    cursor: normalizeCursor(score, state.cursor),
    selection: NO_SELECTION,
    fretInput: null,
    past: [...state.past, state.score].slice(-HISTORY_LIMIT),
    future: state.future.slice(1),
  }
}

function moveCursor(
  score: Score,
  cursor: EditorCursor,
  direction: CursorDirection,
): EditorCursor {
  if (direction === 'string-up' || direction === 'string-down') {
    const delta = direction === 'string-up' ? -1 : 1
    const stringNumber = Math.min(6, Math.max(1, cursor.stringNumber + delta))
    return { ...normalizeCursor(score, cursor), stringNumber: stringNumber as StringNumber }
  }

  const entries = flattenPositions(score)
  if (entries.length === 0) return normalizeCursor(score, cursor)
  const currentIndex = entries.findIndex(({ positionId }) => positionId === cursor.positionId)
  let nextIndex: number
  if (currentIndex !== -1) {
    const delta = direction === 'position-next' ? 1 : -1
    nextIndex = Math.min(entries.length - 1, Math.max(0, currentIndex + delta))
  } else {
    const measureIndex = score.measures.findIndex(({ id }) => id === cursor.measureId)
    const candidateIndexes = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        const entryMeasureIndex = score.measures.findIndex(
          ({ id }) => id === entry.measureId,
        )
        return direction === 'position-next'
          ? entryMeasureIndex >= measureIndex
          : entryMeasureIndex <= measureIndex
      })
    nextIndex = direction === 'position-next'
      ? (candidateIndexes[0]?.index ?? entries.length - 1)
      : (candidateIndexes.at(-1)?.index ?? 0)
  }

  return {
    measureId: entries[nextIndex].measureId,
    positionId: entries[nextIndex].positionId,
    stringNumber: cursor.stringNumber,
  }
}

function normalizeCursor(score: Score, cursor: EditorCursor): EditorCursor {
  const measure = score.measures.find(({ id }) => id === cursor.measureId)
    ?? score.measures[0]
  const positionId = measure.positions.some(({ id }) => id === cursor.positionId)
    ? cursor.positionId
    : (measure.positions[0]?.id ?? null)
  return {
    measureId: measure.id,
    positionId,
    stringNumber: Math.min(6, Math.max(1, cursor.stringNumber)) as StringNumber,
  }
}

function cursorAfterPositionDeletion(
  previousScore: Score,
  score: Score,
  firstRemoved: PositionRef,
  cursor: EditorCursor,
): EditorCursor {
  const previousEntries = flattenPositions(previousScore)
  const removedIndex = findEntryIndex(previousEntries, firstRemoved)
  const entries = flattenPositions(score)
  if (entries.length === 0) {
    return normalizeCursor(score, { ...cursor, positionId: null })
  }
  const nextEntry = entries[Math.min(Math.max(removedIndex, 0), entries.length - 1)]
  return { ...toPositionRef(nextEntry), stringNumber: cursor.stringNumber }
}

function replaceMeasurePositions(
  score: Score,
  measureIndex: number,
  positions: TimePosition[],
): Score {
  const measures = [...score.measures]
  measures[measureIndex] = { ...measures[measureIndex], positions }
  return { ...score, measures }
}

function flattenPositions(score: Score): PositionedEntry[] {
  return score.measures.flatMap((measure) =>
    measure.positions.map((position) => ({
      measureId: measure.id,
      positionId: position.id,
      position,
    })),
  )
}

function findEntryIndex(entries: PositionedEntry[], ref: PositionRef): number {
  return entries.findIndex(
    ({ measureId, positionId }) =>
      measureId === ref.measureId && positionId === ref.positionId,
  )
}

function findPosition(score: Score, ref: PositionRef) {
  const measureIndex = score.measures.findIndex(({ id }) => id === ref.measureId)
  if (measureIndex === -1) return null
  const measure = score.measures[measureIndex]
  const positionIndex = measure.positions.findIndex(({ id }) => id === ref.positionId)
  if (positionIndex === -1) return null
  return {
    measure,
    measureIndex,
    position: measure.positions[positionIndex],
    positionIndex,
  }
}

function positionExists(score: Score, ref: PositionRef): boolean {
  return findPosition(score, ref) !== null
}

function toPositionRef(ref: PositionRef): PositionRef {
  return { measureId: ref.measureId, positionId: ref.positionId }
}

function clonePosition(position: TimePosition): TimePosition {
  return {
    ...position,
    notes: position.notes.map((note) => ({ ...note })),
  }
}
