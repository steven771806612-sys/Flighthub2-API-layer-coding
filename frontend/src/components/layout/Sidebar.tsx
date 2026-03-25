import { NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Layers, ArrowRightLeft, Settings, Zap, Cpu, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSourceStore, useMappingStore } from '@/store'
import { sourceService } from '@/services'

const DIRTY_CONFIRM_MSG = '当前 Source 的映射草稿未保存，切换 Source 后草稿仍会保留（每个 Source 独立保存），但未保存的预览结果将会丢失。\n\n确认切换 Source 吗？'

const NAV = [
  { to: '/',        label: 'Dashboard',       icon: LayoutDashboard },
  { to: '/sources', label: 'Sources',          icon: Layers },
  { to: '/mapping', label: 'Visual Mapper',    icon: ArrowRightLeft },
  { to: '/egress',  label: 'Egress',           icon: Settings },
  { to: '/device',  label: 'Devices',          icon: Cpu },
  { to: '/wizard',  label: 'New Integration',  icon: Zap },
]

// ─── Mini source switcher in sidebar ─────────────────────────────────────────
function SourceSwitcher() {
  const { selected, setSelected, setSources, sources } = useSourceStore()
  const { switchSource } = useMappingStore()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Keep source list fresh from backend
  const { data: sourceList } = useQuery({
    queryKey: ['sources'],
    queryFn: sourceService.list,
    staleTime: 30_000,
  })
  useEffect(() => {
    if (sourceList) setSources(sourceList)
  }, [sourceList, setSources])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSelect = (id: string) => {
    if (id === selected) { setOpen(false); return }
    // If mapping draft is dirty, remind the user (drafts persist per-source, but
    // transient preview/normalizedFields will reset on source switch)
    const { isDirty } = useMappingStore.getState()
    if (isDirty) {
      if (!window.confirm(DIRTY_CONFIRM_MSG)) { setOpen(false); return }
    }
    setSelected(id)
    switchSource(id)   // sync mapping store to new source draft
    setOpen(false)
  }

  return (
    <div className="px-3 py-3 border-b border-gray-800">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5 px-1">
        Active Source
      </p>

      {sources.length === 0 ? (
        /* No sources yet — guide user */
        <button
          onClick={() => navigate('/sources')}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-700 text-gray-500 text-xs hover:border-brand-500 hover:text-brand-400 transition-colors"
        >
          <Zap className="w-3.5 h-3.5 shrink-0" />
          Create a source first
        </button>
      ) : (
        <div ref={ref} className="relative">
          {/* Current source badge / trigger */}
          <button
            onClick={() => setOpen(!open)}
            className={clsx(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-mono transition-colors',
              selected
                ? 'bg-brand-700/30 border border-brand-600/40 text-brand-300 hover:bg-brand-700/50'
                : 'bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700',
            )}
          >
            {/* Status dot */}
            <span className={clsx(
              'w-1.5 h-1.5 rounded-full shrink-0',
              selected ? 'bg-brand-400' : 'bg-gray-600',
            )} />
            <span className="flex-1 text-left truncate">
              {selected || '— select source —'}
            </span>
            <ChevronDown className={clsx('w-3 h-3 shrink-0 transition-transform', open && 'rotate-180')} />
          </button>

          {/* Dropdown */}
          {open && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
              {sources.map((s) => (
                <button
                  key={s}
                  onClick={() => handleSelect(s)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-left transition-colors',
                    s === selected
                      ? 'bg-brand-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800',
                  )}
                >
                  <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', s === selected ? 'bg-white' : 'bg-gray-600')} />
                  {s}
                </button>
              ))}
              <div className="border-t border-gray-800">
                <button
                  onClick={() => { setOpen(false); navigate('/sources') }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
                >
                  <Layers className="w-3 h-3" /> Manage Sources
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 h-screen sticky top-0 bg-gray-950 text-gray-300 flex flex-col">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white text-sm leading-tight">
            FlightHub<br />
            <span className="text-gray-400 font-normal">Webhook Transformer</span>
          </span>
        </div>
      </div>

      {/* Global source context switcher */}
      <SourceSwitcher />

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5 overflow-y-auto">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-brand-600 text-white'
                  : 'hover:bg-gray-800 hover:text-white',
              )
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-800 text-xs text-gray-500">
        v0.5 · DJI FlightHub2
        <div className="mt-1 font-mono break-all text-gray-600 text-[10px]">POST /webhook</div>
      </div>
    </aside>
  )
}
