import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ITranscribeJob } from './types'

/**
 * 开发工具（不是测试）：把真实组件 + 真实构建产物 CSS 渲染成静态 HTML，供 Chrome 无头截图。
 *
 * 为什么要这么做：有些界面状态（下载进行中、窗口被压矮）没法在这台机器上点出来
 * ——合成鼠标事件需要辅助功能权限，本机没有。渲染成静态页再用无头浏览器截图，
 * 看到的就是真实 DOM 与真实 CSS，不是我对它们的想象。
 *
 * 默认不跑：它会把文件写进 dist/preview，放进 `pnpm test` 里不合适。
 * 显式触发：
 *
 *   pnpm build && pnpm preview:states
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
 *     --screenshot=/tmp/x.png --window-size=880,560 \
 *     "file://$PWD/dist/preview/models.html"
 *
 * 之所以留这么个东西：这个项目好几次卡在「界面看不到、只能靠读代码猜」上，
 * 而合成鼠标事件需要辅助功能权限、本机没有，点不到的状态就永远验证不了。
 */
const ROOT = process.cwd()
const OUT = resolve(ROOT, 'dist/preview')

/** 构建产物里的 CSS 文件名带 hash，取当前的即可 */
const cssHref = (): string => {
  const files = readdirSync(resolve(ROOT, 'dist/assets')).filter((file) => file.endsWith('.css'))
  const first = files[0]
  if (first === undefined) {
    throw new Error('dist/assets 里没有 CSS，先跑 pnpm build')
  }
  return `../assets/${first}`
}

const page = (body: string, extraClass = ''): string => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${cssHref()}">
<style>
  html, body { height: 100%; }
  #app { height: 100%; }
  ${extraClass}
