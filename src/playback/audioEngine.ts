import {
  createPlaybackSchedule,
  type PlaybackTimeline,
} from './timeline'

interface ActiveVoice {
  oscillator: OscillatorNode
  gain: GainNode
}

type AudioContextFactory = () => AudioContext

const STRING_GAIN = 0.3
const SCHEDULE_AHEAD_SECONDS = 0.04

export class GuitarAudioEngine {
  private context: AudioContext | null = null
  private stringBuses: GainNode[] = []
  private activeVoices = new Set<ActiveVoice>()

  constructor(
    private readonly createContext: AudioContextFactory = () => new AudioContext(),
  ) {}

  async initializeFromUserGesture(): Promise<void> {
    if (!this.context) {
      this.context = this.createContext()
      this.createOutputBus(this.context)
    }
    if (this.context.state === 'suspended') {
      await this.context.resume()
    }
  }

  schedule(timeline: PlaybackTimeline): void {
    const context = this.requireContext()
    const schedule = createPlaybackSchedule(
      timeline,
      context.currentTime + SCHEDULE_AHEAD_SECONDS,
    )
    schedule.voices.forEach((voice) => {
      this.createPluckedVoice(
        voice.stringNumber,
        voice.frequency,
        voice.startTime,
        voice.durationSeconds,
      )
    })
  }

  stopAll(): void {
    const context = this.context
    if (!context) return
    const now = context.currentTime
    this.activeVoices.forEach((voice) => {
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setTargetAtTime(0.0001, now, 0.015)
      try {
        voice.oscillator.stop(now + 0.08)
      } catch {
        // The oscillator may already have reached its scheduled stop time.
      }
    })
  }

  async close(): Promise<void> {
    this.stopAll()
    const context = this.context
    this.context = null
    this.stringBuses = []
    if (context && context.state !== 'closed') {
      await context.close()
    }
  }

  private createOutputBus(context: AudioContext): void {
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -12
    compressor.knee.value = 8
    compressor.ratio.value = 14
    compressor.attack.value = 0.003
    compressor.release.value = 0.16

    const master = context.createGain()
    master.gain.value = 0.86
    compressor.connect(master)
    master.connect(context.destination)

    this.stringBuses = Array.from({ length: 6 }, () => {
      const gain = context.createGain()
      gain.gain.value = STRING_GAIN
      gain.connect(compressor)
      return gain
    })
  }

  private createPluckedVoice(
    stringNumber: number,
    frequency: number,
    startTime: number,
    durationSeconds: number,
  ): void {
    const context = this.requireContext()
    const oscillator = context.createOscillator()
    const filter = context.createBiquadFilter()
    const gain = context.createGain()
    const releaseEnd = startTime + Math.max(0.22, Math.min(durationSeconds * 1.4, 2.2))

    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(frequency, startTime)

    filter.type = 'lowpass'
    filter.Q.value = 1.1
    filter.frequency.setValueAtTime(
      Math.min(context.sampleRate * 0.45, Math.max(1800, frequency * 10)),
      startTime,
    )
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(500, frequency * 2.4),
      releaseEnd,
    )

    gain.gain.setValueAtTime(0.0001, startTime)
    gain.gain.exponentialRampToValueAtTime(0.9, startTime + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.28, startTime + 0.055)
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseEnd)

    oscillator.connect(filter)
    filter.connect(gain)
    gain.connect(this.stringBuses[stringNumber - 1])

    const voice = { oscillator, gain }
    this.activeVoices.add(voice)
    oscillator.onended = () => {
      oscillator.disconnect()
      filter.disconnect()
      gain.disconnect()
      this.activeVoices.delete(voice)
    }
    oscillator.start(startTime)
    oscillator.stop(releaseEnd + 0.03)
  }

  private requireContext(): AudioContext {
    if (!this.context) {
      throw new Error('Audio engine must be initialized from a user gesture')
    }
    return this.context
  }
}
