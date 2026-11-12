// Validate Protect payloads against the vendored OpenAPI 3.1 contract (P0.3, shared since P0.3b).
// Used by the P0.3 spike (scripts/spikes/protect-spike.ts) and the fixture tests
// (tests/unit/protectTypes.test.ts); unit-tested in tests/unit/contract.test.ts.
// Node runs this file directly (type stripping), so only erasable TypeScript syntax is allowed.
// OpenAPI 3.1 schemas are JSON Schema 2020-12, so Ajv's 2020 build validates them directly; the
// whole document is registered under one id and every schema is addressed by JSON pointer.
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

// ajv-formats is CommonJS: under Node ESM the default import is the module object.
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule })
  .default ?? addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020

const DOC_ID = 'protect'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type SchemaNode = Record<string, unknown>

export interface ValidationResult {
  valid: boolean
  /** Deduplicated `instancePath: message` lines (array indices collapsed to `[]`). */
  errors: string[]
  /** Paths present in the data but not declared by the schema (array indices collapsed to `[]`). */
  extraProperties: string[]
}

/** Encodes a JSON pointer token (RFC 6901 escaping, then URI-encoded for use in a `$ref`). */
export function pointerToken(token: string): string {
  return encodeURIComponent(token.replace(/~/g, '~0').replace(/\//g, '~1'))
}

/** Pointer to the JSON response schema of `method path` for `status` (default 200). */
export function responsePointer(path: string, method: string, status = '200'): string {
  return ['', 'paths', path, method, 'responses', status, 'content', 'application/json', 'schema']
    .map((t, i) => (i === 0 ? t : pointerToken(t)))
    .join('/')
}

export function collapseIndices(path: string): string {
  return path.replace(/\/\d+(?=\/|$)/g, '/[]')
}

function decodePointer(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((t) => decodeURIComponent(t).replace(/~1/g, '/').replace(/~0/g, '~'))
}

export class Contract {
  private readonly ajv: Ajv2020
  private readonly doc: Json
  private readonly compiled = new Map<string, ValidateFunction>()

  constructor(doc: unknown) {
    this.doc = doc as Json
    // strict: false — the document also carries OpenAPI keywords (paths, discriminator.mapping...).
    this.ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true })
    addFormats(this.ajv)
    this.ajv.addSchema(doc as object, DOC_ID)
  }

  private validator(pointer: string): ValidateFunction {
    let fn = this.compiled.get(pointer)
    if (!fn) {
      fn = this.ajv.compile({ $ref: `${DOC_ID}#${pointer}` })
      this.compiled.set(pointer, fn)
    }
    return fn
  }

  private node(pointer: string): SchemaNode {
    let cur: unknown = this.doc
    for (const t of decodePointer(pointer)) {
      if (cur === null || typeof cur !== 'object') throw new Error(`Bad pointer ${pointer}`)
      cur = (cur as Record<string, unknown>)[t]
    }
    if (cur === undefined) throw new Error(`No schema at ${pointer}`)
    return (typeof cur === 'object' && cur !== null ? cur : {}) as SchemaNode
  }

  validate(pointer: string, data: unknown): ValidationResult {
    const fn = this.validator(pointer)
    const valid = fn(data)
    const errors = [
      ...new Set(
        (fn.errors ?? []).map(
          (e) => `${collapseIndices(e.instancePath) || '/'}: ${e.message ?? e.keyword}`,
        ),
      ),
    ]
    const extras = new Set<string>()
    this.collectExtras(pointer, data, '', extras)
    return { valid, errors, extraProperties: [...extras].sort() }
  }

  private matches(pointer: string, data: unknown): boolean {
    return this.validator(pointer)(data)
  }

  /** Follows `$ref`s to the pointer of the schema that actually describes the data. */
  private deref(pointer: string): string {
    let p = pointer
    for (let i = 0; i < 50; i++) {
      const ref = this.node(p).$ref
      if (typeof ref !== 'string') return p
      if (!ref.startsWith('#')) throw new Error(`External $ref not supported: ${ref}`)
      p = ref.slice(1)
    }
    throw new Error(`$ref loop at ${pointer}`)
  }

  /** Pointers to every property schema the (possibly composed) schema declares. */
  private declaredProperties(
    pointer: string,
    data: unknown,
  ): {
    props: Map<string, string>
    additional: string | boolean
  } {
    const p = this.deref(pointer)
    const node = this.node(p)
    const props = new Map<string, string>()
    let additional: string | boolean = false
    if (node.properties && typeof node.properties === 'object') {
      for (const k of Object.keys(node.properties))
        props.set(k, `${p}/properties/${pointerToken(k)}`)
    }
    const composed = ['allOf', 'oneOf', 'anyOf'].some((kw) => Array.isArray(node[kw]))
    if (node.properties === undefined && !composed && node.additionalProperties !== false) {
      additional = true // free-form object: nothing is "extra"
    } else if (node.additionalProperties === true) additional = true
    else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      additional = `${p}/additionalProperties`
    }
    const branches: string[] = []
    if (Array.isArray(node.allOf))
      node.allOf.forEach((_, i) => branches.push(`${p}/allOf/${String(i)}`))
    const chosen = this.chooseBranch(p, node, data)
    if (chosen !== undefined) branches.push(chosen)
    for (const b of branches) {
      const sub = this.declaredProperties(b, data)
      for (const [k, v] of sub.props) if (!props.has(k)) props.set(k, v)
      if (additional === false) additional = sub.additional
    }
    return { props, additional }
  }

  /** For oneOf/anyOf, the first branch the data validates against (or the first object branch). */
  private chooseBranch(p: string, node: SchemaNode, data: unknown): string | undefined {
    for (const kw of ['oneOf', 'anyOf'] as const) {
      const list = node[kw]
      if (!Array.isArray(list)) continue
      const pointers = list.map((_, i) => `${p}/${kw}/${String(i)}`)
      const hit = pointers.find((b) => this.matches(b, data))
      if (hit !== undefined) return hit
      // Nothing validates: pick the branch declaring the most of the data's keys.
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const keys = Object.keys(data)
        let best: string | undefined
        let bestScore = -1
        for (const b of pointers) {
          const score = keys.filter((k) => this.declaredProperties(b, data).props.has(k)).length
          if (score > bestScore) {
            best = b
            bestScore = score
          }
        }
        return best
      }
    }
    return undefined
  }

  private collectExtras(pointer: string, data: unknown, path: string, out: Set<string>): void {
    if (data === null || typeof data !== 'object') return
    const p = this.deref(pointer)
    if (Array.isArray(data)) {
      const items = this.itemsPointer(p, data)
      if (items === undefined) return
      data.forEach((item, i) => {
        this.collectExtras(items, item, `${path}/${String(i)}`, out)
      })
      return
    }
    const { props, additional } = this.declaredProperties(p, data)
    for (const [k, v] of Object.entries(data)) {
      const childPath = `${path}/${k}`
      const declared = props.get(k)
      if (declared !== undefined) this.collectExtras(declared, v, childPath, out)
      else if (typeof additional === 'string') this.collectExtras(additional, v, childPath, out)
      else if (!additional) out.add(collapseIndices(childPath))
    }
  }

  private itemsPointer(p: string, data: unknown): string | undefined {
    const node = this.node(p)
    if (node.items && typeof node.items === 'object') return `${p}/items`
    const branch = this.chooseBranch(p, node, data)
    return branch === undefined ? undefined : this.itemsPointer(this.deref(branch), data)
  }
}
