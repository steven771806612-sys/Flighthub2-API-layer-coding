/**
 * useDirtyGuard
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight "unsaved changes" guard that:
 *   1. Hooks `window.beforeunload` to warn on browser refresh / tab close.
 *   2. Exposes `isDirty`, `markDirty()`, `markClean()` for explicit control.
 *   3. Provides a `guardedAction(action, msg?)` helper that shows a confirm
 *      dialog before running `action` when there are unsaved changes.
 *
 * Usage (Mapping page):
 *   const { isDirty, markDirty, markClean, guardedAction } = useDirtyGuard()
 *
 *   // Mark dirty when user edits something
 *   onChange={() => { setValue(v); markDirty() }}
 *
 *   // Guard source switch
 *   const switchSource = (id) =>
 *     guardedAction(() => { setSelected(id); ... })
 *
 *   // Mark clean after save
 *   onSaveSuccess: () => { markClean(); ... }
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_MSG =
  '您有未保存的更改，离开后将丢失。确认要离开吗？'

interface UseDirtyGuardReturn {
  isDirty: boolean
  markDirty: () => void
  markClean: () => void
  /** Run `action` immediately if clean; show confirm dialog if dirty. */
  guardedAction: (action: () => void, message?: string) => void
}

export function useDirtyGuard(): UseDirtyGuardReturn {
  const [isDirty, setIsDirty] = useState(false)
  // Keep a ref so the beforeunload handler always sees the latest value
  const dirtyRef = useRef(false)

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    setIsDirty(true)
  }, [])

  const markClean = useCallback(() => {
    dirtyRef.current = false
    setIsDirty(false)
  }, [])

  // Browser refresh / close guard
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      // Chrome requires returnValue to be set
      e.returnValue = DEFAULT_MSG
      return DEFAULT_MSG
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const guardedAction = useCallback(
    (action: () => void, message = DEFAULT_MSG) => {
      if (!dirtyRef.current) {
        action()
        return
      }
      if (window.confirm(message)) {
        markClean()
        action()
      }
    },
    [markClean],
  )

  return { isDirty, markDirty, markClean, guardedAction }
}
