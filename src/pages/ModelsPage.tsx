import { ModelPanel } from '../components/ModelPanel'
import type { IModelStatus } from '../types'

interface IModelsPageProps {
  models: IModelStatus[]
  loading: boolean
  error: string | null
  verifying: string[]
  selectedId: string | null
  modelsDir: string
  onSelect: (id: string) => void
  onDownload: (id: string) => void
  onCancelDownload: (id: string) => void
  onDelete: (id: string) => void
  onImport: () => void
  onRefresh: () => void
  onReveal: (path: string) => void
}

/** 模型页。 */
const ModelsPage = (props: IModelsPageProps) => (
  <div className="page">
    <ModelPanel {...props} />
  </div>
)

export { ModelsPage }
