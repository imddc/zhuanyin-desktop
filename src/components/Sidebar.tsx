import iconUrl from '../../assets/icon.svg'

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

const PAGES: Array<{ id: TPage; label: string; hint: string; iconPath: string }> = [
  { id: 'transcribe', label: '转写', hint: '拖入音频，看队列与逐字稿', iconPath: 'M4 10v4m5-8v12m5-10v8m5-5v2' },
  {
    id: 'models',
    label: '模型',
    hint: '下载与切换识别模型',
    iconPath: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  },
  { id: 'history', label: '历史', hint: '看以前的转写结果', iconPath: 'M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7m2-4v5l3 2' },
  { id: 'settings', label: '设置', hint: '输出位置、语言与提示词', iconPath: 'M4 7h4m4 0h8M4 17h8m4 0h4M10 4v6m4 4v6' },
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
      <img className="sidebar__mark" src={iconUrl} alt="转音" width={40} height={40} />
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
            <span className="nav-item__label">
              <svg className="nav-item__icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d={item.iconPath}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {item.label}
            </span>
            {count !== null && count > 0 ? <span className="nav-item__count">{count}</span> : null}
          </button>
        )
      })}
    </nav>

    {/* 状态只用一行放在底部：顶部那块纵向空间留给内容 */}
    <div className="sidebar__foot">
      <span className={props.engineReady ? 'dot dot--ok' : 'dot dot--warn'} aria-hidden="true" />
      <span className="sidebar__status" title={props.activeModelName ?? undefined}>
        {props.engineReady ? (props.activeModelName ?? '模型就绪') : '还没有可用模型'}
      </span>
    </div>
  </aside>
)

export { Sidebar, PAGES }
export type { TPage }
