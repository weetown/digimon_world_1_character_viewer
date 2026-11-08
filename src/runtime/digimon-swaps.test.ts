import { describe, expect, it } from "vitest";

import { stateAt } from "./digimon-swaps";

describe("stateAt", () => {
  const entry = {
    events: [
      { time: 0, state: 0 },
      { time: 0.5, state: 1 },
      { time: 1.0, state: 2 },
    ],
    loop: null,
  };

  it("returns the latest event at or before the time", () => {
    expect(stateAt(entry, 0)).toBe(0);
    expect(stateAt(entry, 0.49)).toBe(0);
    expect(stateAt(entry, 0.5)).toBe(1);
    expect(stateAt(entry, 3)).toBe(2);
  });

  it("wraps inside an infinite loop block", () => {
    const looped = { ...entry, loop: { start: 0.5, end: 1.5, repetitions: 255 } };
    // 1.6 wraps to 0.6 -> state 1; 2.6 wraps to 0.6 -> state 1; 2.4 wraps to 1.4 -> state 2
    expect(stateAt(looped, 1.6)).toBe(1);
    expect(stateAt(looped, 2.6)).toBe(1);
    expect(stateAt(looped, 2.4)).toBe(2);
    expect(stateAt(looped, 0.2)).toBe(0);
  });
});
