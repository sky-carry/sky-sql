import { useEffect, useState } from 'react'
import { App, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Tabs } from 'antd'
import {
  DB_DEFAULT_PORTS,
  DB_TYPE_LABELS,
  type ConnectionProfile,
  type SshConfig,
  type SslConfig
} from '@shared/types'
import { useAppStore } from '@/stores/appStore'

const CONNECTION_COLORS = ['', '#e05252', '#e8a33d', '#3dba62', '#0a87c4', '#8e5ad6']

interface FormValues {
  name: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  filePath?: string
  group?: string
  ssh?: {
    enabled?: boolean
    host?: string
    port?: number
    user?: string
    authType?: 'password' | 'privateKey'
    password?: string
    privateKeyPath?: string
    passphrase?: string
  }
  ssl?: {
    enabled?: boolean
    rejectUnauthorized?: boolean
    caPath?: string
    certPath?: string
    keyPath?: string
  }
}

/** 文件路径输入框 + 浏览按钮 */
function FileInput({
  value,
  onChange,
  placeholder,
  filters
}: {
  value?: string
  onChange?: (v: string) => void
  placeholder?: string
  filters?: { name: string; extensions: string[] }[]
}): React.JSX.Element {
  return (
    <Input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      addonAfter={
        <a
          onClick={() => {
            void window.skysql.dialog
              .openFile(filters ?? [{ name: '所有文件', extensions: ['*'] }])
              .then((f) => {
                if (f) onChange?.(f)
              })
          }}
        >
          浏览...
        </a>
      }
    />
  )
}

