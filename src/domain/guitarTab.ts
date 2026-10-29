export const SCORE_FORMAT_VERSION = 1 as const

export const STANDARD_TUNING = ['E4', 'B3', 'G3', 'D3', 'A2', 'E2'] as const

export const SUPPORTED_TIME_SIGNATURES = ['2/4', '3/4', '4/4', '6/8'] as const

export const NOTE_DURATIONS = {
  whole: 16,
  half: 8,
  quarter: 4,
  eighth: 2,
  sixteenth: 1,
} as const

export type EntityId = string
export type StringNumber = 1 | 2 | 3 | 4 | 5 | 6
export type Fret = number
export type PitchName = string
export type NoteDuration = keyof typeof NOTE_DURATIONS
export type TimeSignature = (typeof SUPPORTED_TIME_SIGNATURES)[number]
export type IdFactory = () => EntityId

export interface StringNote {
  id: EntityId
  stringNumber: StringNumber
  fret: Fret
}

export interface TimePosition {
  id: EntityId
  duration: NoteDuration
  notes: StringNote[]
}

export interface Measure {
  id: EntityId
  positions: TimePosition[]
}

export interface Score {
  id: EntityId
  title: string
  timeSignature: TimeSignature
  bpm: number
  tuning: PitchName[]
  capo: number
  measures: Measure[]
}

export interface ScoreDocument {
  version: typeof SCORE_FORMAT_VERSION
  score: Score
}

export type MeasureCapacityStatus = 'underfilled' | 'exact' | 'overfilled'

export class ScoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScoreValidationError'
  }
}

let fallbackId = 0

export const createStableId: IdFactory = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  fallbackId += 1
  return `guitar-tab-${Date.now().toString(36)}-${fallbackId.toString(36)}`
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
}

export function createStringNote(
  stringNumber: StringNumber,
  fret: Fret,
  idFactory: IdFactory = createStableId,
): StringNote {
  requireIntegerInRange(stringNumber, 1, 6, 'String number')
  requireIntegerInRange(fret, 0, 24, 'Fret')
  return { id: idFactory(), stringNumber, fret }
}

export function createTimePosition(
  duration: NoteDuration = 'quarter',
  notes: StringNote[] = [],
  idFactory: IdFactory = createStableId,
): TimePosition {
  if (!(duration in NOTE_DURATIONS)) {
    throw new RangeError(`Unsupported note duration: ${String(duration)}`)
  }

  assertUniqueStrings(notes, 'Time position')
  return { id: idFactory(), duration, notes: [...notes] }
}

export function createRestPosition(
  duration: NoteDuration = 'quarter',
  idFactory: IdFactory = createStableId,
): TimePosition {
  return createTimePosition(duration, [], idFactory)
}

export function isRestPosition(position: TimePosition): boolean {
  return position.notes.length === 0
}

export function createMeasure(
  positions: TimePosition[] = [],
  idFactory: IdFactory = createStableId,
): Measure {
  return { id: idFactory(), positions: [...positions] }
}

export function createDefaultScore(idFactory: IdFactory = createStableId): Score {
  return {
    id: idFactory(),
    title: '未命名乐谱',
    timeSignature: '4/4',
    bpm: 120,
    tuning: [...STANDARD_TUNING],
    capo: 0,
    measures: [createMeasure([], idFactory)],
  }
}

export function setStringNote(
  position: TimePosition,
  note: StringNote,
): TimePosition {
  requireIntegerInRange(note.stringNumber, 1, 6, 'String number')
  requireIntegerInRange(note.fret, 0, 24, 'Fret')

  const notes = position.notes
    .filter(({ stringNumber }) => stringNumber !== note.stringNumber)
    .concat(note)
    .sort((left, right) => left.stringNumber - right.stringNumber)

  return { ...position, notes }
}

export function removeStringNote(
  position: TimePosition,
  stringNumber: StringNumber,
): TimePosition {
  return {
    ...position,
    notes: position.notes.filter((note) => note.stringNumber !== stringNumber),
  }
}

export function getTimeSignatureCapacity(timeSignature: TimeSignature): number {
  const [beats, denominator] = timeSignature.split('/').map(Number)
  return beats * (16 / denominator)
}

export function getMeasureDuration(measure: Measure): number {
  return measure.positions.reduce(
    (total, position) => total + NOTE_DURATIONS[position.duration],
    0,
  )
}

