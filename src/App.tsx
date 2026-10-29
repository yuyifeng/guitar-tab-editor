import {
  ChevronDown,
  CirclePlus,
  Clipboard,
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  Guitar,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  STANDARD_TUNING,
  SUPPORTED_TIME_SIGNATURES,
  createDefaultScore,
  createRestPosition,
  deleteMeasure,
  getMeasureCapacityStatus,
  getMeasureDuration,
  getTimeSignatureCapacity,
  insertMeasureAfter,
  type EntityId,
  type Measure,
  type NoteDuration,
  type Score,
  type StringNumber,
  type TimePosition,
} from './domain/guitarTab'
import {
  createEditorState,
  editorReducer,
  getSelectedPositionRefs,
  type EditorAction,
  type EditorSelection,
  type PositionRef,
} from './editor/editorState'
import { GuitarAudioEngine } from './playback/audioEngine'
import { buildPlaybackTimeline } from './playback/timeline'
import {
  downloadScoreJson,
  prepareNewScore,
  prepareScoreImport,
  resolveScoreReplacement,
} from './persistence/fileWorkflow'
import {
  createScoreAutoSave,
  restoreScoreDraft,
  type SaveState,
} from './persistence/persistence'

export type PlaybackCommand = 'play-from-cursor' | 'play-from-start' | 'pause' | 'stop'

export interface EditorIntegrations {
  onNewScore?: (applyScore: (score: Score) => void) => void
  onImportScore?: (applyScore: (score: Score) => void) => void
  onExportScore?: (score: Score) => void
  onScoreChange?: (score: Score) => void
  onPlaybackCommand?: (command: PlaybackCommand, score: Score) => void
}

export interface AppProps {
  initialScore?: Score
  integrations?: EditorIntegrations
}

type IconButtonProps = {
  label: string
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
}

type AppFeedback = {
  message: string
  isError: boolean
}

const DURATION_OPTIONS: Array<{
  value: NoteDuration
  label: string
  shortLabel: string
}> = [
  { value: 'whole', label: '全音符', shortLabel: '1' },
  { value: 'half', label: '二分音符', shortLabel: '1/2' },
  { value: 'quarter', label: '四分音符', shortLabel: '1/4' },
  { value: 'eighth', label: '八分音符', shortLabel: '1/8' },
  { value: 'sixteenth', label: '十六分音符', shortLabel: '1/16' },
]

