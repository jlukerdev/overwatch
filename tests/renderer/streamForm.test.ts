// F1.0.2-5 (RTSP-1, RTSP-2): the Add / Edit stream dialog's rules, tested where they live. The
// dialog itself cannot be rendered here (no jsdom), which is why every rule about what it may save
// and what it sends is in features/streams/streamForm.ts.
import { describe, expect, it } from 'vitest'
import {
  NO_URL_MESSAGE,
  clearUrl,
  keepUrl,
  replaceUrl,
  setName,
  setUrl,
  sortStreams,
  streamCountLabel,
  streamFormFrom,
  toSaveInput,
  validateStreamForm,
  type StreamForm,
} from '../../src/renderer/src/features/streams/streamForm'

const URL_A = 'rtsp://user:secret@camera.example:554/main'
const URL_B = 'rtsps://camera.example:7441/sub'

const FRONT = { id: 'aaaaaaaa', name: 'Front door' }
const STREAMS = [FRONT, { id: 'bbbbbbbb', name: 'Garage' }]

const add = (name = 'Back yard'): StreamForm => setName(streamFormFrom(), name)
const edit = (
  stored: { high: boolean; medium: boolean; low: boolean },
  stream = FRONT,
): StreamForm => streamFormFrom(stream, stored)

describe('streamFormFrom', () => {
  it('starts Add empty, every quality a new field', () => {
    const form = streamFormFrom()
    expect(form.id).toBeUndefined()
    expect(form.name).toBe('')
    expect(form.urls.high).toEqual({ stored: false, mode: 'new', value: '' })
  })

  it('starts Edit with stored qualities kept and the rest new', () => {
    const form = edit({ high: true, medium: false, low: true })
    expect(form.id).toBe('aaaaaaaa')
    expect(form.name).toBe('Front door')
    expect(form.urls.high.mode).toBe('keep')
    expect(form.urls.medium.mode).toBe('new')
    expect(form.urls.low.mode).toBe('keep')
  })
})

describe('validateStreamForm: name', () => {
  it('requires a name', () => {
    const check = validateStreamForm(setUrl(add('  '), 'high', URL_A), STREAMS)
    expect(check.errors.name).not.toBeNull()
    expect(check.canSave).toBe(false)
  })

  it('refuses a name another stream has, ignoring case', () => {
    const check = validateStreamForm(setUrl(add('GARAGE'), 'high', URL_A), STREAMS)
    expect(check.errors.name).toBe('Another stream already has this name.')
    expect(check.canSave).toBe(false)
  })

  it('refuses a name over 64 characters', () => {
    const check = validateStreamForm(setUrl(add('x'.repeat(65)), 'high', URL_A), STREAMS)
    expect(check.errors.name).not.toBeNull()
  })

  it('lets an edited stream keep its own name, in any case', () => {
    const form = setName(edit({ high: true, medium: false, low: false }), 'FRONT DOOR')
    const check = validateStreamForm(form, STREAMS)
    expect(check.errors.name).toBeNull()
    expect(check.canSave).toBe(true)
  })

  it('refuses renaming onto another stream', () => {
    const form = setName(edit({ high: true, medium: false, low: false }), 'garage')
    expect(validateStreamForm(form, STREAMS).errors.name).not.toBeNull()
  })
})

describe('validateStreamForm: addresses', () => {
  it('needs at least one address to create a stream', () => {
    const check = validateStreamForm(add(), STREAMS)
    expect(check.noUrl).toBe(true)
    expect(check.canSave).toBe(false)
    expect(NO_URL_MESSAGE).toBe('A stream needs at least one address.')
  })

  it('creates with any one valid address', () => {
    for (const quality of ['high', 'medium', 'low'] as const) {
      const check = validateStreamForm(setUrl(add(), quality, URL_B), STREAMS)
      expect(check.canSave).toBe(true)
    }
  })

  it('shows an invalid address under its own field only', () => {
    const form = setUrl(setUrl(add(), 'high', URL_A), 'low', 'http://camera.example/stream')
    const check = validateStreamForm(form, STREAMS)
    expect(check.errors.low).toBe('The address must start with rtsp:// or rtsps://.')
    expect(check.errors.high).toBeNull()
    expect(check.errors.medium).toBeNull()
    expect(check.canSave).toBe(false)
  })

  it('does not trim: a leading space is an error', () => {
    const check = validateStreamForm(setUrl(add(), 'high', ` ${URL_A}`), STREAMS)
    expect(check.errors.high).not.toBeNull()
    expect(check.canSave).toBe(false)
  })

  it('refuses clearing the last stored address', () => {
    const form = clearUrl(edit({ high: true, medium: false, low: false }), 'high')
    const check = validateStreamForm(form, STREAMS)
    expect(check.noUrl).toBe(true)
    expect(check.canSave).toBe(false)
  })

  it('allows clearing one address while another stays saved', () => {
    const form = clearUrl(edit({ high: true, medium: false, low: true }), 'high')
    const check = validateStreamForm(form, STREAMS)
    expect(check.noUrl).toBe(false)
    expect(check.canSave).toBe(true)
  })

  it('allows clearing the last stored address when a new one is typed', () => {
    const form = setUrl(
      clearUrl(edit({ high: true, medium: false, low: false }), 'high'),
      'low',
      URL_B,
    )
    expect(validateStreamForm(form, STREAMS).canSave).toBe(true)
  })

  it('treats an open but empty Replace field as keep', () => {
    const form = replaceUrl(edit({ high: true, medium: false, low: false }), 'high')
    const check = validateStreamForm(form, STREAMS)
    expect(check.errors.high).toBeNull()
    expect(check.noUrl).toBe(false)
    expect(check.writesUrl).toBe(false)
    expect(check.canSave).toBe(true)
    expect(toSaveInput(form).urls).toEqual({})
  })

  it('checks a typed replacement like any address', () => {
    const form = setUrl(
      replaceUrl(edit({ high: true, medium: false, low: false }), 'high'),
      'high',
      'rtsp://',
    )
    const check = validateStreamForm(form, STREAMS)
    expect(check.errors.high).not.toBeNull()
    expect(check.canSave).toBe(false)
  })

  it('says whether the save writes an address (the keystore gate)', () => {
    const untouched = edit({ high: true, medium: false, low: false })
    expect(validateStreamForm(setName(untouched, 'Porch'), STREAMS).writesUrl).toBe(false)
    expect(validateStreamForm(setUrl(untouched, 'low', URL_B), STREAMS).writesUrl).toBe(true)
    const twoSaved = edit({ high: true, medium: true, low: false })
    expect(validateStreamForm(clearUrl(twoSaved, 'medium'), STREAMS).writesUrl).toBe(true)
  })
})

