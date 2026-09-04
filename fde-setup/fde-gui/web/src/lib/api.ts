import { currentToken } from './token'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function authHeaders(): HeadersInit {
  const token = currentToken()
  return token === null ? {} : { authorization: `Bearer ${token}` }
}

async function toError(response: Response): Promise<ApiError> {
  let title = `Request failed (${response.status})`
  let code = 'unknown'
  let detail: string | undefined
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      if (typeof record.title === 'string') title = record.title
      if (typeof record.type === 'string') code = record.type.replace('about:fde/', '')
      if (typeof record.detail === 'string') detail = record.detail
    }
  } catch {
    /* a non-JSON error body is still an error */
  }
  return new ApiError(response.status, code, title, detail)
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: authHeaders(), credentials: 'omit' })
  if (!response.ok) throw await toError(response)
  return (await response.json()) as T
}

export async function apiGetText(path: string): Promise<{ text: string; truncated: boolean; size: number }> {
  const response = await fetch(path, { headers: authHeaders(), credentials: 'omit' })
  if (!response.ok) throw await toError(response)
  return {
    text: await response.text(),
    truncated: response.headers.get('x-fde-truncated') === 'true',
    size: Number(response.headers.get('x-fde-file-size') ?? '0'),
  }
}

export async function apiGetBlobUrl(path: string): Promise<string> {
  const response = await fetch(path, { headers: authHeaders(), credentials: 'omit' })
  if (!response.ok) throw await toError(response)
  return URL.createObjectURL(await response.blob())
}

export function fileContentUrl(runId: string, filePath: string, disposition: 'inline' | 'attachment'): string {
  return `/api/runs/${encodeURIComponent(runId)}/files/content?path=${encodeURIComponent(filePath)}&disposition=${disposition}`
}

/** A change. Same-origin, token in the header, JSON in and JSON out. */
export async function apiSend<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const hasBody = body !== undefined
  const response = await fetch(path, {
    method,
    headers: { ...authHeaders(), ...(hasBody ? { 'content-type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(body) : undefined,
    credentials: 'omit',
  })
  if (!response.ok) throw await toError(response)
  return (await response.json()) as T
}

/**
 * An upload, with progress. The bytes go straight to the server, which pipes
 * them to `fde attach --stdin --name`; the filename travels as a label in the
 * query string and is sanitized by the controller.
 */
export function apiUpload<T>(
  runId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest()
    const url = `/api/runs/${encodeURIComponent(runId)}/attachments?name=${encodeURIComponent(file.name)}`
    request.open('POST', url, true)
    const token = currentToken()
    if (token !== null) request.setRequestHeader('authorization', `Bearer ${token}`)
    request.setRequestHeader('content-type', 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    request.onerror = () =>
      reject(new ApiError(0, 'network', 'The upload could not reach the local server.'))
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as T)
        } catch {
          reject(new ApiError(502, 'unreadable', 'The server answered with something unreadable.'))
        }
        return
      }
      let title = `Upload failed (${request.status})`
      let code = 'unknown'
      let detail: string | undefined
      try {
        const body: unknown = JSON.parse(request.responseText)
        if (body && typeof body === 'object') {
          const record = body as Record<string, unknown>
          if (typeof record.title === 'string') title = record.title
          if (typeof record.type === 'string') code = record.type.replace('about:fde/', '')
          if (typeof record.detail === 'string') detail = record.detail
        }
      } catch {
        /* a non-JSON error body is still an error */
      }
      reject(new ApiError(request.status, code, title, detail))
    }
    request.send(file)
  })
}