const PITCH_OPTIONS = Array.from({ length: 9 * 12 }, (_, index) => {
  const midi = index + 12
  const pitchClasses = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const pitchClass = pitchClasses[midi % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${pitchClass}${octave}`
})

function IconButton({
  label,
  children,
  disabled = false,
  onClick,
}: IconButtonProps) {
  return (
    <button
      className="icon-button"
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function ToolbarDivider() {
  return <span className="toolbar-divider" aria-hidden="true" />
}

function durationLabel(duration: NoteDuration): string {
  return DURATION_OPTIONS.find(({ value }) => value === duration)?.label ?? duration
}

function selectionIncludes(
  selection: EditorSelection,
  selectedPositionIds: Set<EntityId>,
  positionId: EntityId,
): boolean {
  return selection.type !== 'none' && selectedPositionIds.has(positionId)
}

function replaceSelectedPositions(
  score: Score,
  refs: PositionRef[],
  update: (position: TimePosition) => TimePosition,
): Score {
  const selectedIds = new Set(refs.map(({ positionId }) => positionId))
  if (selectedIds.size === 0) return score
  let scoreChanged = false
  const measures = score.measures.map((measure) => {
    let measureChanged = false
    const positions = measure.positions.map((position) => {
      if (!selectedIds.has(position.id)) return position
      const nextPosition = update(position)
      if (nextPosition !== position) measureChanged = true
      return nextPosition
    })
    if (!measureChanged) return measure
    scoreChanged = true
    return { ...measure, positions }
  })
  return scoreChanged ? { ...score, measures } : score
}

function currentPositionRef(
  measureId: EntityId,
  positionId: EntityId | null,
): PositionRef[] {
  return positionId ? [{ measureId, positionId }] : []
}

function RhythmMark({ duration }: { duration: NoteDuration }) {
  const flags = duration === 'sixteenth' ? 2 : duration === 'eighth' ? 1 : 0
  return (
    <span className={`rhythm-mark rhythm-${duration}`} aria-hidden="true">
      <span className="rhythm-head" />
      {duration !== 'whole' && <span className="rhythm-stem" />}
      {Array.from({ length: flags }, (_, index) => (
        <span className={`rhythm-flag rhythm-flag-${index + 1}`} key={index} />
      ))}
    </span>
  )
}

interface TabPositionProps {
  measureId: EntityId
  position: TimePosition
  selection: EditorSelection
  selectedPositionIds: Set<EntityId>
  cursorPositionId: EntityId | null
  cursorString: StringNumber
  playingPositionId: EntityId | null
  fretInput: string | null
  onSelectNote: (target: PositionRef, stringNumber: StringNumber, shiftKey: boolean) => void
  onSelectPosition: (target: PositionRef, shiftKey: boolean) => void
}

function TabPosition({
  measureId,
  position,
  selection,
  selectedPositionIds,
  cursorPositionId,
  cursorString,
  playingPositionId,
  fretInput,
  onSelectNote,
  onSelectPosition,
}: TabPositionProps) {
  const ref = { measureId, positionId: position.id }
  const selected = selectionIncludes(selection, selectedPositionIds, position.id)
  const isPlaying = playingPositionId === position.id
  const isCursor = cursorPositionId === position.id
  const isRest = position.notes.length === 0

  return (
    <div
      className={[
        'tab-position',
        selected ? 'is-selected' : '',
        isPlaying ? 'is-playing' : '',
        isRest ? 'is-rest' : '',
      ].filter(Boolean).join(' ')}
      data-position-id={position.id}
      role="group"
      aria-label={`${durationLabel(position.duration)}${isRest ? '休止' : `，${position.notes.length} 个弦音`}`}
    >
      <button
        className="position-selector"
        type="button"
        onClick={(event) => onSelectPosition(ref, event.shiftKey)}
        aria-label={`选择整个${durationLabel(position.duration)}时间位置`}
        aria-pressed={selected && selection.type !== 'note'}
      >
        <RhythmMark duration={position.duration} />
      </button>

      <div className="position-strings">
        {Array.from({ length: 6 }, (_, index) => {
          const stringNumber = (index + 1) as StringNumber
          const note = position.notes.find((entry) => entry.stringNumber === stringNumber)
          const noteSelected = selection.type === 'note'
            && selection.positionId === position.id
            && selection.stringNumber === stringNumber
          const cellCursor = isCursor && cursorString === stringNumber
          return (
            <button
              className={[
                'string-cell',
                noteSelected ? 'is-note-selected' : '',
                cellCursor ? 'is-cursor' : '',
              ].filter(Boolean).join(' ')}
              type="button"
              key={stringNumber}
              onClick={(event) => onSelectNote(ref, stringNumber, event.shiftKey)}
              aria-label={`第 ${stringNumber} 弦，${note ? `${note.fret} 品` : '空位置'}，${durationLabel(position.duration)}`}
              aria-pressed={noteSelected}
            >
              {note && <span className="fret-number">{note.fret}</span>}
              {cellCursor && fretInput && (
                <span className="fret-buffer" aria-label={`正在输入 ${fretInput}`}>
                  {fretInput}_
                </span>
              )}
            </button>
          )
        })}
      </div>

      {isRest && (
        <span className="rest-glyph" aria-hidden="true">
          𝄽
        </span>
      )}
    </div>
  )
}

interface MeasureViewProps {
  measure: Measure
  index: number
  score: Score
  selection: EditorSelection
  selectedPositionIds: Set<EntityId>
  cursorMeasureId: EntityId
  cursorPositionId: EntityId | null
  cursorString: StringNumber
  playingPositionId: EntityId | null
  fretInput: string | null
  activeDuration: NoteDuration
  dispatch: (action: EditorAction) => void
  onSelectNote: TabPositionProps['onSelectNote']
  onSelectPosition: TabPositionProps['onSelectPosition']
  onAddFirstPosition: (measureId: EntityId) => void
}

function MeasureView({
  measure,
  index,
  score,
  selection,
  selectedPositionIds,
  cursorMeasureId,
  cursorPositionId,
  cursorString,
  playingPositionId,
  fretInput,
  activeDuration,
  dispatch,
  onSelectNote,
  onSelectPosition,
  onAddFirstPosition,
}: MeasureViewProps) {
  const capacity = getTimeSignatureCapacity(score.timeSignature)
  const used = getMeasureDuration(measure)
  const status = getMeasureCapacityStatus(measure, score.timeSignature)
  const selected = cursorMeasureId === measure.id
  const statusText = status === 'exact'
    ? '拍数正确'
    : status === 'underfilled'
      ? `少 ${capacity - used} 个十六分单位`
      : `多 ${used - capacity} 个十六分单位`

  return (
    <article
      className={`measure measure-${status}${selected ? ' is-current-measure' : ''}`}
      style={{ minWidth: Math.max(300, 46 + measure.positions.length * 38) }}
      aria-label={`第 ${index + 1} 小节，${statusText}`}
      onClick={() => {
        if (measure.positions.length === 0) {
          dispatch({
            type: 'set-cursor',
            cursor: { measureId: measure.id, positionId: null, stringNumber: cursorString },
          })
        }
      }}
    >
      <header className="measure-header">
        <span className="measure-number">{index + 1}</span>
        <span className={`measure-status status-${status}`} title={statusText}>
          {status === 'exact' ? '✓' : status === 'underfilled' ? '拍数不足' : '拍数超出'}
        </span>
      </header>

      <div className="measure-body">
        <div className="measure-tuning" aria-label="弦号与调弦">
          {score.tuning.map((pitch, stringIndex) => (
            <span key={`${measure.id}-${stringIndex}`}>
              <small>{stringIndex + 1}</small>
              {pitch}
            </span>
          ))}
        </div>

        <div className="measure-staff">
          {measure.positions.length === 0 ? (
            <button
              className="empty-position"
              type="button"
              onClick={() => onAddFirstPosition(measure.id)}
              aria-label={`在第 ${index + 1} 小节添加${durationLabel(activeDuration)}休止位置`}
            >
              <CirclePlus size={16} />
              <span>添加时间位置</span>
            </button>
          ) : (
            measure.positions.map((position) => (
              <TabPosition
                key={position.id}
                measureId={measure.id}
                position={position}
                selection={selection}
                selectedPositionIds={selectedPositionIds}
                cursorPositionId={cursorPositionId}
                cursorString={cursorString}
                playingPositionId={playingPositionId}
                fretInput={fretInput}
                onSelectNote={onSelectNote}
                onSelectPosition={onSelectPosition}
              />
            ))
          )}
        </div>
      </div>
    </article>
  )
}

function App({ initialScore, integrations = {} }: AppProps) {
  const [draftRecovery] = useState(() =>
    initialScore ? { status: 'empty', writeProtected: false } as const : restoreScoreDraft(),
  )
  const recoveredScore = initialScore
    ?? (draftRecovery.status === 'restored' ? draftRecovery.score : createDefaultScore())
  const [editor, dispatch] = useReducer(
    editorReducer,
    recoveredScore,
    createEditorState,
  )
  const [activeDuration, setActiveDuration] = useState<NoteDuration>('quarter')
  const [fretDraft, setFretDraft] = useState('')
  const [feedback, setFeedback] = useState<AppFeedback | null>(
    draftRecovery.status === 'corrupt' || draftRecovery.status === 'error'
      ? { message: draftRecovery.error.message, isError: true }
      : null,
  )
  const [saveState, setSaveState] = useState<SaveState>(() => {
    if (draftRecovery.status === 'corrupt' || draftRecovery.status === 'error') {
      return {
        status: 'error',
        hasUnsavedChanges: true,
        error: draftRecovery.error,
        lastSavedAt: null,
      }
    }
    return {
      status: 'saved',
      hasUnsavedChanges: false,
      error: null,
      lastSavedAt: null,
    }
  })
  const scoreViewportRef = useRef<HTMLElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const autoSaveBaselineRef = useRef(editor.score)
  const playbackTimersRef = useRef<number[]>([])
  const playbackGenerationRef = useRef(0)
  const [autoSave] = useState(() =>
    createScoreAutoSave({
      writeProtected: draftRecovery.writeProtected,
      onStateChange: setSaveState,
    }),
  )
  const [audioEngine] = useState(() => new GuitarAudioEngine())

  const selectedRefs = useMemo(
    () => getSelectedPositionRefs(editor.score, editor.selection),
    [editor.score, editor.selection],
  )
  const selectedPositionIds = useMemo(
    () => new Set(selectedRefs.map(({ positionId }) => positionId)),
    [selectedRefs],
  )
  const currentMeasureIndex = Math.max(
    0,
    editor.score.measures.findIndex(({ id }) => id === editor.cursor.measureId),
  )
  const playingPositionId = editor.playback.status === 'playing'
    ? editor.playback.positionId
    : null
  const saveStatusText = saveState.status === 'saving'
    ? '保存中'
    : saveState.status === 'error'
      ? '保存失败'
      : '已保存'

  useEffect(() => {
    const fretInput = editor.fretInput
    if (!fretInput) return
    const timer = window.setTimeout(() => {
      dispatch({
        type: 'write-fret',
        fret: Number(fretInput.digits),
        duration: activeDuration,
      })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [activeDuration, editor.fretInput])

  const onScoreChange = integrations.onScoreChange
  useEffect(() => {
    onScoreChange?.(editor.score)
    if (editor.score === autoSaveBaselineRef.current) return
    autoSave.schedule(editor.score)
  }, [autoSave, editor.score, onScoreChange])

  useEffect(() => {
    const viewport = scoreViewportRef.current
    if (!viewport || !playingPositionId) return
    const positionElement = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-position-id]'),
    ).find((element) => element.dataset.positionId === playingPositionId)
    positionElement?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    })
  }, [playingPositionId])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) return
      playbackGenerationRef.current += 1
      playbackTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      playbackTimersRef.current = []
      audioEngine.stopAll()
      dispatch({
        type: 'set-playback',
        playback: { status: 'stopped', positionId: null },
      })
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      playbackTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      playbackTimersRef.current = []
      audioEngine.close().catch(() => undefined)
      autoSave.flush()
    }
  }, [audioEngine, autoSave])

  function replaceScore(score: Score) {
    dispatch({ type: 'replace-score', score })
  }

  function applyScoreReplacement(score: Score, message: string) {
    stopPlayback('stopped')
    autoSave.allowProtectedDraftReplacement()
    autoSaveBaselineRef.current = score
    dispatch({ type: 'reset-score', score })
    autoSave.schedule(score)
    autoSave.flush()
    setFeedback({ message, isError: false })
  }

  function handleNewScore() {
    const plan = prepareNewScore(saveState)
    const confirmed = !plan.requiresConfirmation || window.confirm(
      '当前乐谱尚未成功保存。确认新建并替换当前内容吗？',
    )
    const result = resolveScoreReplacement(plan, confirmed)
    if (result.status === 'replace') {
      applyScoreReplacement(result.score, '已新建乐谱并保存本地草稿。')
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const plan = await prepareScoreImport(file)
      const confirmed = window.confirm(
        `确认导入“${file.name}”并替换当前乐谱吗？`,
      )
      const result = resolveScoreReplacement(plan, confirmed)
      if (result.status === 'replace') {
        applyScoreReplacement(result.score, `已导入“${file.name}”并保存本地草稿。`)
      }
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : '导入乐谱失败。',
        isError: true,
      })
    }
  }

  function handleExportScore() {
    try {
      downloadScoreJson(editor.score)
      integrations.onExportScore?.(editor.score)
      setFeedback({ message: 'JSON 乐谱已导出。', isError: false })
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : '导出乐谱失败。',
        isError: true,
      })
    }
  }

  function updateScoreField<K extends keyof Score>(field: K, value: Score[K]) {
    replaceScore({ ...editor.score, [field]: value })
  }

  function targetRefs(): PositionRef[] {
    return selectedRefs.length > 0
      ? selectedRefs
      : currentPositionRef(editor.cursor.measureId, editor.cursor.positionId)
  }

  function setDuration(duration: NoteDuration) {
    setActiveDuration(duration)
    const refs = targetRefs()
    if (refs.length === 0) return
    replaceScore(replaceSelectedPositions(editor.score, refs, (position) =>
      position.duration === duration ? position : { ...position, duration },
    ))
  }

  function insertRest() {
    const measureIndex = editor.score.measures.findIndex(
      ({ id }) => id === editor.cursor.measureId,
    )
    if (measureIndex === -1) return
    const measure = editor.score.measures[measureIndex]
    const cursorIndex = measure.positions.findIndex(
      ({ id }) => id === editor.cursor.positionId,
    )
    const rest = createRestPosition(activeDuration)
    const positions = [...measure.positions]
    positions.splice(cursorIndex === -1 ? positions.length : cursorIndex, 0, rest)
    const measures = [...editor.score.measures]
    measures[measureIndex] = { ...measure, positions }
    replaceScore({ ...editor.score, measures })
    dispatch({
      type: 'select-position',
      target: { measureId: measure.id, positionId: rest.id },
    })
  }

  function convertSelectionToRest() {
    const refs = targetRefs()
    if (refs.length === 0) {
      insertRest()
      return
    }
    replaceScore(replaceSelectedPositions(editor.score, refs, (position) =>
      position.notes.length === 0 ? position : { ...position, notes: [] },
    ))
  }

  function addMeasure() {
    const score = insertMeasureAfter(editor.score, editor.cursor.measureId)
    const index = score.measures.findIndex(({ id }) => id === editor.cursor.measureId)
    const nextMeasure = score.measures[index + 1]
    replaceScore(score)
    dispatch({
      type: 'set-cursor',
      cursor: { measureId: nextMeasure.id, positionId: null, stringNumber: 1 },
    })
  }

  function removeCurrentMeasure() {
    const removedIndex = editor.score.measures.findIndex(
      ({ id }) => id === editor.cursor.measureId,
    )
    if (removedIndex === -1) return
    const score = deleteMeasure(editor.score, editor.cursor.measureId)
    const nextMeasure = score.measures[Math.min(removedIndex, score.measures.length - 1)]
    replaceScore(score)
    dispatch({
      type: 'set-cursor',
      cursor: {
        measureId: nextMeasure.id,
        positionId: nextMeasure.positions[0]?.id ?? null,
        stringNumber: editor.cursor.stringNumber,
      },
    })
  }

  function addFirstPosition(measureId: EntityId) {
    const rest = createRestPosition(activeDuration)
    const measures = editor.score.measures.map((measure) =>
      measure.id === measureId ? { ...measure, positions: [rest] } : measure,
    )
    replaceScore({ ...editor.score, measures })
    dispatch({
      type: 'select-note',
      target: { measureId, positionId: rest.id },
      stringNumber: 1,
    })
  }

  function selectNote(target: PositionRef, stringNumber: StringNumber, shiftKey: boolean) {
    if (shiftKey && editor.cursor.positionId) {
      dispatch({
        type: 'select-range',
        anchor: {
          measureId: editor.cursor.measureId,
          positionId: editor.cursor.positionId,
        },
        focus: target,
      })
      return
    }
    dispatch({ type: 'select-note', target, stringNumber })
  }

  function selectPosition(target: PositionRef, shiftKey: boolean) {
    if (shiftKey && editor.cursor.positionId) {
      dispatch({
        type: 'select-range',
        anchor: {
          measureId: editor.cursor.measureId,
          positionId: editor.cursor.positionId,
        },
        focus: target,
      })
      return
    }
    dispatch({ type: 'select-position', target })
  }

  function submitFret() {
    const fret = Number(fretDraft)
    if (!Number.isInteger(fret) || fret < 0 || fret > 24) return
    dispatch({
      type: 'write-fret',
      fret,
      mode: editor.entryMode,
      duration: activeDuration,
    })
    setFretDraft('')
  }

  function clearPlaybackTimers() {
    playbackTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    playbackTimersRef.current = []
  }

  function stopPlayback(status: 'stopped' | 'paused') {
    playbackGenerationRef.current += 1
    clearPlaybackTimers()
    audioEngine.stopAll()
    dispatch({
      type: 'set-playback',
      playback: {
        status,
        positionId: status === 'paused' ? editor.playback.positionId : null,
      },
    })
  }

  async function playback(command: PlaybackCommand) {
    integrations.onPlaybackCommand?.(command, editor.score)
    if (command === 'pause') {
      stopPlayback('paused')
      return
    }
    if (command === 'stop') {
      stopPlayback('stopped')
      return
    }
    const firstPosition = editor.score.measures.flatMap(({ positions }) => positions)[0]
    const startPositionId = command === 'play-from-start'
      ? (firstPosition?.id ?? null)
      : (
          editor.playback.status === 'paused'
            ? editor.playback.positionId
            : editor.cursor.positionId
        ) ?? firstPosition?.id ?? null
    const timeline = buildPlaybackTimeline(editor.score, startPositionId)
    if (timeline.positions.length === 0) {
      setFeedback({
        message: '当前乐谱没有可播放的时间位置。',
        isError: true,
      })
      stopPlayback('stopped')
      return
    }

    const generation = playbackGenerationRef.current + 1
    playbackGenerationRef.current = generation
    clearPlaybackTimers()
    audioEngine.stopAll()
    try {
      await audioEngine.initializeFromUserGesture()
      if (generation !== playbackGenerationRef.current) return
      audioEngine.schedule(timeline)
      dispatch({
        type: 'set-playback',
        playback: { status: 'playing', positionId: timeline.positions[0].positionId },
      })
      const highlightTimers = timeline.positions.map((position) =>
        window.setTimeout(() => {
          if (generation !== playbackGenerationRef.current) return
          dispatch({
            type: 'set-playback',
            playback: { status: 'playing', positionId: position.positionId },
          })
        }, position.offsetSeconds * 1000),
      )
      const completionTimer = window.setTimeout(() => {
        if (generation !== playbackGenerationRef.current) return
        stopPlayback('stopped')
      }, timeline.durationSeconds * 1000 + 60)
      playbackTimersRef.current = [...highlightTimers, completionTimer]
      setFeedback(null)
    } catch (error) {
      stopPlayback('stopped')
      setFeedback({
        message: error instanceof Error
          ? `无法启动试听：${error.message}`
          : '无法启动试听，请检查浏览器音频权限。',
        isError: true,
      })
    }
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.matches('input, select, textarea')) return
    const commandKey = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()

    if (commandKey && key === 'z') {
      event.preventDefault()
      dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
      return
    }
    if (commandKey && key === 'y') {
      event.preventDefault()
      dispatch({ type: 'redo' })
      return
    }
    if (commandKey && key === 'c') {
      event.preventDefault()
      dispatch({ type: 'copy-selection' })
      return
    }
    if (commandKey && key === 'v') {
      event.preventDefault()
      dispatch({ type: 'paste-positions' })
      return
    }
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault()
      if (editor.fretInput) {
        const digits = `${editor.fretInput.digits}${event.key}`
        const fret = Number(digits)
        if (digits.length === 2 && fret <= 24) {
          dispatch({ type: 'write-fret', fret, duration: activeDuration })
          return
        }
      }
      dispatch({ type: 'input-fret-digit', digit: Number(event.key) })
      return
    }
    if (event.key === 'Enter' && editor.fretInput) {
      event.preventDefault()
      dispatch({
        type: 'write-fret',
        fret: Number(editor.fretInput.digits),
        duration: activeDuration,
      })
      return
    }

    const keyActions: Partial<Record<string, EditorAction>> = {
      ArrowUp: { type: 'move-cursor', direction: 'string-up' },
      ArrowDown: { type: 'move-cursor', direction: 'string-down' },
      ArrowLeft: { type: 'move-cursor', direction: 'position-previous' },
      ArrowRight: { type: 'move-cursor', direction: 'position-next' },
      Escape: { type: 'cancel-fret-input' },
      Delete: { type: 'delete-selection' },
      Backspace: { type: 'delete-selection' },
    }
    const action = keyActions[event.key]
    if (action) {
      event.preventDefault()
      dispatch(action)
    }
  }

  function handleViewportScroll() {
    const viewport = scoreViewportRef.current
    if (!viewport) return
    dispatch({
      type: 'set-scroll',
      scroll: { left: viewport.scrollLeft, top: viewport.scrollTop },
    })
  }

  return (
    <div className="app-shell" onKeyDown={handleEditorKeyDown}>
      <header className="command-bar">
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          tabIndex={-1}
          onChange={handleImportFile}
          aria-label="选择要导入的 JSON 乐谱"
        />
        <div className="brand" aria-label="六弦工坊">
          <span className="brand-mark" aria-hidden="true">
            <Guitar size={19} strokeWidth={2.2} />
          </span>
          <strong>六弦工坊</strong>
        </div>

        <nav className="command-group" aria-label="文件与历史命令">
          <IconButton
            label="新建乐谱"
            onClick={() => {
              if (integrations.onNewScore) {
                integrations.onNewScore((score) =>
                  applyScoreReplacement(score, '已新建乐谱并保存本地草稿。'),
                )
                return
              }
              handleNewScore()
            }}
          >
            <FilePlus2 />
          </IconButton>
          <IconButton
            label="导入 JSON"
            onClick={() => {
              if (integrations.onImportScore) {
                integrations.onImportScore((score) =>
                  applyScoreReplacement(score, '已导入乐谱并保存本地草稿。'),
                )
                return
              }
              fileInputRef.current?.click()
            }}
          >
            <FolderOpen />
          </IconButton>
          <IconButton
            label="导出 JSON"
            onClick={handleExportScore}
          >
            <Download />
          </IconButton>
          <ToolbarDivider />
          <IconButton
            label="撤销（⌘/Ctrl+Z）"
            disabled={editor.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            label="重做（⌘/Ctrl+Shift+Z）"
            disabled={editor.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
          >
            <Redo2 />
          </IconButton>
          <IconButton
            label="复制选择（⌘/Ctrl+C）"
            disabled={editor.selection.type === 'none'}
            onClick={() => dispatch({ type: 'copy-selection' })}
          >
            <Copy />
          </IconButton>
          <IconButton
            label="粘贴（⌘/Ctrl+V）"
            disabled={editor.clipboard.length === 0}
            onClick={() => dispatch({ type: 'paste-positions' })}
          >
            <Clipboard />
          </IconButton>
        </nav>

        <div className="command-spacer" />
        <div
          className={`save-status save-${saveState.status}`}
          role="status"
          title={saveState.error?.message}
        >
          <Save size={14} />
          <span>{saveStatusText}</span>
        </div>

        <nav className="command-group playback-group" aria-label="试听命令">
          <IconButton label="从开头播放" onClick={() => playback('play-from-start')}>
            <RotateCcw />
          </IconButton>
          <button
            className="primary-command"
            type="button"
            title={editor.playback.status === 'paused' ? '继续播放' : '从光标播放'}
            onClick={() => playback('play-from-cursor')}
          >
            <Play size={16} fill="currentColor" />
            <span>{editor.playback.status === 'paused' ? '继续' : '播放'}</span>
          </button>
          <IconButton
            label="暂停播放"
            disabled={editor.playback.status !== 'playing'}
            onClick={() => playback('pause')}
          >
            <Pause />
          </IconButton>
          <IconButton
            label="停止播放"
            disabled={editor.playback.status === 'stopped'}
            onClick={() => playback('stop')}
          >
            <Square />
          </IconButton>
        </nav>
      </header>

      <main className="workspace">
        <section className="score-info" aria-label="乐谱信息">
          <label className="field title-field">
            <span>标题</span>
            <input
              type="text"
              value={editor.score.title}
              onChange={(event) => updateScoreField('title', event.target.value)}
              aria-label="歌曲标题"
            />
          </label>

          <label className="field compact-field">
            <span>拍号</span>
            <span className="select-control">
              <select
                value={editor.score.timeSignature}
                onChange={(event) => updateScoreField(
                  'timeSignature',
                  event.target.value as Score['timeSignature'],
                )}
                aria-label="拍号"
              >
                {SUPPORTED_TIME_SIGNATURES.map((signature) => (
                  <option key={signature}>{signature}</option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" />
            </span>
          </label>

          <label className="field tempo-field">
            <span>速度</span>
            <span className="unit-input">
              <input
                type="number"
                min="30"
                max="240"
                value={editor.score.bpm}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (value >= 30 && value <= 240) updateScoreField('bpm', value)
                }}
                aria-label="速度，每分钟拍数"
              />
              <span>BPM</span>
            </span>
          </label>

          <label className="field compact-field">
            <span>变调夹</span>
            <span className="select-control">
              <select
                value={editor.score.capo}
                onChange={(event) => updateScoreField('capo', Number(event.target.value))}
                aria-label="变调夹品位"
              >
                {Array.from({ length: 13 }, (_, fret) => (
                  <option key={fret} value={fret}>
                    {fret === 0 ? '无' : `${fret} 品`}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" />
            </span>
          </label>

          <fieldset className="tuning-fields">
            <legend>六弦调弦</legend>
            {editor.score.tuning.map((pitch, index) => (
              <label key={index}>
                <span>{index + 1}</span>
                <select
                  value={pitch}
                  aria-label={`第 ${index + 1} 弦开放弦音高`}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    const tuning = [...editor.score.tuning]
                    tuning[index] = event.target.value
                    updateScoreField('tuning', tuning)
                  }}
                >
                  {PITCH_OPTIONS.map((option) => (
                    <option value={option} key={option}>{option}</option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>

          <button
            className="secondary-command tuning-reset"
            type="button"
            onClick={() => updateScoreField('tuning', [...STANDARD_TUNING])}
          >
            <Settings2 size={15} />
            恢复标准调弦
          </button>
        </section>

        <section className="note-toolbar" aria-label="音符与编辑工具栏">
          <div className="tool-section">
            <span className="tool-label">时值</span>
            <div className="segmented-control" role="group" aria-label="选择时值">
              {DURATION_OPTIONS.map(({ value, label, shortLabel }) => (
                <button
                  className={activeDuration === value ? 'is-active' : undefined}
                  type="button"
                  key={value}
                  title={label}
                  aria-label={label}
                  aria-pressed={activeDuration === value}
                  onClick={() => setDuration(value)}
                >
                  <span aria-hidden="true">{shortLabel}</span>
                </button>
              ))}
            </div>
          </div>

          <ToolbarDivider />

          <div className="tool-section fret-entry">
            <label htmlFor="fret-input">品位</label>
            <input
              id="fret-input"
              type="number"
              inputMode="numeric"
              min="0"
              max="24"
              placeholder="0–24"
              value={fretDraft}
              onChange={(event) => setFretDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitFret()
              }}
            />
            <button
              className="secondary-command"
              type="button"
              disabled={fretDraft === '' || Number(fretDraft) < 0 || Number(fretDraft) > 24}
              onClick={submitFret}
            >
              录入
            </button>
          </div>

          <div className="mode-control" role="group" aria-label="录入模式">
            {(['replace', 'insert'] as const).map((mode) => (
              <button
                type="button"
                className={editor.entryMode === mode ? 'is-active' : undefined}
                aria-pressed={editor.entryMode === mode}
                onClick={() => dispatch({ type: 'set-entry-mode', mode })}
                key={mode}
              >
                {mode === 'replace' ? '替换' : '插入'}
              </button>
            ))}
          </div>

          <ToolbarDivider />

          <div className="tool-section structure-tools">
            <button className="secondary-command" type="button" onClick={insertRest}>
              <span className="rest-symbol" aria-hidden="true">𝄽</span>
              插入休止
            </button>
            <button className="secondary-command" type="button" onClick={convertSelectionToRest}>
              设为休止
            </button>
            <button className="secondary-command" type="button" onClick={addMeasure}>
              <CirclePlus size={15} />
              新增小节
            </button>
            <button
              className="secondary-command danger-command"
              type="button"
              onClick={() => dispatch({ type: 'delete-selection' })}
              disabled={editor.selection.type === 'none'}
            >
              <Trash2 size={15} />
              删除选择
            </button>
            <button
              className="secondary-command danger-command"
              type="button"
              onClick={removeCurrentMeasure}
            >
              删除小节
            </button>
          </div>
        </section>

        <section
          className="score-viewport"
          aria-label="六线谱编辑区。方向键移动，数字键输入品位，Shift 点击选择区间"
          tabIndex={0}
          ref={scoreViewportRef}
          onScroll={handleViewportScroll}
        >
          {(feedback || saveState.error) && (
            <div
              className={`app-feedback${feedback?.isError || saveState.status === 'error' ? ' is-error' : ''}`}
              role={feedback?.isError || saveState.status === 'error' ? 'alert' : 'status'}
            >
              <span>{saveState.error?.message ?? feedback?.message}</span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setFeedback(null)}
              >
                关闭
              </button>
            </div>
          )}
          <div className="score-page">
            <div className="score-heading">
              <div>
                <p className="eyebrow">GUITAR TAB</p>
                <h1>{editor.score.title || '未命名乐谱'}</h1>
              </div>
              <div className="score-meta" aria-label="乐谱摘要">
                <span>{editor.score.timeSignature}</span>
                <span>♩ = {editor.score.bpm}</span>
                <span>Capo {editor.score.capo}</span>
              </div>
            </div>

            <p className="keyboard-help">
              ↑↓ 换弦 · ←→ 换位置 · 数字输入品位 · Shift+点击选择区间 · Delete 删除
            </p>

            <div className="score-grid">
              {editor.score.measures.map((measure, index) => (
                <MeasureView
                  key={measure.id}
                  measure={measure}
                  index={index}
                  score={editor.score}
                  selection={editor.selection}
                  selectedPositionIds={selectedPositionIds}
                  cursorMeasureId={editor.cursor.measureId}
                  cursorPositionId={editor.cursor.positionId}
                  cursorString={editor.cursor.stringNumber}
                  playingPositionId={playingPositionId}
                  fretInput={editor.fretInput?.digits ?? null}
                  activeDuration={activeDuration}
                  dispatch={dispatch}
                  onSelectNote={selectNote}
                  onSelectPosition={selectPosition}
                  onAddFirstPosition={addFirstPosition}
                />
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="status-bar" aria-live="polite">
        <span>第 {currentMeasureIndex + 1} 小节</span>
        <span>第 {editor.cursor.stringNumber} 弦</span>
        <span>{editor.entryMode === 'replace' ? '替换模式' : '插入模式'}</span>
        <span>{durationLabel(activeDuration)}</span>
        <span>{editor.playback.status === 'playing' ? '播放中' : editor.playback.status === 'paused' ? '已暂停' : '已停止'}</span>
        <span className="status-hint">
          {editor.fretInput
            ? `正在输入品位 ${editor.fretInput.digits}，继续输入或按 Enter`
            : editor.selection.type === 'range'
              ? `已选择 ${selectedRefs.length} 个连续位置`
              : '谱面聚焦后可直接使用键盘编辑'}
        </span>
      </footer>
    </div>
  )
}

export default App
