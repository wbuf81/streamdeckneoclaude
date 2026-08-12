import { appendFileSync, statSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.js'

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

/**
 * Builds a sink that appends to `file`. It rotates past `maxBytes` and keeps
 * one old copy. The path is a parameter so a test can point at a temporary
 * file. A test must never read, write, rename, or delete the real log in the
 * user's home directory.
 */
export function createFileSink(file: string, maxBytes: number = MAX_BYTES): Sink {
  const rotated = `${file}.1`
  return (line: string) => {
    // A log call must never throw. Callers log from inside their own catch
    // blocks, so a throw here would escape a handler that promises not to
    // throw. A lost log line costs less than a crashed key press.
    try {
      // The mode option on mkdirSync applies only when it creates the
      // directory, so an existing directory keeps its old mode. chmodSync
      // enforces 0700 unconditionally, matching paths.ts's ensureStateDir.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      chmodSync(dirname(file), 0o700)
      try {
        if (statSync(file).size > maxBytes) renameSync(file, rotated)
      } catch {
        // The file does not exist yet. Nothing to rotate.
      }
      appendFileSync(file, line + '\n')
    } catch {
      // The disk is full, or the path is not writable. Drop the line.
    }
  }
}

/** Appends to the real log file. Rotates at 5 MB and keeps one old copy. */
export const fileSink: Sink = createFileSink(paths.logFile)

/**
 * The sink the singleton `log` writes through. A test swaps it for a no-op, so
 * the suite never appends to the real log file in the user's home directory.
 */
let defaultSink: Sink = fileSink

export function setDefaultSink(sink: Sink): void {
  defaultSink = sink
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

/**
 * The shared logger. It writes through `defaultSink`, which a test replaces, so
 * the suite cannot append to the real log file.
 */
export const log = createLogger((line) => defaultSink(line))
