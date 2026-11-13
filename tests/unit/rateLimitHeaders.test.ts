// P1.3 (SPEC §5.1, R9): the allowlist filter for the console's rate-limit headers. The `pk`
// partition key must never survive it. These tests moved here with the module itself, which the
// P0.3 spike (scripts/spikes/lib/sanitize.ts) used to own.
import { describe, expect, it } from 'vitest'
import { collectRateLimitHeaders, filterRateLimitHeader } from '../../src/main/net/rateLimitHeaders'

describe('filterRateLimitHeader', () => {
  it('drops the partition key and keeps known parameters', () => {
    expect(filterRateLimitHeader('"10-in-1sec"; q=10; w=1; pk=:c2VjcmV0LXBrLXZhbHVl:')).toBe(
      '"10-in-1sec"; q=10; w=1',
    )
    expect(filterRateLimitHeader('"10-in-1sec"; r=7; t=1')).toBe('"10-in-1sec"; r=7; t=1')
  })

  it('drops unknown or non-numeric parameters', () => {
    expect(filterRateLimitHeader('limit=10; remaining=3; reset=1; foo=2; q=abc')).toBe(
      'limit=10; remaining=3; reset=1',
    )
  })

  it('drops an unquoted policy name, since only the quoted form is a known shape', () => {
    // A bare token is not kept: the policy name is cosmetic, and accepting arbitrary tokens is how
    // something that is not a policy name at all would reach the log.
    expect(filterRateLimitHeader('tokenlike')).toBe('')
    expect(filterRateLimitHeader('tokenlike; q=10')).toBe('q=10')
    expect(filterRateLimitHeader('"10-in-1sec"; q=10')).toBe('"10-in-1sec"; q=10')
  })

  it('keeps a plain number (retry-after) and filters each list member', () => {
    expect(filterRateLimitHeader('1')).toBe('1')
    expect(filterRateLimitHeader('"a"; q=1; pk=:x:, "b"; w=2')).toBe('"a"; q=1, "b"; w=2')
  })
})

describe('collectRateLimitHeaders', () => {
  const headersOf = (entries: Record<string, string>) => ({
    keys: () => Object.keys(entries),
    get: (name: string) => entries[name] ?? null,
  })

  it('collects only rate-limit headers, filtered and lowercased', () => {
    expect(
      collectRateLimitHeaders(
        headersOf({
          RateLimit: '"10-in-1sec"; r=7; t=1',
          'ratelimit-policy': '"10-in-1sec"; q=10; w=1; pk=:c2VjcmV0:',
          'retry-after': '1',
          'content-type': 'application/json',
          'x-api-key': 'should-never-be-read',
        }),
      ),
    ).toEqual({
      ratelimit: '"10-in-1sec"; r=7; t=1',
      'ratelimit-policy': '"10-in-1sec"; q=10; w=1',
      'retry-after': '1',
    })
  })

  it('ignores a header whose name merely contains "rate", "retry" or "limit"', () => {
    // The old substring match copied these straight into the log.
    expect(
      collectRateLimitHeaders(
        headersOf({
          'x-corporate-id': 'tokenlike',
          'x-retry-token': 'secret-ish',
          'limit-breaker': 'opaque',
        }),
      ),
    ).toEqual({})
  })

  it('drops a rate-limit header with nothing safe left in it', () => {
    expect(collectRateLimitHeaders(headersOf({ 'ratelimit-policy': 'pk=:c2VjcmV0:' }))).toEqual({})
  })

  it('is empty when there are no rate-limit headers', () => {
    expect(collectRateLimitHeaders(headersOf({ 'content-type': 'image/jpeg' }))).toEqual({})
  })
})
