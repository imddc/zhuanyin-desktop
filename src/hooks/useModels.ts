import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { IModelDownloadProgress, IModelStatus } from '../types'

interface IUseModelsResult {
  models: IModelStatus[]
  loading: boolean
  error: string | null
  /** 模型目录：引导窗口要用它显示/打开，主窗口从 engine_status 拿同一个值 */
  modelsDir: string
  /** 正在做 sha256 校验的模型 id：进度已到 100%，但还没落盘 */
  verifying: string[]
  /** 重新拉取模型清单（下载完成后或手动刷新） */
  refresh: () => Promise<void>
  download: (id: string) => Promise<void>
  cancelDownload: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 弹系统文件选择框，把用户已有的模型文件收进模型目录 */
  importExisting: () => Promise<void>
}

/**
 * 模型清单与下载进度。
 *
 * 进度由后端的 `model://download` 事件驱动，而不是前端轮询：
 * 下载在 Rust 侧流式进行，事件里带已下载字节数，界面直接照着渲染即可。
 */
const useModels = (onNotice?: (text: string) => void): IUseModelsResult => {
  const [models, setModels] = useState<IModelStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modelsDir, setModelsDir] = useState('')
  const [verifying, setVerifying] = useState<string[]>([])

  const stopVerifying = useCallback((id: string) => {
    setVerifying((current) => current.filter((value) => value !== id))
  }, [])

  // 通知回调放进 ref：它每次渲染都会变，不该让事件订阅反复注册
  const noticeRef = useRef(onNotice)
  useEffect(() => {
    noticeRef.current = onNotice
  }, [onNotice])

  const notify = useCallback((text: string) => {
    noticeRef.current?.(text)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [list, directory] = await Promise.all([invoke<IModelStatus[]>('list_models'), invoke<string>('models_dir')])
      setModels(list)
      setModelsDir(directory)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次挂载拉一次清单；这是「与外部系统（Rust 端）同步」，渲染期拿不到
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 外部系统数据回写，渲染期拿不到
    void refresh()
  }, [refresh])

  useEffect(() => {
    const disposers: Array<() => void> = []
    let disposed = false

    const register = async (): Promise<void> => {
      const unlistenProgress = await listen<IModelDownloadProgress>('model://download', (event) => {
        const payload = event.payload
        setModels((current) =>
          current.map((model) =>
            model.id === payload.id ? { ...model, downloading: true, downloadedBytes: payload.downloadedBytes } : model,
          ),
        )
      })

      const unlistenVerifying = await listen<{ id: string }>('model://verifying', (event) => {
        // 校验要读一遍整个文件，几百 MB 得一两秒；不反馈的话界面会停在 100% 像卡住
        setVerifying((current) => (current.includes(event.payload.id) ? current : [...current, event.payload.id]))
      })

      const unlistenDone = await listen<{ id: string }>('model://download-done', (event) => {
        notify('模型下载完成，可以开始转写了')
        stopVerifying(event.payload.id)
        setModels((current) =>
          current.map((model) =>
            model.id === event.payload.id
              ? { ...model, downloading: false, downloaded: true, downloadedBytes: model.sizeBytes }
              : model,
          ),
        )
        void refresh()
      })

      const unlistenError = await listen<{ id: string; message: string }>('model://download-error', (event) => {
        notify(`模型下载失败：${event.payload.message}`)
        stopVerifying(event.payload.id)
        setModels((current) =>
          current.map((model) => (model.id === event.payload.id ? { ...model, downloading: false } : model)),
        )
      })

      if (disposed) {
        unlistenProgress()
        unlistenVerifying()
        unlistenDone()
        unlistenError()
        return
      }
      disposers.push(unlistenProgress, unlistenVerifying, unlistenDone, unlistenError)
    }

    void register()

    return () => {
      disposed = true
      for (const dispose of disposers) {
        dispose()
      }
    }
  }, [notify, refresh, stopVerifying])

  const download = useCallback(
    async (id: string) => {
      try {
        await invoke('download_model', { id })
        setModels((current) => current.map((model) => (model.id === id ? { ...model, downloading: true } : model)))
      } catch (caught) {
        notify(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [notify],
  )

  const cancelDownload = useCallback(async (id: string) => {
    await invoke('cancel_model_download', { id })
    setModels((current) => current.map((model) => (model.id === id ? { ...model, downloading: false } : model)))
  }, [])

  const remove = useCallback(
    async (id: string) => {
      try {
        await invoke('delete_model', { id })
        notify('模型已删除')
        await refresh()
      } catch (caught) {
        notify(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [notify, refresh],
  )

  const importExisting = useCallback(async () => {
    const picked = await open({
      multiple: false,
      title: '选择已有的 whisper.cpp 模型文件',
      filters: [{ name: '模型文件', extensions: ['bin', 'gguf'] }],
    })
    if (picked === null || Array.isArray(picked)) {
      return
    }
    try {
      await invoke<string>('import_model', { path: picked })
      notify('模型已导入，可以在列表里选中使用')
      await refresh()
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : String(caught))
    }
  }, [notify, refresh])

  return {
    models,
    loading,
    error,
    modelsDir,
    verifying,
    refresh,
    download,
    cancelDownload,
    remove,
    importExisting,
  }
}

export { useModels }
