import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createLogger, createFileSink } from '../src/log.js'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('createFileSink', () => {
  // A dedicated temp directory per test. This suite must never name, read,
  // write, rename, or delete anything under the real ~/.local/state/deckd —
  // createFileSink takes the path as a parameter for exactly this reason.
  let dir: string
  let file: string
  let rotatedFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-log-'))
    file = join(dir, 'deckd.log')
    rotatedFile = `${file}.1`
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rotates the log file past the threshold and starts a fresh file', () => {
    const sink = createFileSink(file, 100)
    const oldContent = 'x'.repeat(101)
    writeFileSync(file, oldContent)

    sink('first line after rotation')

    expect(existsSync(rotatedFile)).toBe(true)
    expect(readFileSync(rotatedFile, 'utf8')).toBe(oldContent)
    expect(readFileSync(file, 'utf8')).toBe('first line after rotation\n')
  })

  it('does not rotate a log file under the threshold', () => {
    const sink = createFileSink(file, 100)
    writeFileSync(file, 'small\n')

    sink('appended line')

    expect(existsSync(rotatedFile)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('small\nappended line\n')
  })

  it('creates the log directory on first write, matching the real fileSink default', () => {
    const nested = join(dir, 'nested', 'deckd.log')
    const sink = createFileSink(nested)

    sink('first line')

    expect(readFileSync(nested, 'utf8')).toBe('first line\n')
  })
})
