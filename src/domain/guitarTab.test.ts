import { describe, expect, it } from 'vitest'
import {
  NOTE_DURATIONS,
  SCORE_FORMAT_VERSION,
  STANDARD_TUNING,
  createDefaultScore,
  createMeasure,
  createRestPosition,
  createStringNote,
  createTimePosition,
  deleteMeasure,
  getMeasureCapacityStatus,
  getMeasureDuration,
  getTimeSignatureCapacity,
  insertMeasureAfter,
  isRestPosition,
  parseScoreJson,
  pitchNameToMidi,
  serializeScore,
  setStringNote,
  stringNoteToFrequency,
  stringNoteToMidi,
  type IdFactory,
  type Score,
  type ScoreDocument,
} from './guitarTab'

function sequentialIds(): IdFactory {
  let nextId = 0
  return () => `id-${++nextId}`
}

function validDocument(): ScoreDocument {
  const ids = sequentialIds()
  const score = createDefaultScore(ids)
  const note = createStringNote(1, 0, ids)
  const position = createTimePosition('quarter', [note], ids)
  return {
    version: SCORE_FORMAT_VERSION,
    score: {
      ...score,
      measures: [{ ...score.measures[0], positions: [position] }],
    },
  }
}

describe('score creation and rhythm', () => {
  it('creates a score with stable IDs, one blank measure, and standard tuning', () => {
    const score = createDefaultScore(sequentialIds())

    expect(score.id).toBe('id-1')
    expect(score.measures).toEqual([{ id: 'id-2', positions: [] }])
    expect(score.tuning).toEqual(['E4', 'B3', 'G3', 'D3', 'A2', 'E2'])
    expect(score.tuning).not.toBe(STANDARD_TUNING)
  })

  it('represents all supported durations in integer sixteenth-note units', () => {
    expect(NOTE_DURATIONS).toEqual({
      whole: 16,
      half: 8,
      quarter: 4,
      eighth: 2,
      sixteenth: 1,
    })
  })

  it.each([
    ['2/4', 8],
    ['3/4', 12],
    ['4/4', 16],
    ['6/8', 12],
  ] as const)('computes %s capacity as %i sixteenth-note units', (signature, expected) => {
    expect(getTimeSignatureCapacity(signature)).toBe(expected)
  })

  it('reports underfilled, exact, and overfilled measures without rejecting them', () => {
    const ids = sequentialIds()
    const underfilled = createMeasure([createRestPosition('quarter', ids)], ids)
    const exact = createMeasure(
      Array.from({ length: 4 }, () => createRestPosition('quarter', ids)),
      ids,
    )
    const overfilled = createMeasure(
      [createRestPosition('whole', ids), createRestPosition('sixteenth', ids)],
      ids,
    )

    expect(getMeasureDuration(exact)).toBe(16)
    expect(getMeasureCapacityStatus(underfilled, '4/4')).toBe('underfilled')
    expect(getMeasureCapacityStatus(exact, '4/4')).toBe('exact')
    expect(getMeasureCapacityStatus(overfilled, '4/4')).toBe('overfilled')
  })
})

