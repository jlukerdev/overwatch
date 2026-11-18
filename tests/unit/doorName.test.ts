// P5.6: the one door-name fallback chain (src/shared/doorName.ts), used by main for the
// door-action answers and `unlock.log` and by the renderer for the Doors screen's cards.
import { doorDisplayName } from '@shared/doorName'
import { describe, expect, it } from 'vitest'

describe('doorDisplayName', () => {
  it('uses full_name, then name, then the id', () => {
    expect(
      doorDisplayName({ id: 'd-front', name: 'Front', fullName: 'Ground Floor - Front Door' }),
    ).toBe('Ground Floor - Front Door')
    expect(doorDisplayName({ id: 'x', name: 'Back', fullName: '' })).toBe('Back')
    expect(doorDisplayName({ id: 'x', name: '', fullName: '' })).toBe('x')
  })

  it('treats a blank name as missing, and trims the one it uses', () => {
    expect(doorDisplayName({ id: 'x', name: 'Back', fullName: '  ' })).toBe('Back')
    expect(doorDisplayName({ id: 'x', name: ' \t', fullName: '\n' })).toBe('x')
    expect(doorDisplayName({ id: 'x', name: 'Back', fullName: '  Side Gate ' })).toBe('Side Gate')
    expect(doorDisplayName({ id: 'x', name: ' Back ', fullName: '' })).toBe('Back')
  })
})
