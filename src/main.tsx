import { getCurrentWindow } from '@tauri-apps/api/window'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { OnboardingWindow } from './OnboardingWindow'
import { installProductionGuards } from './lib/productionGuards'
import './styles.css'

// 工作区与引导窗口共用入口；开发模式仍可通过 WebView 菜单调试。
const disposeProductionGuards = installProductionGuards(import.meta.env.PROD)
import.meta.hot?.dispose(disposeProductionGuards)

const container = document.getElementById('root')
if (container === null) {
  throw new Error('找不到挂载点 #root')
}

/**
 * 两个窗口共用同一份前端产物，按窗口 label 分派根组件。
 *
 * label 不需要走 IPC（它是启动时注进页面的），所以在 Tauri 之外
 * （例如被单测直接 import）拿不到时按主窗口处理，不要让整个页面崩掉。
 */
const windowLabel = (): string => {
  try {
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
}

const isOnboarding = windowLabel() === 'onboarding'

// 引导窗口是透明窗口，窗口形状靠卡片自己的圆角裁出来。
// 让样式表知道「现在是引导窗口」，才能把底色与光晕交给卡片而不是 body。
if (isOnboarding) {
  document.body.classList.add('is-onboarding')
}

createRoot(container).render(<StrictMode>{isOnboarding ? <OnboardingWindow /> : <App />}</StrictMode>)
