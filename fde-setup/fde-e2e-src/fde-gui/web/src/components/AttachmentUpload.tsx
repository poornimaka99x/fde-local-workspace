import { useRef, useState } from 'react'
import { ApiError, apiUpload } from '../lib/api'
import { announceChange } from '../lib/changes'
import { ErrorState } from './States'

/**
 * The bytes go to the server, which pipes them to `fde attach --stdin --name`.
 * The controller sanitizes the filename, generates the stored name, hashes what
 * it wrote and appends the audit record — the console does none of that itself.
 */
export function AttachmentUpload({ runId, onUploaded }: { runId: string; onUploaded: () => void }): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const send = async (): Promise<void> => {
    if (file === null) return
    setError(null)
    setDone(null)
    setProgress(0)
    try {
      const result = await apiUpload<{ attachment: { originalName: string; sha256: string } }>(
        runId,
        file,
        setProgress,
      )
      setDone(`${result.attachment.originalName} — ${result.attachment.sha256.slice(0, 12)}…`)
      setFile(null)
      if (input.current) input.current.value = ''
      announceChange()
      onUploaded()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'The upload failed.'))
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Attach a file</h3>
      {error ? <ErrorState error={error} /> : null}
      <div className="stack">
        <input
          ref={input}
          type="file"
          aria-label="File to attach"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <button
          className="action"
          type="button"
          disabled={file === null || progress !== null}
          onClick={() => void send()}
        >
          {progress === null ? 'Attach' : 'Uploading…'}
        </button>
      </div>
      {progress !== null ? (
        <p aria-live="polite">
          <progress value={progress} max={1} /> {Math.round(progress * 100)}%
        </p>
      ) : null}
      {done !== null ? (
        <p className="badge ok" role="status">
          Attached {done}
        </p>
      ) : null}
      <p className="muted" style={{ marginBottom: 0 }}>
        The file is copied into the run, hashed and recorded. Your original is not moved or changed.
      </p>
    </div>
  )
}
