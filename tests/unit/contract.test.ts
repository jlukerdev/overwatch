// scripts/lib/contract.ts: JSON-pointer helpers and Ajv validation with undeclared-property
// reporting, against a small inline OpenAPI 3.1 document.
import { describe, expect, it } from 'vitest'
import {
  collapseIndices,
  Contract,
  pointerToken,
  responsePointer,
} from '../../scripts/lib/contract.ts'

const doc = {
  openapi: '3.1.0',
  paths: {
    '/v1/things/{id}': {
      get: {
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/thing' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      thing: {
        type: 'object',
        required: ['id', 'kind'],
        properties: {
          id: { type: 'string' },
          kind: { oneOf: [{ const: 'a' }, { const: 'b' }] },
          tags: { type: 'array', items: { $ref: '#/components/schemas/tag' } },
          meta: { type: 'object' },
        },
      },
      tag: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    },
  },
}

describe('pointer helpers', () => {
  it('escapes tokens per RFC 6901 and URI-encodes them', () => {
    expect(pointerToken('/v1/things/{id}')).toBe('~1v1~1things~1%7Bid%7D')
    expect(pointerToken('a~b')).toBe('a~0b')
  })

  it('builds response pointers (default status 200)', () => {
    expect(responsePointer('/x', 'get')).toBe(
      '/paths/~1x/get/responses/200/content/application~1json/schema',
    )
    expect(responsePointer('/x', 'post', '201')).toContain('/responses/201/')
  })

  it('collapses array indices', () => {
    expect(collapseIndices('/0/tags/12/name')).toBe('/[]/tags/[]/name')
    expect(collapseIndices('/a1/b')).toBe('/a1/b')
  })
})

describe('Contract.validate', () => {
  const contract = new Contract(doc)
  const pointer = responsePointer('/v1/things/{id}', 'get')

  it('accepts valid data with no extras', () => {
    expect(contract.validate(pointer, { id: 'x', kind: 'a', tags: [{ name: 't' }] })).toEqual({
      valid: true,
      errors: [],
      extraProperties: [],
    })
  })

  it('reports missing required properties', () => {
    const result = contract.validate(pointer, { kind: 'b' })
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(["/: must have required property 'id'"])
  })

  it('reports undeclared properties (collapsed, sorted) but not inside free-form objects', () => {
    const result = contract.validate(pointer, {
      id: 'x',
      kind: 'a',
      zzz: 1,
      tags: [{ name: 't', extra: true }, { extra: false }],
      meta: { anything: 1 },
    })
    expect(result.valid).toBe(true)
    expect(result.extraProperties).toEqual(['/tags/[]/extra', '/zzz'])
  })

  it('validates a component schema pointer directly', () => {
    expect(contract.validate('/components/schemas/tag', { name: 1 }).errors).toEqual([
      '/name: must be string',
    ])
  })
})
