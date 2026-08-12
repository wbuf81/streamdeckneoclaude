import type { Page } from './pages/types.js'

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
    if (i < 0 || i >= this.pages.length || i === this.idx) return
    this.pages[this.idx]?.onLeave?.()
    this.idx = i
    this.pages[this.idx]?.onEnter?.()
  }

  async onKeyPress(index: number): Promise<void> {
    await this.current().onKeyPress(index)
  }
}
