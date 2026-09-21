import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('terminal theme changes recolor cmdz chrome without changing the child palette', async () => {
  const ui = await createWorkspace([{ ...probe, autostart: false }])
  try {
    await ui.waitFor('Probe [idle]')
    ui.renderer.emit('theme_mode', 'light')
    await ui.renderOnce()

    const spans = ui.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.some((span) => span.bg.toInts().slice(0, 3).join(',') === '244,247,250')).toBe(
      true,
    )
    expect(spans.some((span) => span.fg.toInts().slice(0, 3).join(',') === '0,126,168')).toBe(true)
  } finally {
    await ui.close()
  }
})
