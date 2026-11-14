// The contextBridge (P1.5): the only path between the renderer and main. It exposes the methods of
// `ViewProtectApi` (src/shared/ipc.ts) and nothing else — no `ipcRenderer`, no channel strings, no
// Node API — so the renderer can only ask for what the contract defines.
//
// Everything is validated twice on purpose. Requests are checked here before the round trip, so a
// malformed payload fails immediately with the schema's own message instead of as a generic error
// from main, and main checks them again because the preload is not a trust boundary it controls.
// Replies and pushed events are checked here, so a shape mismatch surfaces at the bridge with the
// channel named rather than as `undefined` inside a component.
//
// No method ever throws: a rejected `invoke` (main threw, no handler is registered, the reply failed
// validation) comes back as `{ ok: false, error }` like any other failure, which is what lets a
// component branch on one thing (see rule 2 in src/shared/ipc.ts).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { z } from 'zod'
import {
  BRIDGE_KEY,
  IPC,
  IPC_EVENTS,
  ipcFail,
  ipcResultSchema,
  type AppState,
  type Camera,
  type CameraStateChange,
  type ConnectionStatus,
  type IpcResult,
  type PinCheck,
  type SnapshotResult,
  type StreamHandle,
  type StreamRuntime,
  type TestConnection,
  type Unsubscribe,
  type ViewProtectApi,
} from '@shared/ipc'

/** First line of a zod issue list, for a message the UI can show. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'validation failed'
  const path = issue.path.join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

/**
 * One call: validate the request, invoke, validate the reply.
 *
 * The schemas are passed as `z.ZodType<…>` rather than the concrete `IPC` entries so this stays one
 * function for every channel in the table.
 */
async function call<Req, Value>(
  spec: {
    readonly channel: string
    readonly request: z.ZodType<Req>
    readonly value: z.ZodType<Value>
  },
  input: unknown,
): Promise<IpcResult<Value>> {
  const request = spec.request.safeParse(input)
  if (!request.success) {
    return ipcFail('invalid-request', `${spec.channel}: ${firstIssue(request.error)}`)
  }
  let raw: unknown
  try {
    // `request.data` and not `input`: defaults and trims applied by the schema travel with the call,
    // so main validates exactly what the contract produced here.
    raw = await ipcRenderer.invoke(spec.channel, request.data)
  } catch (err: unknown) {
    // Main threw out of its handler, or there is no handler for this channel at all.
    const message = err instanceof Error ? err.message : String(err)
    return ipcFail('internal', `${spec.channel} failed: ${message}`, { retryable: true })
  }
  const reply = ipcResultSchema(spec.value).safeParse(raw)
  if (!reply.success) {
    return ipcFail('invalid-response', `${spec.channel} replied with an unexpected shape`)
  }
  return reply.data
}

/**
 * One event subscription. The Electron `IpcRendererEvent` is deliberately **not** passed on: it
 * carries `sender` and `ports`, which would hand the renderer a way around this bridge.
 *
 * A payload that fails validation is dropped with a console error rather than thrown: these arrive
 * asynchronously, there is nobody to catch them, and a bad `cameraState` frame must not take the
 * window down (CAM-2).
 */
function subscribe<Payload>(
  spec: { readonly channel: string; readonly payload: z.ZodType<Payload> },
  listener: (payload: Payload) => void,
): Unsubscribe {
  const handler = (_event: IpcRendererEvent, raw: unknown): void => {
    const parsed = spec.payload.safeParse(raw)
    if (!parsed.success) {
      console.error(`[bridge] ${spec.channel}: unexpected payload (${firstIssue(parsed.error)})`)
      return
    }
    listener(parsed.data)
  }
  ipcRenderer.on(spec.channel, handler)
  return () => {
    ipcRenderer.removeListener(spec.channel, handler)
  }
}

// __APP_VERSION__ is replaced at build time with package.json's version (electron.vite.config.ts).
// Annotated before freezing, not inside `Object.freeze(...)`: the annotation is what gives each
// method's `input` its parameter type from the contract.
const impl: ViewProtectApi = {
  version: __APP_VERSION__,

  getState: (): Promise<IpcResult<AppState>> => call(IPC.getState, undefined),
  setConsole: (input): Promise<IpcResult<AppState>> => call(IPC.setConsole, input),
  setSecret: (input): Promise<IpcResult<AppState>> => call(IPC.setSecret, input),
  clearSecret: (input): Promise<IpcResult<AppState>> => call(IPC.clearSecret, input),
  checkCertificate: (input): Promise<IpcResult<PinCheck>> => call(IPC.checkCertificate, input),
  acceptCertificate: (input): Promise<IpcResult<AppState>> => call(IPC.acceptCertificate, input),
  repinCertificate: (input): Promise<IpcResult<AppState>> => call(IPC.repinCertificate, input),
  testConnection: (): Promise<IpcResult<TestConnection>> => call(IPC.testConnection, undefined),
  connect: (): Promise<IpcResult<AppState>> => call(IPC.connect, undefined),
  disconnect: (): Promise<IpcResult<AppState>> => call(IPC.disconnect, undefined),
  listCameras: (): Promise<IpcResult<Camera[]>> => call(IPC.listCameras, undefined),
  snapshot: (input): Promise<IpcResult<SnapshotResult>> => call(IPC.snapshot, input),
  ensureStream: (input): Promise<IpcResult<StreamHandle>> => call(IPC.ensureStream, input),

  onConnection: (listener: (status: ConnectionStatus) => void): Unsubscribe =>
    subscribe(IPC_EVENTS.connection, listener),
  onCameras: (listener: (cameras: Camera[]) => void): Unsubscribe =>
    subscribe(IPC_EVENTS.cameras, listener),
  onCameraState: (listener: (change: CameraStateChange) => void): Unsubscribe =>
    subscribe(IPC_EVENTS.cameraState, listener),
  // Validated like every other push: a malformed runtime frame would otherwise send every player
  // to a port that is not go2rtc's (P2.2, SPEC §5.3 "Renderer isolation").
  onStreamRuntime: (listener: (runtime: StreamRuntime) => void): Unsubscribe =>
    subscribe(IPC_EVENTS.streamRuntime, listener),
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, Object.freeze(impl))