export function ConnectionDialog(): React.JSX.Element {
  const { message } = App.useApp()
  const connDialog = useAppStore((s) => s.connDialog)
  const closeConnDialog = useAppStore((s) => s.closeConnDialog)
  const loadProfiles = useAppStore((s) => s.loadProfiles)

  const [form] = Form.useForm<FormValues>()
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [color, setColor] = useState('')
  const [activeTab, setActiveTab] = useState('general')

  const { open, dbType, profile } = connDialog
  const isSqlite = dbType === 'sqlite'
  const isPg = dbType === 'postgresql'

  const sshEnabled = Form.useWatch(['ssh', 'enabled'], form)
  const sshAuthType = Form.useWatch(['ssh', 'authType'], form)
  const sslEnabled = Form.useWatch(['ssl', 'enabled'], form)

  useEffect(() => {
    if (!open) return
    setColor(profile?.color ?? '')
    setActiveTab('general')
    form.setFieldsValue(
      profile
        ? {
            name: profile.name,
            host: profile.host,
            port: profile.port,
            user: profile.user,
            // 密码不回显，留空表示不修改
            password: undefined,
            database: profile.database,
            filePath: profile.filePath,
            group: profile.group,
            ssh: profile.sshConfig
              ? {
                  enabled: profile.sshConfig.enabled,
                  host: profile.sshConfig.host,
                  port: profile.sshConfig.port,
                  user: profile.sshConfig.user,
                  authType: profile.sshConfig.authType,
                  password: undefined,
                  privateKeyPath: profile.sshConfig.privateKeyPath,
                  passphrase: undefined
                }
              : { enabled: false, port: 22, authType: 'password' },
            ssl: profile.sslConfig
              ? { ...profile.sslConfig }
              : { enabled: profile.ssl ?? false, rejectUnauthorized: false }
          }
        : {
            name: `${DB_TYPE_LABELS[dbType]}连接`,
            host: isSqlite ? undefined : 'localhost',
            port: DB_DEFAULT_PORTS[dbType],
            user: dbType === 'postgresql' ? 'postgres' : 'root',
            password: undefined,
            database: isPg ? 'postgres' : undefined,
            filePath: undefined,
            group: undefined,
            ssh: { enabled: false, port: 22, authType: 'password' },
            ssl: { enabled: false, rejectUnauthorized: false }
          }
    )
  }, [open, profile, dbType, form, isSqlite, isPg])

  const collectProfile = (): Partial<ConnectionProfile> => {
    const v = form.getFieldsValue()
    const secret = (val?: string): string | undefined =>
      val === undefined || val === '' ? (profile ? undefined : '') : val

    let sshConfig: SshConfig | undefined
    if (!isSqlite && v.ssh) {
      sshConfig = {
        enabled: v.ssh.enabled ?? false,
        host: v.ssh.host ?? '',
        port: v.ssh.port ?? 22,
        user: v.ssh.user ?? '',
        authType: v.ssh.authType ?? 'password',
        password: secret(v.ssh.password),
        privateKeyPath: v.ssh.privateKeyPath,
        passphrase: secret(v.ssh.passphrase)
      }
    }
    let sslConfig: SslConfig | undefined
    if (!isSqlite && v.ssl) {
      sslConfig = {
        enabled: v.ssl.enabled ?? false,
        rejectUnauthorized: v.ssl.rejectUnauthorized ?? false,
        caPath: v.ssl.caPath,
        certPath: v.ssl.certPath,
        keyPath: v.ssl.keyPath
      }
    }

    return {
      id: profile?.id,
      name: v.name?.trim() || '未命名连接',
      dbType,
      host: v.host,
      port: v.port,
      user: v.user,
      password: secret(v.password),
      database: v.database,
      filePath: v.filePath,
      group: v.group,
      color: color || undefined,
      sshConfig,
      sslConfig
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    try {
      const res = await window.skysql.profiles.test(collectProfile())
      if (res.ok) {
        message.success(`${res.message}（${res.serverVersion ?? ''}）`)
      } else {
        message.error(`连接失败: ${res.message}`)
      }
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    try {
      await form.validateFields()
    } catch {
      setActiveTab('general')
      return
    }
    setSaving(true)
    try {
      await window.skysql.profiles.save(collectProfile())
      await loadProfiles()
      message.success('连接已保存')
      closeConnDialog()
    } catch (e) {
      message.error(`保存失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const generalPane = (
    <>
      <Form.Item name="name" label="连接名" rules={[{ required: true, message: '请输入连接名' }]}>
        <Input />
      </Form.Item>
      {isSqlite ? (
        <Form.Item
          name="filePath"
          label="数据库文件"
          rules={[{ required: true, message: '请选择数据库文件' }]}
        >
          <FileInput
            placeholder="选择或输入 .db / .sqlite 文件路径"
            filters={[
              { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
              { name: '所有文件', extensions: ['*'] }
            ]}
          />
        </Form.Item>
      ) : (
        <>
          <Form.Item name="host" label="主机" rules={[{ required: true, message: '请输入主机' }]}>
            <Input placeholder={sshEnabled ? '相对 SSH 主机的地址，通常 127.0.0.1' : 'localhost'} />
          </Form.Item>
          <Form.Item name="port" label="端口">
            <InputNumber min={1} max={65535} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="user" label="用户名">
            <Input />
          </Form.Item>
          <Form.Item name="password" label="密码">
            <Input.Password placeholder={profile ? '留空保持不变' : ''} />
          </Form.Item>
          {isPg && (
            <Form.Item name="database" label="初始数据库">
              <Input placeholder="postgres" />
            </Form.Item>
          )}
        </>
      )}
      <Form.Item name="group" label="分组">
        <Input placeholder="可选" />
      </Form.Item>
      <Form.Item label="颜色标记">
        <div className="color-picker">
          {CONNECTION_COLORS.map((c) => (
            <button
              key={c || 'none'}
              type="button"
              className={`color-swatch${color === c ? ' selected' : ''}${c ? '' : ' none'}`}
              style={c ? { background: c } : undefined}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </Form.Item>
    </>
  )

  const sshPane = (
    <>
      <Form.Item name={['ssh', 'enabled']} valuePropName="checked" wrapperCol={{ offset: 6 }}>
        <Checkbox>使用 SSH 隧道</Checkbox>
      </Form.Item>
      <Form.Item
        name={['ssh', 'host']}
        label="SSH 主机"
        rules={sshEnabled ? [{ required: true, message: '请输入 SSH 主机' }] : []}
      >
        <Input disabled={!sshEnabled} />
      </Form.Item>
      <Form.Item name={['ssh', 'port']} label="端口">
        <InputNumber min={1} max={65535} style={{ width: 120 }} disabled={!sshEnabled} />
      </Form.Item>
      <Form.Item
        name={['ssh', 'user']}
        label="用户名"
        rules={sshEnabled ? [{ required: true, message: '请输入 SSH 用户名' }] : []}
      >
        <Input disabled={!sshEnabled} />
      </Form.Item>
      <Form.Item name={['ssh', 'authType']} label="验证方法">
        <Select
          disabled={!sshEnabled}
          options={[
            { value: 'password', label: '密码' },
            { value: 'privateKey', label: '公钥（私钥文件）' }
          ]}
        />
      </Form.Item>
      {sshAuthType === 'privateKey' ? (
        <>
          <Form.Item
            name={['ssh', 'privateKeyPath']}
            label="私钥文件"
            rules={sshEnabled ? [{ required: true, message: '请选择私钥文件' }] : []}
          >
            <FileInput placeholder="OpenSSH 格式私钥（id_rsa / id_ed25519）" />
          </Form.Item>
          <Form.Item name={['ssh', 'passphrase']} label="私钥口令">
            <Input.Password disabled={!sshEnabled} placeholder={profile ? '留空保持不变' : '没有口令则留空'} />
          </Form.Item>
        </>
      ) : (
        <Form.Item name={['ssh', 'password']} label="密码">
          <Input.Password disabled={!sshEnabled} placeholder={profile ? '留空保持不变' : ''} />
        </Form.Item>
      )}
      <div className="conn-tab-hint">
        启用后，「常规」页的主机应填写数据库相对 SSH 服务器的地址（通常为 127.0.0.1）。
      </div>
    </>
  )

  const sslPane = (
    <>
      <Form.Item name={['ssl', 'enabled']} valuePropName="checked" wrapperCol={{ offset: 6 }}>
        <Checkbox>使用 SSL/TLS 加密连接</Checkbox>
      </Form.Item>
      <Form.Item name={['ssl', 'rejectUnauthorized']} valuePropName="checked" wrapperCol={{ offset: 6 }}>
        <Checkbox disabled={!sslEnabled}>验证服务器证书（需提供 CA 证书）</Checkbox>
      </Form.Item>
      <Form.Item name={['ssl', 'caPath']} label="CA 证书">
        <FileInput placeholder="可选，ca.pem" filters={[{ name: '证书文件', extensions: ['pem', 'crt', 'cer'] }, { name: '所有文件', extensions: ['*'] }]} />
      </Form.Item>
      <Form.Item name={['ssl', 'certPath']} label="客户端证书">
        <FileInput placeholder="可选，client-cert.pem" filters={[{ name: '证书文件', extensions: ['pem', 'crt', 'cer'] }, { name: '所有文件', extensions: ['*'] }]} />
      </Form.Item>
      <Form.Item name={['ssl', 'keyPath']} label="客户端密钥">
        <FileInput placeholder="可选，client-key.pem" filters={[{ name: '密钥文件', extensions: ['pem', 'key'] }, { name: '所有文件', extensions: ['*'] }]} />
      </Form.Item>
    </>
  )

  return (
    <Modal
      title={`${profile ? '编辑' : '新建'}连接 - ${DB_TYPE_LABELS[dbType]}`}
      open={open}
      onCancel={closeConnDialog}
      width={520}
      footer={
        <div className="conn-dialog-footer">
          <Button loading={testing} onClick={() => void handleTest()}>
            测试连接
          </Button>
          <Space>
            <Button onClick={closeConnDialog}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void handleSave()}>
              确定
            </Button>
          </Space>
        </div>
      }
    >
      <Form form={form} layout="horizontal" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
        {isSqlite ? (
          generalPane
        ) : (
          <Tabs
            size="small"
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              { key: 'general', label: '常规', children: generalPane, forceRender: true },
              { key: 'ssh', label: 'SSH', children: sshPane, forceRender: true },
              { key: 'ssl', label: 'SSL', children: sslPane, forceRender: true }
            ]}
          />
        )}
      </Form>
    </Modal>
  )
}
