// The camera list's wording helper (UX polish): the header count.
import { describe, expect, it } from 'vitest'
import { cameraCountLabel } from '../../src/renderer/src/features/cameras/cameraListText'

describe('cameraCountLabel', () => {
  it('counts in plain words, singular and plural', () => {
    expect(cameraCountLabel(1)).toBe('1 camera')
    expect(cameraCountLabel(12)).toBe('12 cameras')
  })

  it('says nothing for an empty list: the body explains it', () => {
    expect(cameraCountLabel(0)).toBeNull()
  })
})
