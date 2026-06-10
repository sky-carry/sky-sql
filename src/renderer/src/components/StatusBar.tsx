import { useAppStore } from '@/stores/appStore'

export function StatusBar(): React.JSX.Element {
  const status = useAppStore((s) => s.status)
  const current = useAppStore((s) => s.current)
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)

  const profile = profiles.find((p) => p.id === current.profileId)
  const conn = current.profileId ? connections[current.profileId] : undefined

  const contextText = profile
    ? [profile.name, current.database].filter(Boolean).join(' / ')
    : ''

  return (
    <div className="status-bar">
      <span className="status-text">{status}</span>
      <span className="status-spacer" />
      {conn && <span className="status-item">{conn.serverVersion}</span>}
      {contextText && <span className="status-item">{contextText}</span>}
    </div>
  )
}
