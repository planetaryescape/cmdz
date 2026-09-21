import type { ThemeMode } from '@opentui/core'

/** Semantic colors for cmdz-owned chrome. Child terminals keep their own palette. */
export interface WorkspaceTheme {
  readonly canvas: string
  readonly surface: string
  readonly selected: string
  readonly border: string
  readonly text: string
  readonly muted: string
  readonly accent: string
  readonly info: string
  readonly running: string
  readonly pending: string
  readonly danger: string
}

const dark: WorkspaceTheme = {
  canvas: '#071c20',
  surface: '#0b2428',
  selected: '#263a2c',
  border: '#1f4b52',
  text: '#d9e7e5',
  muted: '#72989d',
  accent: '#d7f34a',
  info: '#61d4d6',
  running: '#d7f34a',
  pending: '#f0c86a',
  danger: '#ff6b6b',
}

const light: WorkspaceTheme = {
  canvas: '#ffffff',
  surface: '#f4f7fa',
  selected: '#ddeeff',
  border: '#cbd5e1',
  text: '#18212f',
  muted: '#5f6b7a',
  accent: '#547000',
  info: '#007ea8',
  running: '#147d4f',
  pending: '#8a5c00',
  danger: '#b4233a',
}

export function workspaceTheme(mode: ThemeMode | null): WorkspaceTheme {
  return mode === 'light' ? light : dark
}
