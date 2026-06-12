import { useCallback, useEffect, useState } from 'react'
import { App, Button, Checkbox, Form, Input, Modal, Table as AntTable, Tag } from 'antd'
import { Pencil, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react'
import type { DbType, DbUserInfo, UserDesign } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

interface UserDialogState {
  open: boolean
  editing?: DbUserInfo
}

interface UserFormValues {
  name: string
  host?: string
  password?: string
}

function UserDialog({
  state,
  profileId,
  dbType,
  onClose,
  onSaved
}: {
  state: UserDialogState
  profileId: string
  dbType: DbType
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { message } = App.useApp()
  const [form] = Form.useForm<UserFormValues>()
  const [available, setAvailable] = useState<string[]>([])
  const [granted, setGranted] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const isMySql = dbType === 'mysql' || dbType === 'mariadb'
  const { open, editing } = state

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      name: editing?.name ?? '',
      host: editing?.host ?? (isMySql ? '%' : undefined),
      password: undefined
    })
    setGranted([])
    setLoading(true)
    // 编辑时取当前权限；新建时借同一接口取可配置权限列表（granted 为空）
    window.skysql.conn
      .userPrivileges(profileId, editing?.name ?? '__skysql_new__', editing?.host)
      .then((p) => {
        setAvailable(p.available)
        setGranted(editing ? p.granted : [])
      })
      .catch((e) => message.error(`读取权限失败: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setLoading(false))
  }, [open, editing, profileId, isMySql, form, message])

  const handleSave = async (): Promise<void> => {
    try {
      await form.validateFields()
    } catch {
      return
    }
    const v = form.getFieldsValue()
    const design: UserDesign = {
      originalName: editing?.name,
      originalHost: editing?.host,
      name: v.name.trim(),
      host: isMySql ? v.host?.trim() || '%' : undefined,
      password: v.password === undefined || v.password === '' ? (editing ? undefined : '') : v.password,
      privileges: granted
    }
    setSaving(true)
    try {
      await window.skysql.conn.saveUser(profileId, design)
      message.success(editing ? '用户已更新' : '用户已创建')
      onSaved()
      onClose()
    } catch (e) {
      message.error(`保存失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const privLabel = isMySql ? '服务器权限' : dbType === 'sqlserver' ? '服务器角色' : '角色属性'

  return (
    <Modal
      title={editing ? `编辑用户 - ${editing.name}` : '新建用户'}
      open={open}
      onCancel={onClose}
      width={560}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void handleSave()}
    >
      <Form form={form} layout="horizontal" labelCol={{ span: 5 }} wrapperCol={{ span: 19 }}>
        <Form.Item name="name" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
          <Input />
        </Form.Item>
        {isMySql && (
          <Form.Item name="host" label="主机" tooltip="% 表示任意主机">
            <Input placeholder="%" />
          </Form.Item>
        )}
        <Form.Item name="password" label="密码">
          <Input.Password placeholder={editing ? '留空保持不变' : ''} />
        </Form.Item>
        <Form.Item label={privLabel}>
          <div className="priv-grid">
            <Checkbox
              checked={granted.length === available.length && available.length > 0}
              indeterminate={granted.length > 0 && granted.length < available.length}
              onChange={(e) => setGranted(e.target.checked ? [...available] : [])}
            >
              全选
            </Checkbox>
            <div className="priv-items">
              {available.map((p) => (
                <Checkbox
                  key={p}
                  checked={granted.includes(p)}
                  disabled={loading}
                  onChange={(e) =>
                    setGranted((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))
                  }
                >
                  {p}
                </Checkbox>
              ))}
            </div>
          </div>
        </Form.Item>
      </Form>
    </Modal>
  )
}

export function UsersPane(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const current = useAppStore((s) => s.current)
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)

  const [users, setUsers] = useState<DbUserInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [selected, setSelected] = useState<DbUserInfo | null>(null)
  const [dialog, setDialog] = useState<UserDialogState>({ open: false })

  const profile = profiles.find((p) => p.id === current.profileId)
  const connected = current.profileId ? Boolean(connections[current.profileId]) : false

  const load = useCallback(async (): Promise<void> => {
    if (!current.profileId || !connected) return
    setLoading(true)
    setErrorMsg('')
    try {
      setUsers(await window.skysql.conn.listUsers(current.profileId))
    } catch (e) {
      setUsers([])
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [current.profileId, connected])

  useEffect(() => {
    void load()
  }, [load])

  const handleDrop = (): void => {
    if (!selected || !current.profileId) return
    modal.confirm({
      title: `确定删除用户 "${selected.name}${selected.host ? `@${selected.host}` : ''}" 吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.skysql.conn.dropUser(current.profileId!, selected.name, selected.host)
          message.success('用户已删除')
          setSelected(null)
          await load()
        } catch (e) {
          message.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    })
  }

  if (!current.profileId || !connected) {
    return (
      <div className="objects-empty">
        <p>请先在左侧打开一个连接，再管理其用户。</p>
      </div>
    )
  }

  if (errorMsg) {
    return (
      <div className="objects-empty">
        <p>{errorMsg}</p>
      </div>
    )
  }

  const isMySql = profile?.dbType === 'mysql' || profile?.dbType === 'mariadb'

  return (
    <div className="objects-tab">
      <div className="object-toolbar">
        <Button
          size="small"
          type="text"
          icon={<Plus size={14} />}
          onClick={() => setDialog({ open: true })}
        >
          新建用户
        </Button>
        <Button
          size="small"
          type="text"
          icon={<Pencil size={14} />}
          disabled={!selected}
          onClick={() => selected && setDialog({ open: true, editing: selected })}
        >
          编辑用户
        </Button>
        <Button size="small" type="text" danger icon={<Trash2 size={14} />} disabled={!selected} onClick={handleDrop}>
          删除用户
        </Button>
        <Button size="small" type="text" icon={<RefreshCw size={14} />} onClick={() => void load()}>
          刷新
        </Button>
      </div>
      <div className="object-table">
        <AntTable<DbUserInfo>
          size="small"
          rowKey={(r) => `${r.name}@${r.host ?? ''}`}
          dataSource={users}
          loading={loading}
          pagination={false}
          scroll={{ y: 'calc(100vh - 270px)' }}
          rowClassName={(r) =>
            selected && selected.name === r.name && selected.host === r.host ? 'object-row-selected' : ''
          }
          onRow={(record) => ({
            onClick: () => setSelected(record),
            onDoubleClick: () => setDialog({ open: true, editing: record })
          })}
          columns={[
            {
              title: '用户名',
              dataIndex: 'name',
              render: (name: string) => (
                <span className="object-name">
                  <UserRound size={14} className="tree-icon conn" />
                  {name}
                </span>
              )
            },
            ...(isMySql ? [{ title: '主机', dataIndex: 'host', width: 180 }] : []),
            {
              title: '属性',
              dataIndex: 'attributes',
              render: (attrs?: string[]) => (attrs ?? []).map((a) => <Tag key={a}>{a}</Tag>)
            }
          ]}
        />
      </div>
      {profile && current.profileId && (
        <UserDialog
          state={dialog}
          profileId={current.profileId}
          dbType={profile.dbType}
          onClose={() => setDialog({ open: false })}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