describe('mode changes', () => {
  it('Replace, Clear and Keep only apply to a stored quality', () => {
    const form = add()
    expect(replaceUrl(form, 'high')).toBe(form)
    expect(clearUrl(form, 'high')).toBe(form)
    expect(keepUrl(form, 'high')).toBe(form)
  })

  it('Keep after Replace drops what was typed', () => {
    const typed = setUrl(
      replaceUrl(edit({ high: true, medium: false, low: false }), 'high'),
      'high',
      URL_A,
    )
    const kept = keepUrl(typed, 'high')
    expect(kept.urls.high).toEqual({ stored: true, mode: 'keep', value: '' })
    expect(toSaveInput(kept).urls).toEqual({})
  })

  it('typing into a kept or cleared quality does nothing', () => {
    const form = edit({ high: true, medium: false, low: false })
    expect(setUrl(form, 'high', URL_A)).toBe(form)
    const cleared = clearUrl(form, 'high')
    expect(setUrl(cleared, 'high', URL_A)).toBe(cleared)
  })
})

describe('toSaveInput', () => {
  it('creates without an id and sends only the typed addresses', () => {
    const input = toSaveInput(setUrl(add('  Back yard '), 'medium', URL_A))
    expect(input).toEqual({ name: 'Back yard', urls: { medium: URL_A } })
    expect('id' in input).toBe(false)
  })

  it('sends no address keys for an untouched edit', () => {
    const input = toSaveInput(setName(edit({ high: true, medium: true, low: true }), 'Porch'))
    expect(input).toEqual({ id: 'aaaaaaaa', name: 'Porch', urls: {} })
  })

  it('sends absent for keep, null for clear and the string for replace or new', () => {
    let form = edit({ high: true, medium: true, low: false })
    form = clearUrl(form, 'medium')
    form = setUrl(form, 'low', URL_B)
    expect(toSaveInput(form).urls).toEqual({ medium: null, low: URL_B })
    expect('high' in toSaveInput(form).urls).toBe(false)

    form = setUrl(replaceUrl(form, 'high'), 'high', URL_A)
    expect(toSaveInput(form).urls).toEqual({ high: URL_A, medium: null, low: URL_B })
  })

  it('sends the address exactly as typed', () => {
    const odd = 'RTSP://Camera.Example:554/Path?x=1'
    expect(toSaveInput(setUrl(add(), 'high', odd)).urls.high).toBe(odd)
  })
})

describe('the list', () => {
  it('sorts by name ignoring case, without changing its argument', () => {
    const input = [{ name: 'garage' }, { name: 'Back yard' }, { name: 'attic' }]
    expect(sortStreams(input).map((stream) => stream.name)).toEqual([
      'attic',
      'Back yard',
      'garage',
    ])
    expect(input[0]?.name).toBe('garage')
  })

  it('compares numbers as numbers, like every other list', () => {
    const input = [{ name: 'Cam 10' }, { name: 'cam 2' }, { name: 'Cam 1' }]
    expect(sortStreams(input).map((stream) => stream.name)).toEqual(['Cam 1', 'cam 2', 'Cam 10'])
  })

  it('counts streams', () => {
    expect(streamCountLabel(0)).toBe('0 streams')
    expect(streamCountLabel(1)).toBe('1 stream')
    expect(streamCountLabel(4)).toBe('4 streams')
  })
})
