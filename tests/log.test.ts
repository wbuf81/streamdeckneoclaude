import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createLogger, fileSink } from '../src/log.js'
import { paths, ensureStateDir } from '../src/paths.js'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'

describe('createLogger', () => {
  let written: string[]

  beforeEach(() => {
    written = []
  })

  const sink = (line: string) => written.push(line)

  it('writes a level and a message', () => {
    const log = createLogger(sink)
    log.info('deck connected')
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('INFO')
    expect(written[0]).toContain('deck connected')
  })

  it('writes a once-keyed message a single time', () => {
    const log = createLogger(sink)
    log.once('no-device', 'device absent')
    log.once('no-device', 'device absent')
    log.once('no-device', 'device absent')
    expect(written).toHaveLength(1)
  })

  it('lets a different key through', () => {
    const log = createLogger(sink)
    log.once('a', 'first')
    log.once('b', 'second')
    expect(written).toHaveLength(2)
  })

  it('clears a once key so the next event logs again', () => {
    const log = createLogger(sink)
    log.once('no-device', 'device absent')
    log.clearOnce('no-device')
    log.once('no-device', 'device absent')
    expect(written).toHaveLength(2)
  })
})

describe('fileSink', () => {
  const rotatedFile = `${paths.logFile}.1`

  beforeEach(() => {
    ensureStateDir()
    rmSync(paths.logFile, { force: true })
    rmSync(rotatedFile, { force: true })
  })

  afterEach(() => {
    rmSync(paths.logFile, { force: true })
    rmSync(rotatedFile, { force: true })
  })

  it('rotates the log file past 5 MB and starts a fresh file', () => {
    const oldContent = 'x'.repeat(5 * 1024 * 1024 + 1)
    writeFileSync(paths.logFile, oldContent)

    fileSink('first line after rotation')

    expect(existsSync(rotatedFile)).toBe(true)
    expect(readFileSync(rotatedFile, 'utf8')).toBe(oldContent)
    expect(readFileSync(paths.logFile, 'utf8')).toBe(
      'first line after rotation\n',
    )
  })

  it('does not rotate a log file under 5 MB', () => {
    writeFileSync(paths.logFile, 'small\n')

    fileSink('appended line')

    expect(existsSync(rotatedFile)).toBe(false)
    expect(readFileSync(paths.logFile, 'utf8')).toBe(
      'small\nappended line\n',
    )
  })
})
