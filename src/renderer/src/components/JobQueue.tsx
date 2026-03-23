import type { ExportJob } from '../../../shared/types'

interface Props {
  jobs: ExportJob[]
  isExporting: boolean
  onReset: () => void
}

export default function JobQueue({ jobs, isExporting, onReset }: Props) {
  const allDone = jobs.every((j) => j.status === 'done' || j.status === 'error')
  const successCount = jobs.filter((j) => j.status === 'done').length
  const errorCount = jobs.filter((j) => j.status === 'error').length

  return (
    <section className="job-queue">
      <div className="job-queue-header">
        <h2>{isExporting ? 'Exporting...' : 'Export complete'}</h2>
        {allDone && (
          <span className="job-summary">
            {successCount} done{errorCount > 0 ? `, ${errorCount} failed` : ''}
          </span>
        )}
      </div>

      <ul className="job-list">
        {jobs.map((job) => (
          <li key={job.id} className={`job-item job-item--${job.status}`}>
            <div className="job-item-top">
              <span className="job-name">{job.preset.name}</span>
              <span className="job-status-label">{statusLabel(job)}</span>
            </div>

            {(job.status === 'processing' || job.status === 'queued') && (
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
            )}

            {job.status === 'done' && (
              <p className="job-output">{job.outputPath}</p>
            )}

            {job.status === 'error' && (
              <p className="job-error">{job.error}</p>
            )}
          </li>
        ))}
      </ul>

      {allDone && (
        <button className="btn-primary" onClick={onReset}>
          Export another video
        </button>
      )}
    </section>
  )
}

function statusLabel(job: ExportJob): string {
  switch (job.status) {
    case 'queued': return 'Queued'
    case 'processing': return `${job.progress}%`
    case 'done': return '✓ Done'
    case 'error': return '✗ Failed'
  }
}