export function getMeasureCapacityStatus(
  measure: Measure,
  timeSignature: TimeSignature,
): MeasureCapacityStatus {
  const duration = getMeasureDuration(measure)
  const capacity = getTimeSignatureCapacity(timeSignature)

  if (duration < capacity) return 'underfilled'
  if (duration > capacity) return 'overfilled'
  return 'exact'
}

export function insertMeasureAfter(
  score: Score,
  afterMeasureId: EntityId,
  idFactory: IdFactory = createStableId,
): Score {
  const index = score.measures.findIndex(({ id }) => id === afterMeasureId)
  if (index === -1) {
    throw new RangeError(`Unknown measure ID: ${afterMeasureId}`)
  }

  const measures = [...score.measures]
  measures.splice(index + 1, 0, createMeasure([], idFactory))
  return { ...score, measures }
}

export function deleteMeasure(score: Score, measureId: EntityId): Score {
  const index = score.measures.findIndex(({ id }) => id === measureId)
  if (index === -1) {
    throw new RangeError(`Unknown measure ID: ${measureId}`)
  }

  if (score.measures.length === 1) {
    return {
      ...score,
      measures: [{ ...score.measures[0], positions: [] }],
    }
  }

  return {
    ...score,
    measures: score.measures.filter(({ id }) => id !== measureId),
  }
}

const PITCH_CLASS_TO_SEMITONE: Record<string, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
}

