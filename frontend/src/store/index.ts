import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WizardStep, VisualMapping, FH2Body } from '@/types'

// ─── Auth / session store ─────────────────────────────────────────────────────
interface AuthStore {
  adminToken: string
  setAdminToken: (t: string) => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  adminToken: localStorage.getItem('admin_token') ?? '',
  setAdminToken: (t) => {
    localStorage.setItem('admin_token', t)
    set({ adminToken: t })
  },
}))

// ─── Source store — persisted ─────────────────────────────────────────────────
// `selected` survives page refresh so users don't re-pick source on every visit.
interface SourceStore {
  sources: string[]
  /** Currently active source — persisted in localStorage */
  selected: string
  setSources: (s: string[]) => void
  setSelected: (s: string) => void
}

export const useSourceStore = create<SourceStore>()(
  persist(
    (set) => ({
      sources: [],
      selected: '',
      setSources: (sources) => set({ sources }),
      setSelected: (selected) => set({ selected }),
    }),
    {
      name: 'fh2-source-ctx',
      // Only persist `selected`; `sources` is always re-fetched from backend
      partialize: (s) => ({ selected: s.selected }),
    },
  ),
)

// ─── Wizard store ─────────────────────────────────────────────────────────────
const WIZARD_ORDER: WizardStep[] = [
  'create_source',
  'configure_auth',
  'configure_mapping',
  'configure_egress',
  'test',
]

interface WizardStore {
  active: boolean
  sourceId: string
  currentStep: WizardStep
  completedSteps: Set<WizardStep>
  startWizard: (sourceId?: string) => void
  completeStep: (step: WizardStep) => void
  goToStep: (step: WizardStep) => void
  closeWizard: () => void
  canProceed: () => boolean
}

interface WizardStorePersisted {
  active: boolean
  sourceId: string
  currentStep: WizardStep
  completedStepsArr: WizardStep[]
}

export const useWizardStore = create<WizardStore>()(
  persist(
    (set, get) => ({
      active: false,
      sourceId: '',
      currentStep: 'create_source',
      completedSteps: new Set<WizardStep>(),

      startWizard: (sourceId = '') =>
        set((state) => {
          const isSameSource = sourceId && state.sourceId === sourceId
          const existingCompleted = isSameSource ? state.completedSteps : new Set<WizardStep>()
          const completedSteps = sourceId
            ? new Set<WizardStep>([...existingCompleted, 'create_source'])
            : new Set<WizardStep>()
          return {
            active: true,
            sourceId,
            currentStep: sourceId ? (isSameSource ? state.currentStep : 'configure_auth') : 'create_source',
            completedSteps,
          }
        }),

      completeStep: (step) => {
        const { completedSteps } = get()
        const next = WIZARD_ORDER[WIZARD_ORDER.indexOf(step) + 1]
        set({
          completedSteps: new Set([...completedSteps, step]),
          currentStep: next ?? step,
        })
      },

      goToStep: (step) => set({ currentStep: step }),

      closeWizard: () =>
        set({ active: false, sourceId: '', currentStep: 'create_source', completedSteps: new Set() }),

      canProceed: () => {
        const { currentStep, completedSteps } = get()
        return completedSteps.has(currentStep)
      },
    }),
    {
      name: 'fh2-wizard-state',
      partialize: (s) => ({
        active: s.active,
        sourceId: s.sourceId,
        currentStep: s.currentStep,
        completedStepsArr: [...s.completedSteps],
      } as WizardStorePersisted),
      merge: (persisted, current) => {
        const p = persisted as WizardStorePersisted
        return {
          ...current,
          active: p.active ?? false,
          sourceId: p.sourceId ?? '',
          currentStep: p.currentStep ?? 'create_source',
          completedSteps: new Set<WizardStep>(p.completedStepsArr ?? []),
        }
      },
    }
  )
)

// ─── UI / notification store ──────────────────────────────────────────────────
export type ToastType = 'success' | 'error' | 'info'

interface Toast {
  id: string
  type: ToastType
  message: string
}

interface UIStore {
  toasts: Toast[]
  addToast: (type: ToastType, message: string) => void
  removeToast: (id: string) => void
}

