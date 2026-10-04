/** Returns 'before' if the cursor is in the upper half of the row, 'after' otherwise. */
export function dropPositionFor(clientY: number, top: number, height: number): 'before' | 'after' {
  const middle = top + height / 2
  return clientY < middle ? 'before' : 'after'
}
