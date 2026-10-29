import { describe, expect, it } from 'vitest'
import {
  createMeasure,
  createStringNote,
  createTimePosition,
  type Score,
} from '../domain/guitarTab'
import {
  buildPlaybackTimeline,
  createPlaybackSchedule,
  durationToSeconds,
} from './timeline'

function scoreFixture(): Score {
  return {
    id: 'score',
    title: 'Timeline',
    timeSignature: '4/4',
    bpm: 120,
    tuning: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2'],
    capo: 2,
    measures: [
      createMeasure([
        createTimePosition('quarter', [
          createStringNote(1, 0, () => 'note-1'),
          createStringNote(2, 3, () => 'note-2'),
        ], () => 'position-1'),
        createTimePosition('eighth', [], () => 'rest'),
        createTimePosition('half', [
          createStringNote(6, 12, () => 'note-3'),
        ], () => 'position-3'),
      ], () => 'measure'),
    ],
  }
}

describe('playback timeline', () => {
  it('converts note values from quarter-note BPM', () => {
    expect(durationToSeconds('quarter', 120)).toBe(0.5)
    expect(durationToSeconds('sixteenth', 120)).toBe(0.125)
    expect(durationToSeconds('whole', 60)).toBe(4)
  })

  it('keeps rests in time while scheduling no rest voices', () => {
    const timeline = buildPlaybackTimeline(scoreFixture())
    const schedule = createPlaybackSchedule(timeline, 10)

    expect(timeline.positions.map(({ positionId }) => positionId)).toEqual([
      'position-1',
      'rest',
      'position-3',
    ])
    expect(timeline.positions[2].offsetSeconds).toBe(0.75)
    expect(schedule.voices).toHaveLength(3)
    expect(schedule.voices.some(({ positionId }) => positionId === 'rest')).toBe(false)
  })

  it('starts from a middle position and preserves simultaneous chord timing', () => {
    const score = scoreFixture()
    const fullTimeline = buildPlaybackTimeline(score)
    const chordSchedule = createPlaybackSchedule(fullTimeline, 2)
    const middleTimeline = buildPlaybackTimeline(score, 'rest')

    expect(chordSchedule.voices[0].startTime).toBe(2)
    expect(chordSchedule.voices[1].startTime).toBe(2)
    expect(middleTimeline.positions[0].positionId).toBe('rest')
    expect(middleTimeline.positions[0].offsetSeconds).toBe(0)
    expect(middleTimeline.durationSeconds).toBe(1.25)
  })

  it('applies tuning, fret and capo to scheduled frequency', () => {
    const score = scoreFixture()
    const capoTimeline = buildPlaybackTimeline(score, 'position-3')
    const noCapoTimeline = buildPlaybackTimeline(
      { ...score, capo: 0 },
      'position-3',
    )
    const expectedFSharp3 = 440 * 2 ** ((54 - 69) / 12)
    const expectedE3 = 440 * 2 ** ((52 - 69) / 12)

    expect(capoTimeline.positions[0].notes[0].frequency).toBeCloseTo(expectedFSharp3)
    expect(noCapoTimeline.positions[0].notes[0].frequency).toBeCloseTo(expectedE3)
  })
})
