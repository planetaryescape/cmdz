import { normalizeTerminalSize, type TerminalSize } from '@cmdz/core/process-driver'
import {
  renderStatus,
  type PaneLifecycle,
  type WorkspaceCommand,
  type WorkspaceController,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from '@cmdz/core/workspace'
import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import { createWorkspaceRuntime } from '@cmdz/core/workspace-runtime'
import {
  bg,
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

interface StatusAppearance {
  readonly symbol: string
  readonly color: string
}

function statusAppearance(lifecycle: PaneLifecycle, theme: WorkspaceTheme): StatusAppearance {
  switch (lifecycle._tag) {
    case 'Starting':
      return { symbol: '◐', color: theme.pending }
    case 'Running':
      return { symbol: '●', color: theme.running }
    case 'Cleaning':
      return lifecycle.cleanup._tag === 'Failed'
        ? { symbol: '!', color: theme.danger }
        : { symbol: '◐', color: theme.pending }
    case 'Ready':
      switch (lifecycle.outcome._tag) {
        case 'Idle':
          return { symbol: '○', color: theme.muted }
        case 'Stopped':
          return { symbol: '■', color: theme.muted }
        case 'Succeeded':
          return { symbol: '✓', color: theme.running }
        case 'StartFailed':
        case 'RuntimeFailed':
        case 'Exited':
          return { symbol: '!', color: theme.danger }
      }
  }
}

function key(theme: WorkspaceTheme, value: string) {
  return bold(bg(theme.selected)(fg(theme.text)(` ${value} `)))
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
  const header = new BoxRenderable(renderer, {
    id: 'header',
    height: 1,
    paddingX: 1,
    backgroundColor: theme.surface,
  })
  const headerText = new TextRenderable(renderer, {
    id: 'status',
    width: '100%',
    height: 1,
    fg: theme.text,
    truncate: true,
  })
  const footer = new BoxRenderable(renderer, {
    id: 'footer',
    height: 1,
    paddingX: 1,
    backgroundColor: theme.surface,
  })
  const footerText = new TextRenderable(renderer, {
    id: 'help',
    width: '100%',
    height: 1,
    fg: theme.muted,
    truncate: true,
  })
  const row = new BoxRenderable(renderer, { id: 'workspace', flexDirection: 'row', flexGrow: 1 })
  const sidebar = new BoxRenderable(renderer, {
    id: 'sidebar',
    width: 22,
    flexDirection: 'column',
    border: ['right'],
    borderColor: theme.border,
    backgroundColor: theme.surface,
  })
  const sidebarTitle = new TextRenderable(renderer, {
    id: 'sidebar-title',
    width: '100%',
    height: 2,
    content: t`${fg(theme.muted)(` COMMANDS · ${definitions.length}`)}`,
    truncate: true,
  })
  const body = new BoxRenderable(renderer, { id: 'body', flexGrow: 1 })
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
  header.add(headerText)
  footer.add(footerText)
  sidebar.add(sidebarTitle)
  emptyState.add(emptyStateText)
  renderer.root.add(header)
  renderer.root.add(row)
  row.add(sidebar)
  row.add(body)
  renderer.root.add(footer)
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
  const sidebarRows = panes.map((pane) => {
    const text = new TextRenderable(renderer, {
      width: '100%',
      height: 2,
      paddingLeft: 1,
      wrapMode: 'none',
      truncate: true,
    })
    const box = new BoxRenderable(renderer, {
      id: `sidebar-${pane.index}`,
      width: '100%',
      height: 2,
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
    sidebar.add(box)
    return { pane, box, text }
  })

  const applyTheme = () => {
    header.backgroundColor = theme.surface
    headerText.fg = theme.text
    footer.backgroundColor = theme.surface
    footerText.fg = theme.muted
    sidebar.backgroundColor = theme.surface
    sidebar.borderColor = theme.border
    sidebarTitle.content = t`${fg(theme.muted)(` COMMANDS · ${definitions.length}`)}`
    emptyStateText.fg = theme.muted
    help.refresh(theme)
  }

  const drawFooter = (input: boolean, cleanupFailed: boolean) => {
    if (input) {
      footerText.content =
        renderer.terminalWidth < 80
          ? t`${key(theme, '^Z')}${fg(theme.muted)(' Nav  ')}${key(theme, '^C')}${fg(theme.muted)(' Interrupt')}`
          : t`${key(theme, 'Ctrl-Z')}${fg(theme.muted)(' Navigation  ')}${key(theme, 'Ctrl-C')}${fg(theme.muted)(' Interrupt child')}`
      return
    }
    if (renderer.terminalWidth < 80) {
      footerText.content = t`${key(theme, 'Enter')}${fg(theme.muted)(' Open  ')}${key(theme, 'h')}${fg(theme.muted)(' Commands  ')}${key(theme, '?')}${fg(theme.muted)(' Help')}`
      return
    }
    footerText.content = cleanupFailed
      ? t`${key(theme, 'x')}${fg(theme.muted)(' Retry cleanup  ')}${key(theme, 'r')}${fg(theme.muted)(' Retry + restart  ')}${key(theme, '?')}${fg(theme.muted)(' Help')}`
      : t`${key(theme, '↑↓')}${fg(theme.muted)(' Select  ')}${key(theme, 'Enter')}${fg(theme.muted)(' Open  ')}${key(theme, 'x')}${fg(theme.muted)(' Stop  ')}${key(theme, 'r')}${fg(theme.muted)(' Restart  ')}${key(theme, '?')}${fg(theme.muted)(' Help')}`
  }

  const draw = () => {
    const selected = selectedPane()
    const selectedState = selectedSnapshot()
    if (
      !selected ||
      !selectedState ||
      headerText.isDestroyed ||
      sidebar.isDestroyed ||
      footerText.isDestroyed
    )
      return
    const input = snapshot.mode === 'input' && selected.terminal.focused
    const cleanupFailed =
      selectedState.lifecycle._tag === 'Cleaning' &&
      selectedState.lifecycle.cleanup._tag === 'Failed'
    const status = renderStatus(selectedState.lifecycle)
    const statusStyle = statusAppearance(selectedState.lifecycle, theme)
    const prefix = renderer.terminalWidth < 58 ? '' : 'cmdz / '
    header.backgroundColor = input ? theme.selected : theme.surface
    footer.backgroundColor = input ? theme.selected : theme.surface
    headerText.content = t`${bold(fg(theme.accent)(prefix))}${bold(fg(theme.text)(selected.definition.title))}${fg(theme.muted)(' [')}${fg(statusStyle.color)(status)}${fg(theme.muted)(']  ')}${bold(fg(input ? theme.accent : theme.muted)(input ? 'INPUT' : 'NAVIGATION'))}`
    drawFooter(input, cleanupFailed)
    sidebar.visible = snapshot.sidebarVisible
    sidebar.width = renderer.terminalWidth < 58 ? 18 : 22
    for (const { pane, box, text } of sidebarRows) {
      const state = snapshot.panes.find((candidate) => candidate.name === pane.definition.name)
      const selectedRow = pane === selected
      const appearance = state ? statusAppearance(state.lifecycle, theme) : undefined
      const label = state ? renderStatus(state.lifecycle) : 'idle'
      box.backgroundColor = selectedRow ? theme.selected : theme.surface
      const title = selectedRow
        ? bold(fg(theme.text)(pane.definition.title))
        : fg(theme.text)(pane.definition.title)
      text.content = t`${title}\n${fg(appearance?.color ?? theme.muted)(` ${appearance?.symbol ?? '○'} ${label}`)}`
    }
    const outcome =
      selectedState.lifecycle._tag === 'Ready' ? selectedState.lifecycle.outcome : undefined
    emptyState.visible = outcome?._tag === 'Idle' || outcome?._tag === 'StartFailed'
    if (outcome?._tag === 'StartFailed')
      emptyStateText.content = t`${bold(fg(theme.danger)('! start failed'))}\n${fg(theme.muted)(outcome.operation)}\n${fg(theme.text)('Enter retry')}`
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
      const delta = keyEvent.name === 'j' || keyEvent.name === 'down' ? 1 : -1
      const next = panes[panes.indexOf(selected) + delta]
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
