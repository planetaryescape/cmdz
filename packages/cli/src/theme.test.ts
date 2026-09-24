import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('terminal theme changes recolor cmdz chrome without changing the child palette', async () => {
  const ui = await createWorkspace([probe])
  try {
    await ui.waitFor('PROBE_READY')
    const before = ui
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes('PROBE_READY'))
    expect(before).toBeDefined()

    ui.renderer.emit('theme_mode', 'light')
    await ui.renderOnce()

    const spans = ui.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.some((span) => span.bg.toInts().slice(0, 3).join(',') === '244,247,250')).toBe(
      true,
    )
    expect(spans.some((span) => span.fg.toInts().slice(0, 3).join(',') === '84,112,0')).toBe(true)
    const after = spans.find((span) => span.text.includes('PROBE_READY'))
    expect(after?.fg.toInts()).toEqual(before?.fg.toInts())
    expect(after?.bg.toInts()).toEqual(before?.bg.toInts())
  } finally {
    await ui.close()
  }
})
