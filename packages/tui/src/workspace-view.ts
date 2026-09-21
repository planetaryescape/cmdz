import { normalizeTerminalSize, type TerminalSize } from '@cmdz/core/process-driver'
import type {
  PaneLifecycle,
  WorkspaceCommand,
  WorkspaceController,
  WorkspaceEvent,
  WorkspaceSnapshot,
} from '@cmdz/core/workspace'
import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import { createWorkspaceRuntime } from '@cmdz/core/workspace-runtime'
import {
  bold,
  BoxRenderable,
  fg,
  t,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type ThemeMode,
} from '@opentui/core'
import { Effect, Queue, Stream } from 'effect'

import { createShortcutHelp } from './shortcut-help'
import { TerminalPane } from './terminal-pane'
import { workspaceTheme, type WorkspaceTheme } from './theme'

type UiAction =
  | { readonly type: 'quit' }
  | { readonly type: 'command'; readonly command: WorkspaceCommand }

type PaneSection = 'running' | 'idle' | 'stopped' | 'succeeded' | 'failed'

const sections: readonly { readonly key: PaneSection; readonly label: string }[] = [
  { key: 'running', label: 'RUNNING' },
  { key: 'idle', label: 'IDLE' },
  { key: 'stopped', label: 'STOPPED' },
  { key: 'succeeded', label: 'SUCCEEDED' },
  { key: 'failed', label: 'FAILED' },
]

function paneSection(lifecycle: PaneLifecycle): PaneSection {
  if (lifecycle._tag === 'Starting' || lifecycle._tag === 'Running') return 'running'
  if (lifecycle._tag === 'Cleaning')
    return lifecycle.cleanup._tag === 'Failed' ? 'failed' : 'running'
  switch (lifecycle.outcome._tag) {
    case 'Idle':
      return 'idle'
    case 'Stopped':
      return 'stopped'
    case 'Succeeded':
      return 'succeeded'
    case 'StartFailed':
    case 'RuntimeFailed':
    case 'Exited':
      return 'failed'
  }
}

function statusColor(section: PaneSection, theme: WorkspaceTheme) {
  switch (section) {
    case 'running':
    case 'succeeded':
      return theme.running
    case 'idle':
    case 'stopped':
      return theme.muted
    case 'failed':
      return theme.danger
  }
}

