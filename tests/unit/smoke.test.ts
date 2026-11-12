import { describe, expect, it } from 'vitest'
import { BRIDGE_KEY } from '@shared/ipc'

describe('scaffold smoke', () => {
  it('resolves the @shared alias', () => {
    expect(BRIDGE_KEY).toBe('viewProtect')
  })
})
