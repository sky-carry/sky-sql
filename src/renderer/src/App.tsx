import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp, ConfigProvider, Tabs, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useAppStore } from '@/stores/appStore'
import { MainToolbar } from '@/components/MainToolbar'
import { ConnectionTree } from '@/components/ConnectionTree'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { ExportDialog } from '@/components/ExportDialog'
import { ImportDialog } from '@/components/ImportDialog'
import { BackupDialog } from '@/components/BackupDialog'
import { RestoreDialog } from '@/components/RestoreDialog'
import { StatusBar } from '@/components/StatusBar'
import { ObjectsTab } from '@/components/tabs/ObjectsTab'
import { TableDataTab } from '@/components/tabs/TableDataTab'
import { QueryTab } from '@/components/tabs/QueryTab'
import { TableDesignTab } from '@/components/tabs/TableDesignTab'
import { StructSyncTab } from '@/components/tabs/StructSyncTab'
import { DataTransferTab } from '@/components/tabs/DataTransferTab'
import { DataSyncTab } from '@/components/tabs/DataSyncTab'

function Workspace(): React.JSX.Element {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)

  return (
    <Tabs
      type="editable-card"
      hideAdd
      size="small"
      className="workspace-tabs"
      activeKey={activeTabId}
      onChange={setActiveTab}
      onEdit={(key, action) => {
        if (action === 'remove' && typeof key === 'string') closeTab(key)
      }}
      items={tabs.map((tab) => ({
        key: tab.id,
        label: tab.title,
        closable: tab.id !== 'objects',
        children:
          tab.kind === 'objects' ? (
            <ObjectsTab />
          ) : tab.kind === 'table' ? (
            <TableDataTab tab={tab} />
          ) : tab.kind === 'design' ? (
            <TableDesignTab tab={tab} />
          ) : tab.kind === 'sync' ? (
            <StructSyncTab />
          ) : tab.kind === 'transfer' ? (
            <DataTransferTab />
          ) : tab.kind === 'datasync' ? (
            <DataSyncTab />
          ) : (
            <QueryTab tab={tab} />
          )
      }))}
    />
  )
}

function Shell(): React.JSX.Element {
  const loadProfiles = useAppStore((s) => s.loadProfiles)
  const [treeWidth, setTreeWidth] = useState(260)
  const dragging = useRef(false)

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  const onSplitterDown = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: MouseEvent): void => {
      if (dragging.current) setTreeWidth(Math.min(Math.max(ev.clientX, 170), 520))
    }
    const onUp = (): void => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  return (
    <div className="app-shell">
      <MainToolbar />
      <div className="app-body">
        <div className="app-sidebar" style={{ width: treeWidth }}>
          <ConnectionTree />
        </div>
        <div className="app-splitter" onMouseDown={onSplitterDown} />
        <div className="app-workspace">
          <Workspace />
        </div>
      </div>
      <StatusBar />
      <ConnectionDialog />
      <ExportDialog />
      <ImportDialog />
      <BackupDialog />
      <RestoreDialog />
    </div>
  )
}

export default function App(): React.JSX.Element {
  const theme = useAppStore((s) => s.theme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#0a87c4',
          borderRadius: 4
        }
      }}
    >
      <AntApp className="ant-app-host">
        <Shell />
      </AntApp>
    </ConfigProvider>
  )
}
