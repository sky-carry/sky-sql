import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

// 使用本地打包的 monaco（默认从 CDN 加载，离线桌面应用不可接受）
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

loader.config({ monaco })

export { monaco }
