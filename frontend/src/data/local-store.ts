import { ARRIVAL_KEY } from '@/data/keys'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 存量到货单迁移：老数据没有「到货日期」字段，按到货单顺序回填一个历史日期，保证清单能按日期排。
function backfillArrivalDates(data: Record<string, EntryRow[]>): boolean {
  const rows = data[ARRIVAL_KEY]
  if (!Array.isArray(rows)) {
    return false
  }
  let changed = false
  rows.forEach((row, index) => {
    if (!row['到货日期'] || String(row['到货日期']).trim() === '') {
      const day = String(((index * 3) % 27) + 1).padStart(2, '0')
      row['到货日期'] = `2026-09-${day}`
      changed = true
    }
  })
  return changed
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    backfillArrivalDates(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    // 存量到货单按到货日期回填后落一次盘，下次打开直接生效。
    if (backfillArrivalDates(merged)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    }
    return merged
  } catch {
    backfillArrivalDates(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
