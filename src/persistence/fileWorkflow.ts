import {
  createDefaultScore,
  parseScoreJson,
  serializeScore,
  type IdFactory,
  type Score,
} from '../domain/guitarTab'
import {
  requiresUnsavedChangesConfirmation,
  type SaveState,
} from './persistence'

export interface ReadableScoreFile {
  name: string
  text(): Promise<string>
}

export type FileWorkflowErrorCode =
  | 'file-read-failed'
  | 'invalid-json'
  | 'unsupported-version'
  | 'invalid-score'
  | 'download-failed'

export class FileWorkflowError extends Error {
  constructor(
    public readonly code: FileWorkflowErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FileWorkflowError'
  }
}

export interface ScoreReplacementPlan {
  source: 'new' | 'import'
  score: Score
  requiresConfirmation: boolean
}

export type ScoreReplacementResult =
  | { status: 'cancelled' }
  | {
      status: 'replace'
      score: Score
      clearHistory: true
      saveImmediately: true
    }

export interface ScoreDownload {
  fileName: string
  mimeType: 'application/json;charset=utf-8'
  contents: string
}

export interface ScoreDownloadAdapter {
  download(file: ScoreDownload): void
}

export function prepareNewScore(
  saveState: SaveState,
  idFactory?: IdFactory,
): ScoreReplacementPlan {
  return {
    source: 'new',
    score: createDefaultScore(idFactory),
    requiresConfirmation: requiresUnsavedChangesConfirmation(saveState),
  }
}

export async function readScoreFile(file: ReadableScoreFile): Promise<Score> {
  let contents: string
  try {
    contents = await file.text()
  } catch (cause) {
    throw new FileWorkflowError(
      'file-read-failed',
      `无法读取文件“${file.name}”，请重新选择文件。`,
      { cause },
    )
  }
  return parseImportedScoreJson(contents)
}

export async function prepareScoreImport(
  file: ReadableScoreFile,
): Promise<ScoreReplacementPlan> {
  return {
    source: 'import',
    score: await readScoreFile(file),
    requiresConfirmation: true,
  }
}

export function parseImportedScoreJson(json: string): Score {
  try {
    return parseScoreJson(json)
  } catch (cause) {
    const detail = errorMessage(cause)
    if (detail === 'Invalid JSON') {
      throw new FileWorkflowError(
        'invalid-json',
        '所选文件不是合法的 JSON。',
        { cause },
      )
    }
    if (detail.startsWith('Unsupported score version:')) {
      throw new FileWorkflowError(
        'unsupported-version',
        `所选文件的格式版本不受支持：${detail}`,
        { cause },
      )
    }
    throw new FileWorkflowError(
      'invalid-score',
      `所选文件不是有效的吉他六线谱：${detail}`,
      { cause },
    )
  }
}

export function resolveScoreReplacement(
  plan: ScoreReplacementPlan,
  confirmed: boolean,
): ScoreReplacementResult {
  if (plan.requiresConfirmation && !confirmed) {
    return { status: 'cancelled' }
  }
  return {
    status: 'replace',
    score: plan.score,
    clearHistory: true,
    saveImmediately: true,
  }
}

export function createScoreDownload(score: Score): ScoreDownload {
  return {
    fileName: `${safeFileName(score.title)}.guitar-tab.json`,
    mimeType: 'application/json;charset=utf-8',
    contents: serializeScore(score),
  }
}

export function downloadScoreJson(
  score: Score,
  adapter: ScoreDownloadAdapter = browserDownloadAdapter,
): ScoreDownload {
  const file = createScoreDownload(score)
  try {
    adapter.download(file)
  } catch (cause) {
    throw new FileWorkflowError(
      'download-failed',
      '无法下载乐谱文件，请检查浏览器下载权限。',
      { cause },
    )
  }
  return file
}

const browserDownloadAdapter: ScoreDownloadAdapter = {
  download(file) {
    const blob = new Blob([file.contents], { type: file.mimeType })
    const url = URL.createObjectURL(blob)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.fileName
      anchor.click()
    } finally {
      URL.revokeObjectURL(url)
    }
  },
}

function safeFileName(title: string): string {
  const sanitized = title
    .trim()
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
    .replace(/[.\s]+$/g, '')
    .slice(0, 80)
  return sanitized || '未命名乐谱'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