/** Renders workspace state and translates OpenTUI events to framework-independent commands. */
export const renderWorkspaceView = Effect.fn('workspace.view.render')(function* (
  renderer: CliRenderer,
  definitions: readonly WorkspaceDefinition[],
  controller: WorkspaceController,
) {
  const runtime = yield* createWorkspaceRuntime(controller)
  const actions = yield* Queue.unbounded<UiAction>()
  let theme = workspaceTheme(renderer.themeMode)
  const frame = new BoxRenderable(renderer, {
    id: 'workspace-frame',
    flexGrow: 1,
    flexDirection: 'column',
    border: true,
    borderColor: theme.border,
    backgroundColor: theme.canvas,
  })
  const chrome = new BoxRenderable(renderer, {
    id: 'chrome',
    height: 2,
    flexDirection: 'row',
    paddingX: 1,
    border: ['bottom'],
    borderColor: theme.border,
    backgroundColor: theme.canvas,
  })
  const chromeSpacer = new BoxRenderable(renderer, { flexGrow: 1 })
  const chromeTitle = new TextRenderable(renderer, {
    id: 'chrome-title',
    width: 32,
    height: 1,
    fg: theme.muted,
    truncate: true,
  })
  const row = new BoxRenderable(renderer, { id: 'workspace', flexDirection: 'row', flexGrow: 1 })
  const sidebar = new BoxRenderable(renderer, {
    id: 'sidebar',
    width: 27,
    flexDirection: 'column',
    border: ['right'],
    borderColor: theme.border,
    backgroundColor: theme.surface,
  })
  const body = new BoxRenderable(renderer, { id: 'body', flexGrow: 1, padding: 1 })
  const emptyState = new BoxRenderable(renderer, {
    id: 'empty-state',
    position: 'absolute',
    width: '100%',
    height: '100%',
    zIndex: 2,
    justifyContent: 'center',
    alignItems: 'center',
    visible: false,
  })
  const emptyStateText = new TextRenderable(renderer, {
    id: 'empty-state-text',
    fg: theme.muted,
  })
  const hint = new TextRenderable(renderer, {
    id: 'sidebar-hint',
    position: 'absolute',
    left: 2,
    bottom: 1,
    zIndex: 3,
    wrapMode: 'none',
    truncate: true,
  })
  chrome.add(chromeSpacer)
  chrome.add(chromeTitle)
  frame.add(chrome)
  frame.add(row)
  row.add(sidebar)
  row.add(body)
  emptyState.add(emptyStateText)
  frame.add(hint)
  renderer.root.add(frame)
  const help = createShortcutHelp(renderer, theme)
  renderer.root.add(help)

  const offer = (command: WorkspaceCommand) =>
    Queue.offerUnsafe(actions, { type: 'command', command })
  const panes = definitions.map(
    (definition, index) =>
      new TerminalPane(definition, renderer, index, {
        onData: (name, run, bytes, source) =>
          offer({
            type: 'write',
            name,
            source: source === 'response' ? 'terminalResponse' : 'user',
            bytes,
            run: source === 'response' ? run : undefined,
          }),
        onResize: (name, columns, rows) =>
          offer({ type: 'resize', name, size: normalizeTerminalSize(columns, rows) }),
      }),
  )
  const panesByName = new Map(panes.map((pane) => [pane.definition.name, pane]))
  for (const pane of panes) body.add(pane.terminal)
  body.add(emptyState)
  let snapshot = yield* controller.snapshot
  let pendingSelected = snapshot.selected
  let pendingSidebarVisible = snapshot.sidebarVisible

  const selectedPane = () => panesByName.get(snapshot.selected)
  const selectedSnapshot = () => snapshot.panes.find((pane) => pane.name === snapshot.selected)
  const sectionForPane = (pane: TerminalPane) => {
    const state = snapshot.panes.find((candidate) => candidate.name === pane.definition.name)
    return state ? paneSection(state.lifecycle) : 'idle'
  }
  const orderedPanes = () =>
    sections.flatMap(({ key }) => panes.filter((pane) => sectionForPane(pane) === key))
  const sectionHeaders = new Map(
    sections.map(({ key, label }) => [
      key,
      new TextRenderable(renderer, {
        id: `section-${key}`,
        width: '100%',
        height: 1,
        marginTop: 1,
        paddingLeft: 2,
        content: label,
        fg: theme.muted,
        attributes: 2,
      }),
    ]),
  )
  const sidebarRows = panes.map((pane) => {
    const text = new TextRenderable(renderer, {
      width: '100%',
      height: 1,
      paddingLeft: 1,
      wrapMode: 'none',
      truncate: true,
    })
    const box = new BoxRenderable(renderer, {
      id: `sidebar-${pane.index}`,
      width: '100%',
      height: 1,
      backgroundColor: theme.surface,
      onMouseDown: (event) => {
        if (help.visible || snapshot.mode === 'input') return
        pendingSelected = pane.definition.name
        offer({ type: 'select', name: pane.definition.name })
        event.preventDefault()
        event.stopPropagation()
      },
    })
    box.add(text)
    return { pane, box, text }
  })

  const applyTheme = () => {
    renderer.setBackgroundColor(theme.canvas)
    frame.backgroundColor = theme.canvas
    frame.borderColor = theme.border
    chrome.backgroundColor = theme.canvas
    chrome.borderColor = theme.border
    chromeTitle.fg = theme.muted
    sidebar.backgroundColor = theme.surface
    sidebar.borderColor = theme.border
    emptyStateText.fg = theme.muted
    for (const heading of sectionHeaders.values()) heading.fg = theme.muted
    help.refresh(theme)
  }

  const draw = () => {
    const selected = selectedPane()
    const selectedState = selectedSnapshot()
    if (!selected || !selectedState || chromeTitle.isDestroyed || sidebar.isDestroyed) return
    const input = snapshot.mode === 'input' && selected.terminal.focused
    const title = `${input ? 'INPUT · ' : ''}${selected.definition.title} · cmdz.ts`
    chromeTitle.content = t`${fg(input ? theme.accent : theme.muted)(title)}`
    sidebar.visible = snapshot.sidebarVisible
    sidebar.width = renderer.terminalWidth < 58 ? 20 : 27
    hint.visible = snapshot.sidebarVisible && !help.visible
    hint.content = input
      ? t`${fg(theme.accent)('ctrl-z')} ${fg(theme.muted)('nav')}   ${fg(theme.accent)('ctrl-c')} ${fg(theme.muted)('stop')}   ${fg(theme.accent)('?')} ${fg(theme.muted)('help')}`
      : t`${fg(theme.accent)('q')} ${fg(theme.muted)('quit')}   ${fg(theme.accent)('?')} ${fg(theme.muted)('help')}`
    for (const child of sidebar.getChildren()) sidebar.remove(child)
    for (const { key } of sections) {
      const sectionPanes = panes.filter((pane) => sectionForPane(pane) === key)
      if (sectionPanes.length === 0) continue
      const heading = sectionHeaders.get(key)
      if (heading) sidebar.add(heading)
      for (const pane of sectionPanes) {
        const sidebarRow = sidebarRows.find((candidate) => candidate.pane === pane)
        if (!sidebarRow) continue
        const selectedRow = pane === selected
        sidebarRow.box.backgroundColor = selectedRow ? theme.selected : theme.surface
        const color = statusColor(key, theme)
        const marker = selectedRow ? fg(theme.accent)('›') : fg(theme.surface)('›')
        const title = selectedRow
          ? bold(fg(theme.accent)(pane.definition.title))
          : fg(key === 'idle' ? theme.muted : theme.text)(pane.definition.title)
        sidebarRow.text.content = t`${marker} ${fg(color)('●')} ${title}`
        sidebar.add(sidebarRow.box)
      }
    }
    const outcome =
      selectedState.lifecycle._tag === 'Ready' ? selectedState.lifecycle.outcome : undefined
    emptyState.visible = outcome?._tag === 'Idle' || outcome?._tag === 'StartFailed'
    if (outcome?._tag === 'StartFailed')
      emptyStateText.content = t`${bold(fg(theme.danger)('start failed'))}\n${fg(theme.muted)(outcome.operation)}\n${fg(theme.accent)('Enter retry')}`
    else
      emptyStateText.content = t`${bold(fg(theme.text)(selected.definition.title))}\n${fg(theme.muted)('Enter start')}`
    help.refresh(theme)
    for (const pane of panes) pane.terminal.zIndex = pane === selected ? 1 : 0
  }
  const blur = () => {
    selectedPane()?.terminal.blur()
    offer({ type: 'leaveInput' })
  }
  const bindTerminal = (pane: TerminalPane) => {
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
  applyTheme()
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

  const onKey = (keyEvent: KeyEvent) => {
    const selected = panesByName.get(pendingSelected)
    const state = snapshot.panes.find((pane) => pane.name === pendingSelected)
    if (!selected || !state) return
    if (help.visible) {
      if (keyEvent.name === '?' || keyEvent.name === 'escape') help.visible = false
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      return
    }
    if (selected.terminal.focused) {
      if (keyEvent.ctrl && keyEvent.name === 'z') {
        keyEvent.preventDefault()
        keyEvent.stopPropagation()
        blur()
      }
      return
    }
    if (keyEvent.name === 'return' || keyEvent.name === 'enter') {
      if (state.lifecycle._tag === 'Running') selected.terminal.focus()
      else offer({ type: 'start', name: selected.definition.name, size: selected.size() })
    } else if (['j', 'k', 'up', 'down'].includes(keyEvent.name)) {
      const order = orderedPanes()
      const delta = keyEvent.name === 'j' || keyEvent.name === 'down' ? 1 : -1
      const next = order[order.indexOf(selected) + delta]
      if (next) {
        pendingSelected = next.definition.name
        offer({ type: 'select', name: next.definition.name })
      }
    } else if (keyEvent.name === '?') help.visible = true
    else if (keyEvent.name === 'h') {
      pendingSidebarVisible = !pendingSidebarVisible
      offer({ type: 'setSidebarVisible', visible: pendingSidebarVisible })
    } else if (keyEvent.name === 'x') offer({ type: 'stop', name: selected.definition.name })
    else if (keyEvent.name === 'r')
      offer({ type: 'restart', name: selected.definition.name, size: selected.size() })
    else if (keyEvent.name === 'q' || (keyEvent.ctrl && keyEvent.name === 'c'))
      Queue.offerUnsafe(actions, { type: 'quit' })
    keyEvent.preventDefault()
    keyEvent.stopPropagation()
  }
  const onResize = () => {
    if (renderer.terminalWidth < 72 && pendingSidebarVisible) {
      pendingSidebarVisible = false
      offer({ type: 'setSidebarVisible', visible: false })
    }
    draw()
  }
  const onThemeMode = (mode: ThemeMode) => {
    theme = workspaceTheme(mode)
    applyTheme()
    draw()
  }
  const onDestroy = () => Queue.offerUnsafe(actions, { type: 'quit' })
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      renderer.keyInput.on('keypress', onKey)
      renderer.on('resize', onResize)
      renderer.on('theme_mode', onThemeMode)
      renderer.on('destroy', onDestroy)
    }),
    () =>
      Effect.sync(() => {
        renderer.keyInput.off('keypress', onKey)
        renderer.off('resize', onResize)
        renderer.off('theme_mode', onThemeMode)
        renderer.off('destroy', onDestroy)
      }),
  )

  const initialSizes: Record<string, TerminalSize> = {}
  for (const pane of panes) initialSizes[pane.definition.name] = pane.size()
  yield* runtime.initialize(initialSizes)
  if (renderer.terminalWidth < 72 && pendingSidebarVisible) {
    pendingSidebarVisible = false
    offer({ type: 'setSidebarVisible', visible: false })
  }
  yield* Effect.logInfo('Process workspace ready')
  const run = Effect.gen(function* () {
    while (true) {
      const action = yield* Queue.take(actions)
      if (action.type === 'quit') return
      yield* runtime.dispatch(action.command).pipe(
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
  yield* run.pipe(Effect.onExit(() => runtime.shutdown))
}, Effect.scoped)
