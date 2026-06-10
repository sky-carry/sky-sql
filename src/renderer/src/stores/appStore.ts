import { create } from 'zustand'
import type { ConnectionProfile, DbObjectInfo, DbType } from '@shared/types'

export type ObjectCategory = 'tables' | 'views' | 'functions' | 'users'

export type TabKind = 'objects' | 'table' | 'query' | 'design' | 'sync' | 'transfer' | 'datasync'

export interface TabState {
  id: string
  kind: TabKind
  title: string
  profileId?: string
  database?: string
  table?: string
}

export interface ConnState {
  databases: string[]
  serverVersion: string
  /** database -> 对象列表 */
  objects: Record<string, DbObjectInfo[]>
}

export interface ConnDialogState {
  open: boolean
  dbType: DbType
  /** 编辑已有连接时传入 */
  profile?: ConnectionProfile
}

export interface TransferDialogState {
  open: boolean
  profileId?: string
  database?: string
  table?: string
}

interface AppState {
  profiles: ConnectionProfile[]
  connections: Record<string, ConnState>
  tabs: TabState[]
  activeTabId: string
  theme: 'light' | 'dark'
  category: ObjectCategory
  current: { profileId?: string; database?: string }
  status: string
  connDialog: ConnDialogState
  exportDialog: TransferDialogState
  importDialog: TransferDialogState

  openExportDialog(profileId: string, database: string, table: string): void
  closeExportDialog(): void
  openImportDialog(profileId: string, database: string, table?: string): void
  closeImportDialog(): void
  backupDialog: TransferDialogState
  restoreDialog: TransferDialogState
  openBackupDialog(profileId: string, database: string): void
  closeBackupDialog(): void
  openRestoreDialog(profileId: string, database: string): void
  closeRestoreDialog(): void

  loadProfiles(): Promise<void>
  openConnection(profileId: string): Promise<void>
  closeConnection(profileId: string): Promise<void>
  loadObjects(profileId: string, database: string, force?: boolean): Promise<void>
  setCurrent(profileId?: string, database?: string): void
  openTableTab(profileId: string, database: string, table: string): void
  openQueryTab(profileId?: string, database?: string): void
  openDesignTab(profileId: string, database: string, table?: string): void
  openSyncTab(): void
  openTransferTab(): void
  openDataSyncTab(): void
  updateTab(id: string, patch: Partial<TabState>): void
  closeTab(id: string): void
  setActiveTab(id: string): void
  setTheme(theme: 'light' | 'dark'): void
  setCategory(category: ObjectCategory): void
  setStatus(status: string): void
  openConnDialog(state: Omit<ConnDialogState, 'open'>): void
  closeConnDialog(): void
}

let queryCounter = 0
let designCounter = 0

