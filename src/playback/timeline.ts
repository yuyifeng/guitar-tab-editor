import {
  NOTE_DURATIONS,
  stringNoteToFrequency,
  type EntityId,
  type Score,
  type StringNumber,
} from '../domain/guitarTab'

export interface TimelineNote {
  stringNumber: StringNumber
  frequency: number
}

export interface TimelinePosition {
  measureId: EntityId
  positionId: EntityId
  offsetSeconds: number
  durationSeconds: number
  notes: TimelineNote[]
}

export interface PlaybackTimeline {
  positions: TimelinePosition[]
  durationSeconds: number
}

export interface ScheduledVoice extends TimelineNote {
  startTime: number
  durationSeconds: number
  positionId: EntityId
}

export interface PlaybackSchedule {
  positions: Array<TimelinePosition & { startTime: number }>
  voices: ScheduledVoice[]
  endTime: number
}

export function durationToSeconds(
  duration: keyof typeof NOTE_DURATIONS,
  bpm: number,
): number {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError('BPM must be greater than zero')
  }
  return (NOTE_DURATIONS[duration] / NOTE_DURATIONS.quarter) * (60 / bpm)
}

export function buildPlaybackTimeline(
  score: Score,
  startPositionId?: EntityId | null,
): PlaybackTimeline {
  const positions = score.measures.flatMap((measure) =>
    measure.positions.map((position) => ({ measure, position })),
  )
  const requestedIndex = startPositionId
    ? positions.findIndex(({ position }) => position.id === startPositionId)
    : 0
  const startIndex = requestedIndex >= 0 ? requestedIndex : 0
  let offsetSeconds = 0

  const timelinePositions = positions.slice(startIndex).map(({ measure, position }) => {
    const durationSeconds = durationToSeconds(position.duration, score.bpm)
    const entry: TimelinePosition = {
      measureId: measure.id,
      positionId: position.id,
      offsetSeconds,
      durationSeconds,
      notes: position.notes.map((note) => ({
        stringNumber: note.stringNumber,
        frequency: stringNoteToFrequency(
          score.tuning,
          note.stringNumber,
          note.fret,
          score.capo,
        ),
      })),
    }
    offsetSeconds += durationSeconds
    return entry
  })

  return { positions: timelinePositions, durationSeconds: offsetSeconds }
}

export function createPlaybackSchedule(
  timeline: PlaybackTimeline,
  audioStartTime: number,
): PlaybackSchedule {
  const positions = timeline.positions.map((position) => ({
    ...position,
    startTime: audioStartTime + position.offsetSeconds,
  }))
  const voices = positions.flatMap((position) =>
    position.notes.map((note) => ({
      ...note,
      startTime: position.startTime,
      durationSeconds: position.durationSeconds,
      positionId: position.positionId,
    })),
  )

  return {
    positions,
    voices,
    endTime: audioStartTime + timeline.durationSeconds,
  }
}
