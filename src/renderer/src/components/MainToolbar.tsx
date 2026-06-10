import { Dropdown, Tooltip } from 'antd'
import {
  Archive,
  BarChart3,
  Clock,
  Code,
  Database,
  Eye,
  GitCompareArrows,
  Moon,
  Network,
  Plug,
  Send,
  Sun,
  Table,
  User
} from 'lucide-react'
import { DB_TYPE_LABELS, type DbType } from '@shared/types'
import { useAppStore, type ObjectCategory } from '@/stores/appStore'

interface BigButtonProps {
  icon: React.ReactNode
  label: string
  active?: boolean
  disabled?: boolean
  disabledTip?: string
  onClick?: () => void
}

function BigButton({ icon, label, active, disabled, disabledTip, onClick }: BigButtonProps): React.JSX.Element {
  const btn = (
    <button
      className={`toolbar-btn${active ? ' active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="toolbar-btn-icon">{icon}</span>
      <span className="toolbar-btn-label">{label}</span>
    </button>
  )
  return disabled && disabledTip ? <Tooltip title={disabledTip}>{btn}</Tooltip> : btn
}

const CATEGORY_BUTTONS: { key: ObjectCategory; label: string; icon: React.ReactNode }[] = [
  { key: 'tables', label: '表', icon: <Table size={22} /> },
  { key: 'views', label: '视图', icon: <Eye size={22} /> },
  { key: 'functions', label: '函数', icon: <Code size={22} /> },
  { key: 'users', label: '用户', icon: <User size={22} /> }
]

export function MainToolbar(): React.JSX.Element {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const category = useAppStore((s) => s.category)
  const setCategory = useAppStore((s) => s.setCategory)
  const current = useAppStore((s) => s.current)
  const openQueryTab = useAppStore((s) => s.openQueryTab)
  const openConnDialog = useAppStore((s) => s.openConnDialog)
  const openBackupDialog = useAppStore((s) => s.openBackupDialog)
  const openRestoreDialog = useAppStore((s) => s.openRestoreDialog)
  const openSyncTab = useAppStore((s) => s.openSyncTab)
  const openTransferTab = useAppStore((s) => s.openTransferTab)
  const openDataSyncTab = useAppStore((s) => s.openDataSyncTab)
  const connections = useAppStore((s) => s.connections)

  const connMenuItems = (Object.keys(DB_TYPE_LABELS) as DbType[]).map((t) => ({
    key: t,
    label: DB_TYPE_LABELS[t],
    onClick: () => openConnDialog({ dbType: t })
  }))

  return (
    <div className="main-toolbar">
      <Dropdown menu={{ items: connMenuItems }} trigger={['click']}>
        <button className="toolbar-btn" type="button">
          <span className="toolbar-btn-icon">
            <Plug size={22} />
          </span>
          <span className="toolbar-btn-label">连接</span>
        </button>
      </Dropdown>
      <BigButton
        icon={<Database size={22} />}
        label="新建查询"
        disabled={!current.profileId}
        disabledTip="请先在左侧打开一个连接"
        onClick={() => openQueryTab()}
      />
      <div className="toolbar-sep" />
      {CATEGORY_BUTTONS.map((b) => (
        <BigButton
          key={b.key}
          icon={b.icon}
          label={b.label}
          active={category === b.key}
          onClick={() => setCategory(b.key)}
        />
      ))}
      <div className="toolbar-sep" />
      <Dropdown
        disabled={!current.profileId || !current.database}
        menu={{
          items: [
            {
              key: 'backup',
              label: '备份数据库...',
              onClick: () => openBackupDialog(current.profileId!, current.database!)
            },
            {
              key: 'restore',
              label: '还原 / 运行 SQL 文件...',
              onClick: () => openRestoreDialog(current.profileId!, current.database!)
            }
          ]
        }}
        trigger={['click']}
      >
        <button
          className="toolbar-btn"
          type="button"
          disabled={!current.profileId || !current.database}
        >
          <span className="toolbar-btn-icon">
            <Archive size={22} />
          </span>
          <span className="toolbar-btn-label">备份</span>
        </button>
      </Dropdown>
      <BigButton
        icon={<Send size={22} />}
        label="数据传输"
        disabled={Object.keys(connections).length === 0}
        disabledTip="请先打开至少一个连接"
        onClick={openTransferTab}
      />
      <Dropdown
        disabled={Object.keys(connections).length === 0}
        menu={{
          items: [
            { key: 'struct', label: '结构同步...', onClick: openSyncTab },
            { key: 'data', label: '数据同步...', onClick: openDataSyncTab }
          ]
        }}
        trigger={['click']}
      >
        <button
          className="toolbar-btn"
          type="button"
          disabled={Object.keys(connections).length === 0}
        >
          <span className="toolbar-btn-icon">
            <GitCompareArrows size={22} />
          </span>
          <span className="toolbar-btn-label">同步</span>
        </button>
      </Dropdown>
      <BigButton icon={<Clock size={22} />} label="自动运行" disabled disabledTip="后续版本提供" />
      <BigButton icon={<Network size={22} />} label="模型" disabled disabledTip="后续版本提供" />
      <BigButton icon={<BarChart3 size={22} />} label="图表" disabled disabledTip="后续版本提供" />
      <div className="toolbar-spacer" />
      <Tooltip title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>
        <button
          className="toolbar-btn toolbar-btn-small"
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <span className="toolbar-btn-icon">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </span>
        </button>
      </Tooltip>
    </div>
  )
}
