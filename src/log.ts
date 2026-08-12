import { appendFileSync, statSync, renameSync } from 'node:fs'
import { paths, ensureStateDir } from './paths.js'

export type Sink = (line: string) => void
export type Level = 'INFO' | 'WARN' | 'ERROR'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  /** Logs once per key. Later calls with the same key do nothing. */
  once(key: string, msg: string): void
  /** Forgets a key, so the next `once` call with it logs again. */
  clearOnce(key: string): void
}

const MAX_BYTES = 5 * 1024 * 1024

/** Appends to the log file. Rotates at 5 MB and keeps one old copy. */
export function fileSink(line: string): void {
  ensureStateDir()
  try {
    if (statSync(paths.logFile).size > MAX_BYTES) {
      renameSync(paths.logFile, `${paths.logFile}.1`)
    }
  } catch {
    // The file does not exist yet. Nothing to rotate.
  }
  appendFileSync(paths.logFile, line + '\n')
}

export function createLogger(sink: Sink = fileSink): Logger {
  const seen = new Set<string>()

  const write = (level: Level, msg: string) => {
    sink(`${new Date().toISOString()} ${level} ${msg}`)
  }

  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    once(key, msg) {
      if (seen.has(key)) return
      seen.add(key)
      write('WARN', msg)
    },
    clearOnce(key) {
      seen.delete(key)
    },
  }
}

export const log = createLogger()
