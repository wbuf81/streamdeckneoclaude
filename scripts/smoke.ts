import { Device, BUTTON_LEFT, BUTTON_RIGHT } from '../src/device.js'
import { renderKey, renderStrip } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import type { Rgb } from '../src/render/specs.js'

const COLORS: Rgb[] = [
  theme.red, theme.amber, theme.green, theme.cyan,
  theme.blue, theme.gray, theme.white, theme.textDim,
]

/**
 * Draws the test pattern and reports every press until Ctrl-C.
 *
 * `--once` draws the pattern and exits right away, with no wait for
 * SIGINT. Use it for an automated check. Plain `npm run smoke`, with no
 * flag, keeps running so a person can press keys and read the console.
 */
async function main(): Promise<void> {
  const once = process.argv.includes('--once')

  const device = new Device()
  try {
    await device.connect()
  } catch (e) {
    // A present but busy device throws. Report the cause instead of crashing
    // with an unhandled rejection.
    console.error(String(e))
    process.exit(1)
  }
  if (!device.isConnected()) {
    console.error('no Stream Deck Neo found. Plug it in and try again.')
    process.exit(1)
  }

  await device.setBrightness(80)

  for (let i = 0; i < 8; i++) {
    const color = COLORS[i]!
    const buf = renderKey({
      kind: 'gauge',
      lines: [`KEY ${i}`, i < 4 ? 'row 0' : 'row 1'],
      border: color,
      bar: { value: (i + 1) / 8, color },
    })
    await device.setKeyImage(i, buf)
  }

  await device.setStrip(
    renderStrip({
      lines: ['deckd smoke test', 'press any key. ctrl-c to quit.'],
      bar: { value: 0.5, color: theme.green },
      right: '8/8',
    }),
  )

  await device.setButtonColor(BUTTON_LEFT, theme.red)
  await device.setButtonColor(BUTTON_RIGHT, theme.green)

  device.onPress((i) => console.log(`press  index=${i}`))
  device.onRelease((i) => console.log(`release index=${i}`))

  console.log('Test pattern drawn. Confirm all 8 keys, the strip, and both buttons.')

  const quit = async () => {
    await device.disconnect()
    process.exit(0)
  }

  if (once) {
    console.log('--once given. Drew the pattern. Exiting without waiting for a press.')
    await quit()
    return
  }

  console.log('Press keys to confirm the index mapping. Ctrl-C to quit.')
  process.on('SIGINT', () => void quit())
}

void main()
