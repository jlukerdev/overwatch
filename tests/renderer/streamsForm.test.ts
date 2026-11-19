// QUAL-1's app-wide stream defaults (src/renderer/src/features/cameras/streamsForm.ts): the
// `setStreams` payload the Cameras screen's Settings bar sends when one select changes. Moved from
// settingsForm.test.ts with the selects (P5.7).
import { describe, expect, it } from 'vitest'
import { streamsInputFrom } from '../../src/renderer/src/features/cameras/streamsForm'

describe('streamsInputFrom (QUAL-1)', () => {
  const streams = { defaultGridQuality: 'low', defaultFillQuality: 'high' } as const

  it('changes the one field and sends the other exactly as stored', () => {
    expect(streamsInputFrom(streams, 'defaultGridQuality', 'medium')).toEqual({
      defaultGridQuality: 'medium',
      defaultFillQuality: 'high',
    })
    expect(streamsInputFrom(streams, 'defaultFillQuality', 'low')).toEqual({
      defaultGridQuality: 'low',
      defaultFillQuality: 'low',
    })
  })

  it('sends nothing for the value already stored', () => {
    expect(streamsInputFrom(streams, 'defaultGridQuality', 'low')).toBeNull()
  })

  it('sends nothing for a value that is not a quality, the package channel included', () => {
    expect(streamsInputFrom(streams, 'defaultGridQuality', 'package')).toBeNull()
    expect(streamsInputFrom(streams, 'defaultFillQuality', '')).toBeNull()
  })
})