export const useAppStore = create<AppState>((set, get) => ({
  profiles: [],
  connections: {},
  tabs: [{ id: 'objects', kind: 'objects', title: '对象' }],
  activeTabId: 'objects',
  theme: (localStorage.getItem('skysql.theme') as 'light' | 'dark') || 'light',
  category: 'tables',
  current: {},
  status: '就绪',
  connDialog: { open: false, dbType: 'mysql' },
  exportDialog: { open: false },
  importDialog: { open: false },

  openExportDialog: (profileId, database, table) =>
    set({ exportDialog: { open: true, profileId, database, table } }),
  closeExportDialog: () => set({ exportDialog: { open: false } }),
  openImportDialog: (profileId, database, table) =>
    set({ importDialog: { open: true, profileId, database, table } }),
  closeImportDialog: () => set({ importDialog: { open: false } }),
  backupDialog: { open: false },
  restoreDialog: { open: false },
  openBackupDialog: (profileId, database) =>
    set({ backupDialog: { open: true, profileId, database } }),
  closeBackupDialog: () => set({ backupDialog: { open: false } }),
  openRestoreDialog: (profileId, database) =>
    set({ restoreDialog: { open: true, profileId, database } }),
  closeRestoreDialog: () => set({ restoreDialog: { open: false } }),

  loadProfiles: async () => {
    set({ profiles: await window.skysql.profiles.list() })
  },

  openConnection: async (profileId) => {
    const res = await window.skysql.conn.open(profileId)
    set((s) => ({
      connections: {
        ...s.connections,
        [profileId]: { databases: res.databases, serverVersion: res.serverVersion, objects: {} }
      }
    }))
  },

  closeConnection: async (profileId) => {
    await window.skysql.conn.close(profileId)
    set((s) => {
      const connections = { ...s.connections }
      delete connections[profileId]
      const tabs = s.tabs.filter((t) => t.kind === 'objects' || t.profileId !== profileId)
      const activeTabId = tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : 'objects'
      const current = s.current.profileId === profileId ? {} : s.current
      return { connections, tabs, activeTabId, current }
    })
  },

  loadObjects: async (profileId, database, force = false) => {
    const conn = get().connections[profileId]
    if (!conn) return
    if (!force && conn.objects[database]) return
    const objects = await window.skysql.conn.listObjects(profileId, database)
    set((s) => {
      const c = s.connections[profileId]
      if (!c) return s
      return {
        connections: {
          ...s.connections,
          [profileId]: { ...c, objects: { ...c.objects, [database]: objects } }
        }
      }
    })
  },

  setCurrent: (profileId, database) => set({ current: { profileId, database } }),

  openTableTab: (profileId, database, table) => {
    const id = `table:${profileId}:${database}:${table}`
    set((s) => {
      if (s.tabs.some((t) => t.id === id)) return { activeTabId: id }
      return {
        tabs: [...s.tabs, { id, kind: 'table' as const, title: table, profileId, database, table }],
        activeTabId: id
      }
    })
  },

  openQueryTab: (profileId, database) => {
    const cur = get().current
    queryCounter += 1
    const id = `query:${queryCounter}`
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: 'query' as const,
          title: `查询 ${queryCounter}`,
          profileId: profileId ?? cur.profileId,
          database: database ?? cur.database
        }
      ],
      activeTabId: id
    }))
  },

  openDesignTab: (profileId, database, table) => {
    const id = table
      ? `design:${profileId}:${database}:${table}`
      : `design:new:${++designCounter}`
    set((s) => {
      if (s.tabs.some((t) => t.id === id)) return { activeTabId: id }
      return {
        tabs: [
          ...s.tabs,
          {
            id,
            kind: 'design' as const,
            title: table ? `设计表 ${table}` : '新建表',
            profileId,
            database,
            table
          }
        ],
        activeTabId: id
      }
    })
  },

  openSyncTab: () => {
    const id = 'sync:struct'
    set((s) => {
      if (s.tabs.some((t) => t.id === id)) return { activeTabId: id }
      return {
        tabs: [...s.tabs, { id, kind: 'sync' as const, title: '结构同步' }],
        activeTabId: id
      }
    })
  },

  openTransferTab: () => {
    const id = 'transfer:data'
    set((s) => {
      if (s.tabs.some((t) => t.id === id)) return { activeTabId: id }
      return {
        tabs: [...s.tabs, { id, kind: 'transfer' as const, title: '数据传输' }],
        activeTabId: id
      }
    })
  },

  openDataSyncTab: () => {
    const id = 'sync:data'
    set((s) => {
      if (s.tabs.some((t) => t.id === id)) return { activeTabId: id }
      return {
        tabs: [...s.tabs, { id, kind: 'datasync' as const, title: '数据同步' }],
        activeTabId: id
      }
    })
  },

  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  closeTab: (id) => {
    if (id === 'objects') return
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs[Math.max(0, idx - 1)]?.id ?? 'objects') : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  setTheme: (theme) => {
    localStorage.setItem('skysql.theme', theme)
    set({ theme })
  },

  setCategory: (category) => set({ category, activeTabId: 'objects' }),
  setStatus: (status) => set({ status }),

  openConnDialog: (state) => set({ connDialog: { ...state, open: true } }),
  closeConnDialog: () => set((s) => ({ connDialog: { ...s.connDialog, open: false, profile: undefined } }))
}))
