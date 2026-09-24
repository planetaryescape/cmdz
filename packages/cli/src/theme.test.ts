import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('terminal theme changes recolor the child terminal defaults with cmdz chrome', async () => {
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
    expect(before?.bg.toInts().slice(0, 3)).toEqual([7, 28, 32])
    expect(after?.fg.toInts().slice(0, 3)).toEqual([24, 33, 47])
    expect(after?.bg.toInts().slice(0, 3)).toEqual([255, 255, 255])
    expect(
      spans.some((span) =>
        span.bg
          .toInts()
          .slice(0, 3)
          .every((channel) => channel === 0),
      ),
    ).toBe(false)
  } finally {
    await ui.close()
  }
})

test('child-provided ANSI colors survive a theme change', async () => {
  const ui = await createWorkspace([
    {
      ...probe,
      command: `${process.execPath} -e 'console.log("\\x1b[41;37mCOLOR\\x1b[0m plain"); await new Promise(() => {});'`,
    },
  ])
  try {
    await ui.waitFor('COLOR')
    const before = ui.captureSpans().lines.flatMap((line) => line.spans)
    const colored = before.find((span) => span.text.includes('COLOR'))
    expect(colored).toBeDefined()
    ui.renderer.emit('theme_mode', 'light')
    await ui.renderOnce()
    const after = ui.captureSpans().lines.flatMap((line) => line.spans)
    const recolored = after.find((span) => span.text.includes('COLOR'))
    expect(recolored?.fg.toInts()).toEqual(colored?.fg.toInts())
    expect(recolored?.bg.toInts()).toEqual(colored?.bg.toInts())
  } finally {
    await ui.close()
  }
})
