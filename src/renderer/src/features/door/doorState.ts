// What the unlock control shows of its door's lock state (P5.5; DOOR-6). Pure: `<UnlockButton>`
// reads `doorStates` from the store (main's pushed map of the linked doors it knows) and asks this.
//
// Two looks only:
//  - `unlocked`: the door's lock relay is released (`relay: 'unlock'`), whoever released it — this
//    app, a card, the Access app, a schedule. Open-door icon, green.
//  - `neutral`: **locked or not known**. A linked door that is missing from the map is unknown (not
//    read yet, the read is failing, Access is off, nobody is watching) and is drawn exactly like a
//    locked one: never green, and never claimed to be locked either — the words say only what a
//    hold does.
//
// The door position sensor (`position`) is not shown: the control is about the lock.
import type { DoorStates } from '@shared/models'

export type DoorLook = 'unlocked' | 'neutral'

/** The look for the door `doorId` (`null`: the cell has no door), given what main knows. */
export function doorLook(doorId: string | null, doorStates: Readonly<DoorStates>): DoorLook {
  // `Object.hasOwn`: a door id such as `constructor` must not find a prototype member.
  if (doorId === null || !Object.hasOwn(doorStates, doorId)) return 'neutral'
  return doorStates[doorId]?.relay === 'unlock' ? 'unlocked' : 'neutral'
}

/** The accessible name: what the control does, plus the state when it is known to be unlocked. */
export function unlockLabel(look: DoorLook): string {
  return look === 'unlocked' ? 'Unlock door (currently unlocked)' : 'Unlock door'
}

/** The tooltip while the control is at rest (a hold or a request in flight has its own). */
export function unlockRestTitle(look: DoorLook): string {
  return look === 'unlocked'
    ? 'Door is unlocked. Hold to unlock it again'
    : 'Hold to unlock the door'
}
