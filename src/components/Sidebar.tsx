interface ISidebarProps {
  page: TPage
  onChange: (page: TPage) => void
  counts: Record<TPage, number | null>
  engineReady: boolean
  /** 当前常驻内存的模型名；没有则为 null */
  activeModelName: string | null
}

/** 应用内的页面。导航与渲染共用这一份定义，避免两边漂移。 */
type TPage = 'transcribe' | 'models' | 'history' | 'settings'

const PAGES: Array<{ id: TPage; label: string; hint: string }> = [
  { id: 'transcribe', label: '转写', hint: '拖入音频，看队列与逐字稿' },
  { id: 'models', label: '模型', hint: '下载与切换识别模型' },
  { id: 'history', label: '历史', hint: '看以前的转写结果' },
  { id: 'settings', label: '设置', hint: '输出位置、语言与提示词' },
]

/**
 * 左侧导航。
 *
 * 页面切换放在这里而不是顶部状态栏里：应用有四个功能区，用侧边栏能一眼看全，
 * 也把顶部那块纵向空间让给了内容。
 */
const Sidebar = (props: ISidebarProps) => (
  <aside className="sidebar">
    <div className="sidebar__brand">
      <span className="sidebar__mark" aria-hidden="true" />
      <div>
        <p className="sidebar__title">转音</p>
        <p className="sidebar__sub">本机离线转写</p>
      </div>
    </div>

    <nav className="sidebar__nav" aria-label="主导航">
      {PAGES.map((item) => {
        const count = props.counts[item.id]
        const isActive = item.id === props.page
        return (
          <button
            key={item.id}
            type="button"
            className={isActive ? 'nav-item nav-item--active' : 'nav-item'}
            aria-current={isActive ? 'page' : undefined}
            title={item.hint}
            onClick={() => props.onChange(item.id)}
          >
            <span className="nav-item__label">{item.label}</span>
            {count !== null && count > 0 ? <span className="nav-item__count">{count}</span> : null}
          </button>
        )
      })}
    </nav>

    {/* 状态只用一行放在底部：顶部那块纵向空间留给内容 */}
    <div className="sidebar__foot">
      <span className={props.engineReady ? 'dot dot--ok' : 'dot dot--warn'} aria-hidden="true" />
      <span className="sidebar__status">
        {props.engineReady ? (props.activeModelName ?? '模型就绪') : '还没有可用模型'}
      </span>
    </div>
  </aside>
)

export { Sidebar, PAGES }
export type { TPage }
