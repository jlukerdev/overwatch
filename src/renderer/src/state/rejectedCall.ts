// A call that rejected instead of answering, as an `IpcError`. The bridge is written never to reject
// (ipc.ts rule 2), so this is a bug somewhere — but a form or card must still leave its busy state
// and say something. One helper so every screen says it the same way.
import type { IpcError } from '@shared/ipc'

export function rejectedCall(err: unknown): IpcError {
  return {
    kind: 'internal',
    message: err instanceof Error ? err.message : 'An unexpected error occurred in View Protect.',
    endpoint: null,
    retryable: true,
  }
}
