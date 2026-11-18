// How a door is named (P5.6). One definition, shared by main — the door-action answers, the toast
// and `unlock.log` — and the renderer's Doors screen cards, so the name in a log line is the name
// on the card that was pressed. As `cameraDisplayName` (./cameraOrder.ts) is for cameras.
//
// Imports only a type from ./models, so it pulls nothing into either bundle.
import type { Door } from './models'

/**
 * A door's name: Access's `full_name` (it carries the floor, e.g. "Ground Floor - Front Door"),
 * then its `name`, then the id. The id is never pretty, but a door the user cannot tell from the
 * others at all is worse than an ugly one.
 */
export function doorDisplayName(door: Pick<Door, 'id' | 'name' | 'fullName'>): string {
  const full = door.fullName.trim()
  if (full !== '') return full
  const short = door.name.trim()
  if (short !== '') return short
  return door.id
}
