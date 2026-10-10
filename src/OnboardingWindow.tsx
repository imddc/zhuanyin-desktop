import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useState } from 'react'

import { AppToaster } from './components/AppToaster'
import { Onboarding } from './components/Onboarding'
import { useModels } from './hooks/useModels'
import { pickModelId } from './lib/models'
import { notify } from './lib/notice'
import { loadSelectedModelId, saveSelectedModelId } from './lib/settings'
import type { TOnboardingStep } from './components/Onboarding'

/** 在访达里定位模型目录。失败不致命，用提示说一声即可。 */
const reveal = (path: string): void => {
  if (path === '') {
    return
  }
  void invoke('reveal_in_file_manager', { path }).catch(() => notify('这个路径已经不存在了'))
}

/**
 * 引导窗口的根组件。
 *
 * 与主窗口共用同一份前端产物（同一个 `index.html`），由 `main.tsx` 按窗口 label 分派。
 * 它是**独立窗口**：没有可用模型时应用只开这一个窗口，主窗口此时并不存在。
 */
const OnboardingWindow = () => {
  const [step, setStep] = useState<TOnboardingStep>('welcome')
  const [preferredModelId, setPreferredModelId] = useState<string | null>(() => loadSelectedModelId())
  const models = useModels(notify)

  const effectiveModelId = pickModelId(models.models, preferredModelId)

  const applyModelId = useCallback((id: string) => {
    setPreferredModelId(id)
    saveSelectedModelId(id)
  }, [])

  /**
   * 关掉引导窗口。
   *
   * 不会把应用关死：Rust 侧在引导窗口销毁、而主窗口还不存在时会打开主窗口，
   * 那边有「还没有可用模型」的说明与去模型页下载的入口。
   */
  const close = useCallback(() => {
    void getCurrentWindow()
      .close()
      .catch(() => notify('无法关闭窗口'))
  }, [])

  /** 交给 Rust 建主窗口、关掉本窗口；失败要提示，否则用户会以为点了没反应 */
  const finish = useCallback(() => {
    void invoke('finish_onboarding').catch((error: unknown) => {
      notify(`无法打开主界面：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [])

  return (
    <>
      <Onboarding
        step={step}
        onStepChange={setStep}
        models={models.models}
        verifying={models.verifying}
        selectedId={effectiveModelId}
        loading={models.loading}
        error={models.error}
        modelsDir={models.modelsDir}
        onSelect={applyModelId}
        onDownload={(id) => void models.download(id)}
        onCancelDownload={(id) => void models.cancelDownload(id)}
        onImport={() => void models.importExisting()}
        onReveal={reveal}
        onFinish={finish}
        onClose={close}
      />
      <AppToaster />
    </>
  )
}

export { OnboardingWindow }
