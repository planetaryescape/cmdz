import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from '@opentui/core'
import { Cause, Effect, Fiber, Queue } from 'effect'

import type { ProcessDefinition } from './config'
import { ProcessPane } from './process-pane'
import { runPty } from './pty-process'
import { createShortcutHelp } from './shortcut-help'

type Action =
  | { readonly type: 'quit' }
  | { readonly type: 'start' | 'stop' | 'restart'; readonly pane: ProcessPane }
  | {
      readonly type: 'exited'
      readonly pane: ProcessPane
      readonly run: number
      readonly code: number
    }
  | { readonly type: 'failed'; readonly pane: ProcessPane; readonly run: number }

export const processWorkspace = Effect.fn('process.workspace')(function* (
  renderer: CliRenderer,
  definitions: readonly ProcessDefinition[],
) {
  const actions = yield* Queue.unbounded<Action>()
  const header = new TextRenderable(renderer, { id: 'status', height: 1 })
  const footer = new TextRenderable(renderer, { id: 'help', height: 1 })
  const row = new BoxRenderable(renderer, { id: 'workspace', flexDirection: 'row', flexGrow: 1 })
  const sidebar = new TextRenderable(renderer, { id: 'sidebar', width: 22 })
  const body = new BoxRenderable(renderer, { id: 'body', flexGrow: 1 })
  renderer.root.add(header)
  renderer.root.add(row)
  row.add(sidebar)
  row.add(body)
  renderer.root.add(footer)
  const help = createShortcutHelp(renderer)
  renderer.root.add(help)
  const panes = definitions.map((definition, index) => new ProcessPane(definition, renderer, index))
  let selected = panes[0]
  if (!selected) return
  const inheritedEnv = { ...process.env }
  const sorted = () =>
    [...panes].sort((a, b) => Number(b.active) - Number(a.active) || a.index - b.index)
  const drawStatus = () => {
    if (!selected || header.isDestroyed || sidebar.isDestroyed || footer.isDestroyed) return
    const focused = selected.terminal.focused
    header.content = `cmdz  |  ${selected.definition.title} [${selected.status}]  |  ${focused ? 'INPUT' : 'NAVIGATION'}`
    footer.content = focused
      ? 'Ctrl-Z sidebar  |  Ctrl-C interrupts child'
      : 'j/k select | Enter start/focus | h sidebar | x stop | r restart | q quit | ? help'
    sidebar.content = sorted()
      .map((pane) => `${pane === selected ? '>' : ' '} ${pane.definition.title}\n  ${pane.status}`)
      .join('\n')
    for (const pane of panes) pane.terminal.zIndex = pane === selected ? 1 : 0
  }
  const blur = () => {
    selected?.terminal.blur()
    drawStatus()
  }
  const bindTerminal = (pane: ProcessPane) => {
    pane.terminal.on('focused', () => {
      if (help.visible || pane !== selected || pane.status !== 'running') pane.terminal.blur()
      drawStatus()
    })
    pane.terminal.on('blurred', drawStatus)
    body.add(pane.terminal)
  }
  for (const pane of panes) bindTerminal(pane)
  drawStatus()

  const onKey = (key: KeyEvent) => {
    if (!selected) return
    if (help.visible) {
      if (key.name === '?' || key.name === 'escape') help.visible = false
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (selected.terminal.focused) {
      if (key.ctrl && key.name === 'z') {
        key.preventDefault()
        key.stopPropagation()
        blur()
      }
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (selected.pty) {
        selected.terminal.focus()
        drawStatus()
      } else Queue.offerUnsafe(actions, { type: 'start', pane: selected })
    } else if (['j', 'k', 'up', 'down'].includes(key.name)) {
      const order = sorted()
      const delta = key.name === 'j' || key.name === 'down' ? 1 : -1
      const next = order[order.indexOf(selected) + delta]
      if (next) {
        selected = next
        drawStatus()
      }
    } else if (key.name === '?') {
      help.visible = true
    } else if (key.name === 'h') {
      sidebar.visible = !sidebar.visible
    } else if (key.name === 'x') Queue.offerUnsafe(actions, { type: 'stop', pane: selected })
    else if (key.name === 'r') Queue.offerUnsafe(actions, { type: 'restart', pane: selected })
    else if (key.name === 'q' || (key.ctrl && key.name === 'c'))
      Queue.offerUnsafe(actions, { type: 'quit' })
    key.preventDefault()
    key.stopPropagation()
  }
  const onDestroy = () => Queue.offerUnsafe(actions, { type: 'quit' })
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      renderer.keyInput.on('keypress', onKey)
      renderer.on('destroy', onDestroy)
    }),
    () =>
      Effect.sync(() => {
        renderer.keyInput.off('keypress', onKey)
        renderer.off('destroy', onDestroy)
      }),
  )
  for (const pane of panes) {
    if (pane.definition.autostart) yield* Queue.offer(actions, { type: 'start', pane })
  }
  yield* Effect.logInfo('Process workspace ready')
  while (true) {
    const action = yield* Queue.take(actions)
    if (action.type === 'quit') return
    const pane = action.pane
    if (action.type === 'exited' || action.type === 'failed') {
      if (action.run !== pane.run) continue
      pane.fiber = undefined
      pane.status =
        action.type === 'failed'
          ? 'failed'
          : action.code === 0
            ? 'succeeded'
            : `failed (${action.code})`
      if (pane === selected) blur()
      else drawStatus()
      continue
    }
    if (action.type === 'stop' || action.type === 'restart') {
      if (pane.fiber) {
        pane.status = 'stopping'
        if (pane === selected) blur()
        yield* Fiber.interrupt(pane.fiber)
        pane.fiber = undefined
        pane.run++
        pane.status = 'stopped'
        drawStatus()
      }
      if (action.type === 'stop') continue
    }
    if (pane.fiber) continue
    pane.run++
    const generation = pane.run
    body.remove(pane.terminal)
    pane.terminal.destroy()
    pane.terminal = pane.makeTerminal()
    bindTerminal(pane)
    pane.status = 'starting'
    drawStatus()
    const terminal = pane.terminal
    const screen = terminal.screen()
    pane.fiber = yield* runPty(
      ['/bin/sh', '-c', pane.definition.command],
      {
        columns: screen.columns,
        rows: screen.rows,
        output: (bytes) => terminal.write(bytes),
        attach: (value) => {
          pane.pty = value
          if (value) {
            const size = terminal.screen()
            value.resize(Math.max(1, size.columns), Math.max(1, size.rows))
            pane.status = 'running'
            drawStatus()
          }
        },
      },
      { cwd: pane.definition.cwd, env: { ...inheritedEnv, ...pane.definition.env } },
    ).pipe(
      Effect.annotateLogs({ 'command.name': pane.definition.name }),
      Effect.withSpan('command.run', { attributes: { 'command.name': pane.definition.name } }),
      Effect.matchCauseEffect({
        onSuccess: (code) => Queue.offer(actions, { type: 'exited', pane, run: generation, code }),
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError('Process operation failed').pipe(
                Effect.andThen(Queue.offer(actions, { type: 'failed', pane, run: generation })),
              ),
      }),
      Effect.asVoid,
      Effect.forkScoped,
    )
  }
}, Effect.scoped)