</style>
</head>
<body>
<div id="app">${body}</div>
</body>
</html>
`

/** 预览页里所有回调都不需要真的做事 */
const noop = (): void => {}

const model = (over: Record<string, unknown>) => ({
  id: 'm',
  name: 'Large v3 Turbo · Q5_0',
  description: '推荐。速度与准确率最平衡',
  filename: 'ggml-large-v3-turbo-q5_0.bin',
  sizeBytes: 574_041_195,
  sha256: 'a'.repeat(64),
  multilingual: true,
  recommended: true,
  speedScore: 5,
  accuracyScore: 4,
  downloaded: false,
  downloading: false,
  downloadedBytes: 0,
  path: null,
  ...over,
})

describe.skipIf(process.env.PREVIEW_STATES !== '1')('预览页生成', () => {
  it('把各状态渲染成静态 HTML', async () => {
    const { ModelList } = await import('../src/components/ModelList')
    const { SettingsPage } = await import('../src/pages/SettingsPage')
    const { Sidebar } = await import('./components/Sidebar')
    const { TranscribePage } = await import('./pages/TranscribePage')

    mkdirSync(OUT, { recursive: true })

    // 真实外壳：.shell(flex column, 100%) > .shell__titlebar + .app(flex row) > 侧边栏 + .content
    // 少了这层嵌套，.content 的 flex:1 就不生效，panel 高度的问题根本复现不出来
    /** Use the real sidebar so previews also catch brand and navigation regressions. */
    const sidebar = (activePage: 'transcribe' | 'models' | 'settings'): string =>
      renderToStaticMarkup(
        <Sidebar
          page={activePage}
          onChange={noop}
          counts={{ transcribe: 3, models: 1, history: 12, settings: null }}
          engineReady
          activeModelName="Large v3 Turbo · Q5_0"
        />,
      )

    // 1) 模型列表的三种下载态：下载中（37%）、校验中、已完成
    const models = [
      model({ id: 'a', downloading: true, downloadedBytes: 212_395_262 }),
      model({ id: 'b', name: 'Medium · Q5_0', downloading: true, downloadedBytes: 574_041_195 }),
      model({ id: 'c', name: 'Small · Q5_1', downloaded: true, path: '/x' }),
    ]

    const modelList = renderToStaticMarkup(
      ModelList({
        models: models as never,
        selectedId: 'a',
        verifying: ['b'],
        onSelect: noop,
        onDownload: noop,
        onCancelDownload: noop,
        onDelete: noop,
      }),
    )

    // 模型页 = .page > .panel，跟真实结构一致
    writeFileSync(
      resolve(OUT, 'models.html'),
      page(
        `<div class="shell"><div class="shell__titlebar"></div><div class="app">${sidebar('models')}
          <main class="content"><div class="page"><section class="panel">
          <header class="panel__head"><h2 class="panel__title">识别模型</h2>
          <div class="panel__actions"><span class="panel__meta">3 个</span></div></header>
          ${modelList}
        </section></div></main></div></div>`,
      ),
    )

    // 2) 设置页：用来观察窗口变矮时 panel 高度与内容的关系
    const settingsBody = renderToStaticMarkup(
      SettingsPage({
        outputRoot: '/Users/x/Downloads/转音产物',
        onOutputRootChange: noop,
        onNotice: noop,
        language: 'auto',
        prompt: '',
        onLanguageChange: noop,
        onPromptChange: noop,
        modelsDir: '/Users/x/Library/Application Support/com.imddc.zhuanyin/models',
        onReveal: noop,
        onOpenModels: noop,
        onReopenOnboarding: noop,
        activeModelName: 'Large v3 Turbo · Q5_0',
        availableModels: 1,
      }),
    )

    // 诊断脚本：把每个 panel 的「容器高度 vs 内容高度」直接画在页面上，
    // 截图时就能看到数字，不用靠肉眼判断有没有溢出
    // 同步执行而不是等 load：headless 截图 / dump-dom 未必会等到 load 事件，
    // 而 <link> 样式表会阻塞脚本，所以脚本跑的时候样式已经就绪
    const diagnose = `<script>
      (function () {
        var lines = [];
        document.querySelectorAll('.panel').forEach(function (panel, i) {
          var head = panel.querySelector('.panel__title');
          var title = head ? head.textContent : ('panel' + i);
          lines.push(title + ': 容器 ' + panel.clientHeight + 'px / 内容 ' + panel.scrollHeight + 'px'
            + (panel.scrollHeight > panel.clientHeight + 1 ? '  ← 溢出 ' + (panel.scrollHeight - panel.clientHeight) + 'px' : ''));
        });
        var page = document.querySelector('.page');
        if (page) {
          lines.push('page: 容器 ' + page.clientHeight + 'px / 内容 ' + page.scrollHeight + 'px');
        }
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:999;background:#000;color:#0f0;'
          + 'font:12px/1.6 ui-monospace,monospace;padding:8px 12px;white-space:pre';
        // 用 fromCharCode 拼接换行，避免反斜杠转义被模板字符串提前吃掉
        box.textContent = lines.join(String.fromCharCode(10));
        document.body.appendChild(box);
      })();
    </script>`

    const settingsShell = `<div class="shell">
      <div class="shell__titlebar"></div>
      <div class="app">${sidebar('settings')}<main class="content">${settingsBody}</main></div>
    </div>`

    writeFileSync(resolve(OUT, 'settings.html'), page(settingsShell))
    writeFileSync(resolve(OUT, 'settings-short.html'), page(settingsShell + diagnose, '#app { height: 100%; }'))

    // A long transcript keeps the scrollbar visible and exercises the minimum workspace size.
    const segments = Array.from({ length: 60 }, (_, index) => ({
      start: index * 8,
      end: index * 8 + 8,
      text: '我们先核对这段录音的识别结果，再整理成可回听的逐字稿。点击段落可以跳到对应时间，长内容应该自然滚动。',
    }))
    const job: ITranscribeJob = {
      id: 'preview-running',
      name: '访谈录音',
      sourcePath: '/recordings/interview.m4a',
      status: 'running',
      ratio: 0.64,
      phase: null,
      durationSeconds: 750,
      segments,
      text: '',
      files: {},
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      modelId: 'large-v3-turbo-q5_0',
      modelName: 'Large v3 Turbo · Q5_0',
      language: 'zh',
      sourceRate: 44100,
      sourceChannels: 2,
      historyId: null,
    }
    const transcribeBody = renderToStaticMarkup(
      <TranscribePage
        engineReady
        dragActive={false}
        onPaths={noop}
        onOpenModels={noop}
        jobs={[job, { ...job, id: 'preview-queued', name: '会议录音', status: 'queued', ratio: 0, segments: [] }]}
        selectedId={job.id}
        onSelect={noop}
        onCancel={noop}
        onClearFinished={noop}
        selectedJob={job}
        segments={segments}
        activeIndex={2}
        onSeek={noop}
        onCopyAll={noop}
        onReveal={noop}
        sourceUrl={null}
        playing={false}
        currentTime={20}
        duration={750}
        playbackRate={1}
        onToggle={noop}
        onRateChange={noop}
      />,
    )
    writeFileSync(
      resolve(OUT, 'transcribe.html'),
      page(
        `<div class="shell"><div class="shell__titlebar"></div><div class="app">${sidebar('transcribe')}
      <main class="content">${transcribeBody}</main></div></div>`,
      ),
    )

    console.log(`预览页已写入 ${OUT}，CSS=${cssHref()}`)

    // 断言产出，不然渲染悄悄坏掉也看不出来（这个工具本身就是用来「看见」的）
    const modelsHtml = readFileSync(resolve(OUT, 'models.html'), 'utf8')
    expect(modelsHtml).toContain('class="progress"')
    expect(modelsHtml).toContain('shell__titlebar')
    expect(readFileSync(resolve(OUT, 'settings-short.html'), 'utf8')).toContain('class="panel"')
  })
})