export function pitchNameToMidi(pitch: PitchName): number {
  const match = /^([A-G](?:#)?)(-1|[0-9])$/.exec(pitch)
  if (!match) {
    throw new RangeError(`Invalid scientific pitch name: ${pitch}`)
  }

  const [, pitchClass, octaveText] = match
  const midi = (Number(octaveText) + 1) * 12 + PITCH_CLASS_TO_SEMITONE[pitchClass]
  requireIntegerInRange(midi, 0, 127, 'MIDI note')
  return midi
}

export function stringNoteToMidi(
  tuning: readonly PitchName[],
  stringNumber: StringNumber,
  fret: Fret,
  capo: number,
): number {
  if (tuning.length !== 6) {
    throw new RangeError('Tuning must contain exactly six pitches')
  }

  requireIntegerInRange(stringNumber, 1, 6, 'String number')
  requireIntegerInRange(fret, 0, 24, 'Fret')
  requireIntegerInRange(capo, 0, 12, 'Capo')

  const midi = pitchNameToMidi(tuning[stringNumber - 1]) + fret + capo
  requireIntegerInRange(midi, 0, 127, 'Resulting MIDI note')
  return midi
}

export function midiToFrequency(midi: number): number {
  requireIntegerInRange(midi, 0, 127, 'MIDI note')
  return 440 * 2 ** ((midi - 69) / 12)
}

export function stringNoteToFrequency(
  tuning: readonly PitchName[],
  stringNumber: StringNumber,
  fret: Fret,
  capo: number,
): number {
  return midiToFrequency(stringNoteToMidi(tuning, stringNumber, fret, capo))
}

export function serializeScore(score: Score): string {
  const document: ScoreDocument = {
    version: SCORE_FORMAT_VERSION,
    score: validateScore(score, 'score'),
  }
  return JSON.stringify(document, null, 2)
}

export function parseScoreJson(json: string): Score {
  let input: unknown
  try {
    input = JSON.parse(json) as unknown
  } catch {
    throw new ScoreValidationError('Invalid JSON')
  }

  return parseScoreDocument(input).score
}

export function parseScoreDocument(input: unknown): ScoreDocument {
  const document = requireObject(input, 'document')
  requireExactKeys(document, ['version', 'score'], 'document')

  if (document.version !== SCORE_FORMAT_VERSION) {
    throw new ScoreValidationError(`Unsupported score version: ${String(document.version)}`)
  }

  return {
    version: SCORE_FORMAT_VERSION,
    score: validateScore(document.score, 'score'),
  }
}

function validateScore(input: unknown, path: string): Score {
  const score = requireObject(input, path)
  requireExactKeys(
    score,
    ['id', 'title', 'timeSignature', 'bpm', 'tuning', 'capo', 'measures'],
    path,
  )

  const id = requireNonEmptyString(score.id, `${path}.id`)
  const title = requireString(score.title, `${path}.title`)
  const timeSignature = requireEnum(
    score.timeSignature,
    SUPPORTED_TIME_SIGNATURES,
    `${path}.timeSignature`,
  )
  const bpm = requireInteger(score.bpm, 30, 240, `${path}.bpm`)
  const capo = requireInteger(score.capo, 0, 12, `${path}.capo`)
  const tuning = requireArray(score.tuning, `${path}.tuning`)
  if (tuning.length !== 6) {
    fail(`${path}.tuning must contain exactly six pitches`)
  }
  const validatedTuning = tuning.map((pitch, index) => {
    const value = requireNonEmptyString(pitch, `${path}.tuning[${index}]`)
    try {
      pitchNameToMidi(value)
    } catch {
      fail(`${path}.tuning[${index}] is not a valid MIDI pitch`)
    }
    return value
  })

  const measures = requireArray(score.measures, `${path}.measures`)
  if (measures.length === 0) {
    fail(`${path}.measures must contain at least one measure`)
  }

  const ids = new Set<EntityId>()
  registerId(ids, id, `${path}.id`)
  const validatedMeasures = measures.map((measure, index) =>
    validateMeasure(measure, `${path}.measures[${index}]`, ids),
  )

  return {
    id,
    title,
    timeSignature,
    bpm,
    tuning: validatedTuning,
    capo,
    measures: validatedMeasures,
  }
}

function validateMeasure(input: unknown, path: string, ids: Set<EntityId>): Measure {
  const measure = requireObject(input, path)
  requireExactKeys(measure, ['id', 'positions'], path)
  const id = requireNonEmptyString(measure.id, `${path}.id`)
  registerId(ids, id, `${path}.id`)
  const positions = requireArray(measure.positions, `${path}.positions`).map(
    (position, index) => validatePosition(position, `${path}.positions[${index}]`, ids),
  )
  return { id, positions }
}

function validatePosition(
  input: unknown,
  path: string,
  ids: Set<EntityId>,
): TimePosition {
  const position = requireObject(input, path)
  requireExactKeys(position, ['id', 'duration', 'notes'], path)
  const id = requireNonEmptyString(position.id, `${path}.id`)
  registerId(ids, id, `${path}.id`)
  const duration = requireEnum(position.duration, Object.keys(NOTE_DURATIONS), `${path}.duration`) as NoteDuration
  const notes = requireArray(position.notes, `${path}.notes`).map((note, index) =>
    validateNote(note, `${path}.notes[${index}]`, ids),
  )
  assertUniqueStrings(notes, path)
  return { id, duration, notes }
}

function validateNote(input: unknown, path: string, ids: Set<EntityId>): StringNote {
  const note = requireObject(input, path)
  requireExactKeys(note, ['id', 'stringNumber', 'fret'], path)
  const id = requireNonEmptyString(note.id, `${path}.id`)
  registerId(ids, id, `${path}.id`)
  return {
    id,
    stringNumber: requireInteger(note.stringNumber, 1, 6, `${path}.stringNumber`) as StringNumber,
    fret: requireInteger(note.fret, 0, 24, `${path}.fret`),
  }
}

function assertUniqueStrings(notes: readonly StringNote[], path: string): void {
  const strings = new Set<StringNumber>()
  for (const note of notes) {
    if (strings.has(note.stringNumber)) {
      throw new ScoreValidationError(
        `${path} contains duplicate string number ${note.stringNumber}`,
      )
    }
    strings.add(note.stringNumber)
  }
}

function registerId(ids: Set<EntityId>, id: EntityId, path: string): void {
  if (ids.has(id)) {
    fail(`${path} contains duplicate ID: ${id}`)
  }
  ids.add(id)
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`)
  }
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(`${path} must be a string`)
  }
  return value
}

function requireNonEmptyString(value: unknown, path: string): string {
  const result = requireString(value, path)
  if (result.length === 0) {
    fail(`${path} must not be empty`)
  }
  return result
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): number {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    fail(`${path} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function requireEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail(`${path} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
): void {
  const expected = new Set(expectedKeys)
  const actualKeys = Object.keys(value)
  const unknownKey = actualKeys.find((key) => !expected.has(key))
  if (unknownKey) {
    fail(`${path} contains unknown field: ${unknownKey}`)
  }

  const missingKey = expectedKeys.find((key) => !Object.hasOwn(value, key))
  if (missingKey) {
    fail(`${path} is missing field: ${missingKey}`)
  }
}

function fail(message: string): never {
  throw new ScoreValidationError(message)
}
