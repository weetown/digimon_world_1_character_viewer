// One animation duration unit, in seconds.
//
// The viewer plays its clips with `timeScale = 1000 / 60`, which makes one unit 0.06 s.
// SydMontague's DW1ModelConverter (the researched reference for this format) uses 1/20 s,
// about 20% faster; Aspen said the viewer "reads fine" from memory, so the two are close.
// The export follows the reference. It lives here, alone, so it can change in one place;
// the value is also written into the glb's root `extras.timeUnitSeconds`.
export const TIME_UNIT_SECONDS = 1 / 20;

export function unitsToSeconds(units: number) {
  return units * TIME_UNIT_SECONDS;
}