export const useUIStore = create<UIStore>((set, get) => ({
  toasts: [],
  addToast: (type, message) => {
    const id = `${Date.now()}-${Math.random()}`
    set({ toasts: [...get().toasts, { id, type, message }] })
    setTimeout(() => get().removeToast(id), 4000)
  },
  removeToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

// ─── Visual Mapping store — per-source isolated ───────────────────────────────
// Draft mapping and sample payload are keyed by sourceId so different sources
// never share the same draft. Switching source automatically loads that source's
// own draft (or empty defaults).
//
// Schema of persisted data:
//   drafts: { [sourceId]: { mapping: VisualMapping, samplePayload: string } }

interface SourceDraft {
  mapping: VisualMapping
  samplePayload: string
}

const DEFAULT_SAMPLE = JSON.stringify({
  timestamp: '2026-03-19T10:00:00Z',
  creator_id: 'pilot01',
  latitude: 22.543096,
  longitude: 114.057865,
  level: 'warning',
  description: 'obstacle detected',
  Event: { Name: 'VMD', Source: { Id: 'DJI-001' }, Level: 'warning' },
}, null, 2)

const EMPTY_DRAFT = (): SourceDraft => ({
  mapping: {},
  samplePayload: DEFAULT_SAMPLE,
})

interface MappingStore {
  /** Current active sourceId — used to look up the draft */
  activeSourceId: string
  /** Per-source drafts  { [sourceId]: SourceDraft } */
  drafts: Record<string, SourceDraft>
  /** Whether draft differs from last-saved snapshot (dirty flag) */
  isDirty: boolean
  /** Snapshot of the last-saved mapping per source (for dirty comparison) */
  savedSnapshots: Record<string, string>   // sourceId → JSON string of mapping

  // Derived: current source's draft (read-only shortcuts)
  mapping: VisualMapping
  samplePayload: string

  // Non-persisted runtime state
  normalizedFields: string[]
  preview: FH2Body | null
  missing: string[]

  // Actions
  /** Call when the active source changes — loads or initialises the correct draft */
  switchSource: (sourceId: string) => void
  setMapping: (m: VisualMapping) => void
  setMappingField: (src: string, dst: string) => void
  clearMappingField: (src: string) => void
  setSamplePayload: (s: string) => void
  /** Call after a successful Save to clear dirty flag */
  markSaved: () => void
  setNormalizedFields: (fields: string[]) => void
  setPreview: (body: FH2Body | null) => void
  setMissing: (m: string[]) => void
  resetMapping: () => void
}

export const useMappingStore = create<MappingStore>()(
  persist(
    (set, get) => {
      // Helper: update the active source's draft and recalculate isDirty
      const patchDraft = (patch: Partial<SourceDraft>) => {
        const { activeSourceId, drafts, savedSnapshots } = get()
        if (!activeSourceId) return
        const current = drafts[activeSourceId] ?? EMPTY_DRAFT()
        const next: SourceDraft = { ...current, ...patch }
        const snapshot = savedSnapshots[activeSourceId] ?? ''
        const isDirty = JSON.stringify(next.mapping) !== snapshot
        set({
          drafts: { ...drafts, [activeSourceId]: next },
          mapping: next.mapping,
          samplePayload: next.samplePayload,
          isDirty,
        })
      }

      return {
        activeSourceId: '',
        drafts: {},
        isDirty: false,
        savedSnapshots: {},

        // Derived shortcuts — synced from active draft
        mapping: {},
        samplePayload: DEFAULT_SAMPLE,

        // Runtime (never persisted)
        normalizedFields: [],
        preview: null,
        missing: [],

        switchSource: (sourceId) => {
          if (!sourceId) {
            set({ activeSourceId: '', mapping: {}, samplePayload: DEFAULT_SAMPLE, isDirty: false })
            return
          }
          const { drafts, savedSnapshots } = get()
          const draft = drafts[sourceId] ?? EMPTY_DRAFT()
          const snapshot = savedSnapshots[sourceId] ?? ''
          set({
            activeSourceId: sourceId,
            mapping: draft.mapping,
            samplePayload: draft.samplePayload,
            isDirty: JSON.stringify(draft.mapping) !== snapshot,
            // Reset runtime state when switching source
            normalizedFields: [],
            preview: null,
            missing: [],
          })
        },

        setMapping: (mapping) => patchDraft({ mapping }),
        setMappingField: (src, dst) => {
          const { mapping } = get()
          patchDraft({ mapping: { ...mapping, [src]: dst } })
        },
        clearMappingField: (src) => {
          const { mapping } = get()
          const next = { ...mapping }
          delete next[src]
          patchDraft({ mapping: next })
        },
        setSamplePayload: (samplePayload) => patchDraft({ samplePayload }),

        markSaved: () => {
          const { activeSourceId, mapping, savedSnapshots } = get()
          if (!activeSourceId) return
          const snap = JSON.stringify(mapping)
          set({ isDirty: false, savedSnapshots: { ...savedSnapshots, [activeSourceId]: snap } })
        },

        setNormalizedFields: (normalizedFields) => set({ normalizedFields }),
        setPreview: (preview) => set({ preview }),
        setMissing: (missing) => set({ missing }),

        resetMapping: () => {
          const { activeSourceId, drafts, savedSnapshots } = get()
          if (!activeSourceId) return
          const empty = EMPTY_DRAFT()
          set({
            drafts: { ...drafts, [activeSourceId]: empty },
            mapping: empty.mapping,
            samplePayload: empty.samplePayload,
            isDirty: false,
            savedSnapshots: { ...savedSnapshots, [activeSourceId]: '' },
            preview: null,
            missing: [],
          })
        },
      }
    },
    {
      name: 'fh2-mapping-drafts',
      // Only persist the draft data and saved snapshots; runtime state is excluded
      partialize: (s) => ({
        activeSourceId: s.activeSourceId,
        drafts: s.drafts,
        savedSnapshots: s.savedSnapshots,
      }),
      // On hydration, restore derived shortcuts from the active draft
      merge: (persisted, current) => {
        const p = persisted as Pick<MappingStore, 'activeSourceId' | 'drafts' | 'savedSnapshots'>
        const draft = p.activeSourceId ? (p.drafts?.[p.activeSourceId] ?? EMPTY_DRAFT()) : EMPTY_DRAFT()
        const snapshot = p.activeSourceId ? (p.savedSnapshots?.[p.activeSourceId] ?? '') : ''
        return {
          ...current,
          activeSourceId: p.activeSourceId ?? '',
          drafts: p.drafts ?? {},
          savedSnapshots: p.savedSnapshots ?? {},
          mapping: draft.mapping,
          samplePayload: draft.samplePayload,
          isDirty: JSON.stringify(draft.mapping) !== snapshot,
        }
      },
    },
  ),
)
