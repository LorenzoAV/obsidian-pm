import { describe, expect, it } from 'vitest'
import { dropPositionFor } from './dropPosition'

describe('dropPositionFor', () => {
  it('returns before when clientY is above the middle', () => {
    expect(dropPositionFor(100, 100, 100)).toBe('before')
  })

  it('returns after when clientY is below the middle', () => {
    expect(dropPositionFor(200, 100, 100)).toBe('after')
  })

  it('returns after when clientY is exactly at the middle', () => {
    expect(dropPositionFor(150, 100, 100)).toBe('after')
  })

  it('handles zero height gracefully', () => {
    expect(dropPositionFor(0, 0, 0)).toBe('after')
  })

  it('works with negative coordinates', () => {
    // middle = -100 + 50 = -50, clientY = -50 is not < middle, so 'after'
    expect(dropPositionFor(-50, -100, 100)).toBe('after')
    // middle = -100 + 50 = -50, clientY = 0 > middle, so 'after'
    expect(dropPositionFor(0, -100, 100)).toBe('after')
    // clientY = -100 < middle (-50), so 'before'
    expect(dropPositionFor(-100, -100, 100)).toBe('before')
  })
})
