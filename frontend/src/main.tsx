import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppLayout } from '@/components/layout/AppLayout'
import { Dashboard } from '@/modules/dashboard/Dashboard'
import SourcesPage from '@/modules/source/SourcesPage'
import MappingPage from '@/modules/mapping/MappingPage'
import EgressPage from '@/modules/egress/EgressPage'
import WizardPage from '@/modules/wizard/WizardPage'
import AdapterPage from '@/modules/adapter/AdapterPage'
import DevicePage from '@/modules/device/DevicePage'
import LogsPage from '@/modules/logs/LogsPage'
import './index.css'

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter basename="/console">
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="sources"  element={<SourcesPage />} />
            <Route path="adapter"  element={<AdapterPage />} />
            <Route path="mapping"  element={<MappingPage />} />
            <Route path="egress"   element={<EgressPage />} />
            <Route path="device"   element={<DevicePage />} />
            <Route path="logs"     element={<LogsPage />} />
            <Route path="wizard"   element={<WizardPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
