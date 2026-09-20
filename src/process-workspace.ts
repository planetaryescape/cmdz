import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from '@opentui/core'
import { Effect, Queue, Stream } from 'effect'

import type { ProcessDefinition } from './config'
import type { TerminalSize } from './process-driver'
import { ProcessPane } from './process-pane'
import { ptyProcessDriverLayer } from './pty-process'
import { createShortcutHelp } from './shortcut-help'
import {
  createWorkspaceController,
  renderStatus,
  type PaneLifecycle,
  type WorkspaceCommand,
  type WorkspaceController,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from './workspace-core'

type UiAction =
  | { readonly type: 'quit' }
  | { readonly type: 'command'; readonly command: WorkspaceCommand }

function isActive(lifecycle: PaneLifecycle) {
  return (
    lifecycle._tag === 'Starting' || lifecycle._tag === 'Running' || lifecycle._tag === 'Stopping'
  )
}

export const renderProcessWorkspace = Effect.fn('process.workspace')(function* (
  renderer: CliRenderer,
  definitions: readonly ProcessDefinition[],
  controller: WorkspaceController,
) {
  const actions = yield* Queue.unbounded<UiAction>()
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

  const offer = (command: WorkspaceCommand) =>
    Queue.offerUnsafe(actions, { type: 'command', command })
  const panes = definitions.map(
    (definition, index) =>
      new ProcessPane(definition, renderer, index, {
        onData: (name, run, bytes, source) =>
          offer({
            type: 'write',
            name,
            source: source === 'response' ? 'terminalResponse' : 'user',
            bytes,
            run: source === 'response' ? run : undefined,
          }),
        onResize: (name, columns, rows) => offer({ type: 'resize', name, size: { columns, rows } }),
      }),
  )
  const panesByName = new Map(panes.map((pane) => [pane.definition.name, pane]))
  for (const pane of panes) body.add(pane.terminal)
  let snapshot = yield* controller.snapshot
  let pendingSelected = snapshot.selected
  let pendingSidebarVisible = snapshot.sidebarVisible

  const selectedPane = () => panesByName.get(snapshot.selected)
  const selectedSnapshot = () => snapshot.panes.find((pane) => pane.name === snapshot.selected)
  const sortedPanes = () =>
    [...panes].sort((left, right) => {
      const leftState = snapshot.panes.find((pane) => pane.name === left.definition.name)
      const rightState = snapshot.panes.find((pane) => pane.name === right.definition.name)
      return (
        Number(rightState ? isActive(rightState.lifecycle) : false) -
          Number(leftState ? isActive(leftState.lifecycle) : false) || left.index - right.index
      )
    })
  const draw = () => {
    const selected = selectedPane()
    const selectedState = selectedSnapshot()
    if (
      !selected ||
      !selectedState ||
      header.isDestroyed ||
      sidebar.isDestroyed ||
      footer.isDestroyed
    )
      return
    const input = snapshot.mode === 'input' && selected.terminal.focused
    header.content = `cmdz  |  ${selected.definition.title} [${renderStatus(selectedState.lifecycle)}]  |  ${input ? 'INPUT' : 'NAVIGATION'}`
    footer.content = input
      ? 'Ctrl-Z sidebar  |  Ctrl-C interrupts child'
      : 'j/k select | Enter start/focus | h sidebar | x stop | r restart | q quit | ? help'
    sidebar.visible = snapshot.sidebarVisible
    sidebar.content = sortedPanes()
      .map((pane) => {
        const state = snapshot.panes.find((candidate) => candidate.name === pane.definition.name)
        return `${pane === selected ? '>' : ' '} ${pane.definition.title}\n  ${state ? renderStatus(state.lifecycle) : 'idle'}`
      })
      .join('\n')
    for (const pane of panes) pane.terminal.zIndex = pane === selected ? 1 : 0
  }
  const blur = () => {
    selectedPane()?.terminal.blur()
    offer({ type: 'leaveInput' })
  }
  const bindTerminal = (pane: ProcessPane) => {
    pane.terminal.on('focused', () => {
      const state = snapshot.panes.find((candidate) => candidate.name === pane.definition.name)
      if (
        help.visible ||
        snapshot.selected !== pane.definition.name ||
        state?.lifecycle._tag !== 'Running'
      )
        pane.terminal.blur()
      else offer({ type: 'enterInput', name: pane.definition.name })
      draw()
    })
    pane.terminal.on('blurred', () => {
      if (snapshot.selected === pane.definition.name && snapshot.mode === 'input')
        offer({ type: 'leaveInput' })
      draw()
    })
  }
  for (const pane of panes) bindTerminal(pane)
  draw()

  const applySnapshot = (next: WorkspaceSnapshot) =>
    Effect.sync(() => {
      snapshot = next
      pendingSelected = snapshot.selected
      pendingSidebarVisible = snapshot.sidebarVisible
      if (snapshot.mode === 'navigation' && selectedPane()?.terminal.focused)
        selectedPane()?.terminal.blur()
      draw()
    })
  const applyEvent = (event: WorkspaceEvent) =>
    Effect.sync(() => {
      const pane = panesByName.get(event.name)
      if (!pane) return
      if (event.type === 'resetTerminal') {
        body.remove(pane.terminal)
        pane.reset(event.run)
        bindTerminal(pane)
        body.add(pane.terminal)
        draw()
      } else if (pane.run === event.run) pane.terminal.write(event.bytes)
    })
  yield* controller.snapshots.pipe(Stream.runForEach(applySnapshot), Effect.forkScoped)
  yield* controller.events.pipe(Stream.runForEach(applyEvent), Effect.forkScoped)
  yield* Effect.yieldNow

  const onKey = (key: KeyEvent) => {
    const selected = panesByName.get(pendingSelected)
    const state = snapshot.panes.find((pane) => pane.name === pendingSelected)
    if (!selected || !state) return
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
      if (state.lifecycle._tag === 'Running') selected.terminal.focus()
      else offer({ type: 'start', name: selected.definition.name, size: selected.size() })
    } else if (['j', 'k', 'up', 'down'].includes(key.name)) {
      const order = sortedPanes()
      const delta = key.name === 'j' || key.name === 'down' ? 1 : -1
      const next = order[order.indexOf(selected) + delta]
      if (next) {
        pendingSelected = next.definition.name
        offer({ type: 'select', name: next.definition.name })
      }
    } else if (key.name === '?') help.visible = true
    else if (key.name === 'h') {
      pendingSidebarVisible = !pendingSidebarVisible
      offer({ type: 'setSidebarVisible', visible: pendingSidebarVisible })
    } else if (key.name === 'x') offer({ type: 'stop', name: selected.definition.name })
    else if (key.name === 'r')
      offer({ type: 'restart', name: selected.definition.name, size: selected.size() })
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

  const initialSizes: Record<string, TerminalSize> = {}
  for (const pane of panes) initialSizes[pane.definition.name] = pane.size()
  yield* controller.initialize(initialSizes)
  yield* Effect.logInfo('Process workspace ready')

  const run = Effect.gen(function* () {
    while (true) {
      const action = yield* Queue.take(actions)
      if (action.type === 'quit') return
      yield* controller.dispatch(action.command).pipe(
        Effect.catch((error) =>
          Effect.logWarning('Workspace command rejected').pipe(
            Effect.annotateLogs({
              operation: action.command.type,
              reason: error._tag === 'WorkspaceCommandError' ? error.reason : error.operation,
            }),
          ),
        ),
      )
    }
  })
  yield* run.pipe(Effect.onExit(() => controller.shutdown))
}, Effect.scoped)

export const processWorkspace = (
  renderer: CliRenderer,
  definitions: readonly ProcessDefinition[],
) =>
  Effect.gen(function* () {
    const controller = yield* createWorkspaceController(definitions)
    yield* renderProcessWorkspace(renderer, definitions, controller)
  }).pipe(Effect.scoped, Effect.provide(ptyProcessDriverLayer))
