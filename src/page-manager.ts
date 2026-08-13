import type { Page, PressOutcome } from './pages/types.js'

export class PageManager {
  private pages: Page[] = []
  private idx = 0

  add(page: Page): void {
    this.pages.push(page)
    if (this.pages.length === 1) page.onEnter?.()
  }

  get index(): number {
    return this.idx
  }

  get count(): number {
    return this.pages.length
  }

  indexOf(name: string): number {
    return this.pages.findIndex((page) => page.name === name)
  }

  current(): Page {
    const p = this.pages[this.idx]
    if (!p) throw new Error('no page has been added')
    return p
  }

  next(): void {
    this.setIndex((this.idx + 1) % this.pages.length)
  }

  prev(): void {
    this.setIndex((this.idx - 1 + this.pages.length) % this.pages.length)
  }

  setIndex(i: number): void {
    // A non-integer index (corrupt `ui.json`, for example `1.5`) would
    // otherwise pass the range check below, land in `this.idx`, and make
    // `current()` throw on the next call — array indexing does not round.
    if (!Number.isInteger(i)) return
    if (i < 0 || i >= this.pages.length || i === this.idx) return
    this.pages[this.idx]?.onLeave?.()
    this.idx = i
    this.pages[this.idx]?.onEnter?.()
  }

  setByName(name: string): void {
    this.setIndex(this.indexOf(name))
  }

  /**
   * Routes a press to the current page and reports what it did. The daemon
   * itself calls `this.pages.current().onKeyPress(index)` directly rather
   * than through here, so this is dead in production — but its signature
   * used to discard the one value the whole press-feedback feature depends
   * on (M4), which any future caller would inherit silently.
   */
  async onKeyPress(index: number): Promise<PressOutcome> {
    return await this.current().onKeyPress(index)
  }
}
