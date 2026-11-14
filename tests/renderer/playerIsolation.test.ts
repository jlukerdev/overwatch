// P2.3 (SPEC §5.3 "Renderer isolation", CON-2, NFR-9, CLAUDE.md): the live player only ever handles
// a `StreamHandle`.
//
// This one reads its own source, which needs explaining. The rule it guards is a *negative*: the
// player must never see an RTSPS URL, never see go2rtc's API credentials, and never build a stream
// URL out of a port and a name — main's `onBeforeSendHeaders` filter injects `Authorization` only
// for the exact loopback URL it built, so a URL assembled in the renderer would silently lose its
// credentials, and a renderer that can compose stream URLs can compose one for a camera no View
// asked for. There is no unit test for "the component never touches X", because X never arriving is
// what correct looks like: the component cannot be rendered here at all (no jsdom, no MSE, no
// WebSocket — vitest.config.mts), and a code path that is never taken proves nothing either way. So
// the check is on the code itself, which is also where a future change would introduce the problem.
//
// The vendored go2rtc player is excluded on purpose: it is not ours to constrain (vendor/README.md),
// it is unmodified, and it only ever receives the URL `MsePlayer.start()` hands it.
import { describe, expect, it } from 'vitest'
import { QUALITIES, STREAM_QUALITIES } from '@shared/quality'
// Vite's `?raw` rather than `node:fs`: tests/renderer is typechecked as renderer code
// (tsconfig.web.json), which has no Node types, and the import also ties this test to the real
// module paths — renaming a file breaks it loudly instead of silently checking nothing.
import livePlayerSource from '../../src/renderer/src/player/LivePlayer.tsx?raw'
import msePlayerSource from '../../src/renderer/src/player/MsePlayer.ts?raw'
import playerMachineSource from '../../src/renderer/src/player/playerMachine.ts?raw'
import mseBufferSource from '../../src/renderer/src/player/mseBuffer.ts?raw'
import playerTimingSource from '../../src/renderer/src/player/playerTiming.ts?raw'

/** Every file of the player that is ours. `vendor/` is deliberately not in this list. */
const PLAYER_FILES = {
  'LivePlayer.tsx': livePlayerSource,
  'MsePlayer.ts': msePlayerSource,
  'playerMachine.ts': playerMachineSource,
  'mseBuffer.ts': mseBufferSource,
  'playerTiming.ts': playerTimingSource,
} as const

/**
 * Source with comments removed, because the comments *document* the rules below and name the very
 * things the code may not contain ("never the RTSPS URL", "main injects `Authorization`"). Naive by
 * design — it would mangle a `//` inside a string literal, and there is no such literal in these
 * files; if one ever appears, this test failing is the right outcome, since a URL literal is exactly
 * what it is here to forbid.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const sources = new Map(Object.entries(PLAYER_FILES).map(([file, source]) => [file, code(source)]))

describe('the player holds no secret and no upstream URL', () => {
  it('mentions no RTSPS or RTSP source anywhere', () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/rtsp/i)
    }
  })

  it('mentions no credential, header or auth of any kind', () => {
    // go2rtc's API username/password live in main and are injected per request (SPEC §5.3).
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/authorization|basic |credential|password|username|apikey/i)
    }
  })

  it('builds no stream URL: no scheme, no loopback host, no go2rtc path, no stream name', () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/wss?:\/\//)
      expect(source, file).not.toMatch(/127\.0\.0\.1/)
      expect(source, file).not.toMatch(/api\/(ws|streams)/)
      expect(source, file).not.toMatch(/\bgo2rtcWsUrl\b/)
      expect(source, file).not.toMatch(/\bstreamName\b/)
      expect(source, file).not.toMatch(/\bLOOPBACK_HOST\b/)
    }
  })

  it('takes the ws URL from the handle and passes it through', () => {
    // The machine reads exactly one field off the handle for attaching, and the component forwards
    // the command's value to the element without touching it.
    expect(sources.get('playerMachine.ts')).toContain('wsUrl: handle.wsUrl')
    expect(sources.get('LivePlayer.tsx')).toContain('attach(command.id, command.wsUrl)')
    expect(sources.get('LivePlayer.tsx')).toContain('element.start(wsUrl)')
  })

  it('uses only the two bridge members a player needs', () => {
    const source = sources.get('LivePlayer.tsx') ?? ''
    const used = [...source.matchAll(/window\.viewProtect\.(\w+)/g)].map((match) => match[1])
    expect(new Set(used)).toEqual(new Set(['ensureStream', 'onStreamRuntime']))
  })
})

describe('quality is a prop, never a constant (the QUAL preamble)', () => {
  it('has no quality literal in LivePlayer.tsx', () => {
    const source = sources.get('LivePlayer.tsx') ?? ''
    for (const quality of STREAM_QUALITIES) {
      expect(source, quality).not.toContain(`'${quality}'`)
      expect(source, quality).not.toContain(`"${quality}"`)
    }
  })

  it('has no quality literal anywhere else in the player either', () => {
    // Including the machine: it compares the handle's quality with the prop's and never names one.
    for (const [file, source] of sources) {
      for (const quality of QUALITIES) {
        expect(source, `${file} ${quality}`).not.toContain(`'${quality}'`)
      }
    }
  })
})
