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
  readonly running: string
  readonly pending: string
  readonly danger: string
}

const dark: WorkspaceTheme = {
  canvas: '#0b0f14',
  surface: '#111821',
  selected: '#193149',
  border: '#2a3645',
  text: '#e6edf3',
  muted: '#8b98a7',
  accent: '#5cc8ff',
  running: '#4fd18b',
  pending: '#d6a84b',
  danger: '#ff6b7a',
}

const light: WorkspaceTheme = {
  canvas: '#ffffff',
  surface: '#f4f7fa',
  selected: '#ddeeff',
  border: '#cbd5e1',
  text: '#18212f',
  muted: '#5f6b7a',
  accent: '#007ea8',
  running: '#147d4f',
  pending: '#8a5c00',
  danger: '#b4233a',
}

export function workspaceTheme(mode: ThemeMode | null): WorkspaceTheme {
  return mode === 'light' ? light : dark
}
