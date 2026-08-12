import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger } from '../src/log.js'

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