describe('notes, rests, and immutable measure operations', () => {
  it('accepts frets 0 and 24 and rejects values outside that range', () => {
    const ids = sequentialIds()

    expect(createStringNote(1, 0, ids).fret).toBe(0)
    expect(createStringNote(6, 24, ids).fret).toBe(24)
    expect(() => createStringNote(1, -1, ids)).toThrow(/0 to 24/)
    expect(() => createStringNote(1, 25, ids)).toThrow(/0 to 24/)
  })

  it('replaces an existing note on the same string instead of duplicating it', () => {
    const ids = sequentialIds()
    const original = createTimePosition(
      'eighth',
      [createStringNote(2, 3, ids), createStringNote(1, 1, ids)],
      ids,
    )
    const replacement = createStringNote(1, 12, ids)
    const updated = setStringNote(original, replacement)

    expect(updated.notes).toEqual([
      replacement,
      expect.objectContaining({ stringNumber: 2, fret: 3 }),
    ])
    expect(original.notes[1].fret).toBe(1)
  })

  it('rejects duplicate strings when constructing a time position', () => {
    const ids = sequentialIds()
    const notes = [
      createStringNote(3, 2, ids),
      createStringNote(3, 7, ids),
    ]

    expect(() => createTimePosition('quarter', notes, ids)).toThrow(
      /duplicate string number 3/,
    )
  })

  it('uses an empty note list for a rest while preserving duration', () => {
    const rest = createRestPosition('half', sequentialIds())

    expect(isRestPosition(rest)).toBe(true)
    expect(rest.duration).toBe('half')
    expect(getMeasureDuration(createMeasure([rest], sequentialIds()))).toBe(8)
  })

  it('inserts a new measure after the selected measure without mutating the score', () => {
    const ids = sequentialIds()
    const score = createDefaultScore(ids)
    const updated = insertMeasureAfter(score, score.measures[0].id, ids)

    expect(updated.measures.map(({ id }) => id)).toEqual(['id-2', 'id-3'])
    expect(score.measures).toHaveLength(1)
  })

  it('deletes a non-final measure and clears the final measure in place', () => {
    const ids = sequentialIds()
    const first = createMeasure([createRestPosition('quarter', ids)], ids)
    const second = createMeasure([], ids)
    const score: Score = {
      ...createDefaultScore(ids),
      measures: [first, second],
    }

    const deleted = deleteMeasure(score, second.id)
    const cleared = deleteMeasure(deleted, first.id)

    expect(deleted.measures).toEqual([first])
    expect(cleared.measures).toEqual([{ ...first, positions: [] }])
    expect(score.measures).toEqual([first, second])
  })
})

describe('pitch mapping', () => {
  it('maps standard open strings to their MIDI notes', () => {
    expect(STANDARD_TUNING.map(pitchNameToMidi)).toEqual([64, 59, 55, 50, 45, 40])
  })

  it('adds fret and capo semitones to the open-string pitch', () => {
    expect(stringNoteToMidi(STANDARD_TUNING, 6, 12, 0)).toBe(52)
    expect(stringNoteToMidi(STANDARD_TUNING, 6, 12, 2)).toBe(54)
  })

  it('converts MIDI pitch to frequency', () => {
    expect(stringNoteToFrequency(STANDARD_TUNING, 1, 5, 0)).toBeCloseTo(440, 8)
  })
})

describe('versioned score JSON', () => {
  it('round-trips a valid score with its format version', () => {
    const document = validDocument()
    const json = serializeScore(document.score)

    expect(JSON.parse(json)).toEqual(document)
    expect(parseScoreJson(json)).toEqual(document.score)
  })

  it('rejects malformed JSON, null, missing fields, and unknown fields', () => {
    expect(() => parseScoreJson('{')).toThrow(/Invalid JSON/)
    expect(() => parseScoreJson('null')).toThrow(/must be an object/)
    expect(() => parseScoreJson(JSON.stringify({ version: 1 }))).toThrow(/missing field/)
    expect(() =>
      parseScoreJson(JSON.stringify({ ...validDocument(), extra: true })),
    ).toThrow(/unknown field/)
  })

  it('rejects an unknown format version', () => {
    expect(() =>
      parseScoreJson(JSON.stringify({ ...validDocument(), version: 2 })),
    ).toThrow(/Unsupported score version/)
  })

  it.each([-1, 25, null])('rejects invalid fret %s', (fret) => {
    const document = validDocument()
    document.score.measures[0].positions[0].notes[0].fret = fret as number

    expect(() => parseScoreJson(JSON.stringify(document))).toThrow(/fret/)
  })

  it('rejects duplicate string numbers in one time position', () => {
    const document = validDocument()
    document.score.measures[0].positions[0].notes.push({
      id: 'another-note',
      stringNumber: 1,
      fret: 12,
    })

    expect(() => parseScoreJson(JSON.stringify(document))).toThrow(
      /duplicate string number 1/,
    )
  })

  it('rejects duplicate stable IDs anywhere in the score', () => {
    const document = validDocument()
    document.score.measures[0].positions[0].notes[0].id =
      document.score.measures[0].positions[0].id

    expect(() => parseScoreJson(JSON.stringify(document))).toThrow(/duplicate ID/)
  })

  it.each([
    ['bpm', 29],
    ['bpm', 241],
    ['capo', -1],
    ['capo', 13],
  ] as const)('rejects out-of-range %s value %i', (field, value) => {
    const document = validDocument()
    document.score[field] = value

    expect(() => parseScoreJson(JSON.stringify(document))).toThrow(
      new RegExp(field),
    )
  })
})
