// @vitest-environment jsdom
// `started_at` and `ended_at` have existed since the first migration and were
// shown nowhere. The only trap in surfacing them is the format: formatClock
// would render a 72-minute session as "72:00", which reads as 72 seconds.

import { describe, expect, it } from "vitest";
import { formatDuration } from "./End";

describe("formatDuration", () => {
  it("reads in minutes under an hour", () => {
    expect(formatDuration(0)).toBe("0 MIN");
    expect(formatDuration(59)).toBe("0 MIN");
    expect(formatDuration(47 * 60)).toBe("47 MIN");
    expect(formatDuration(59 * 60 + 59)).toBe("59 MIN");
  });

  it("switches to hours rather than counting past 60", () => {
    expect(formatDuration(60 * 60)).toBe("1H 00M");
    expect(formatDuration(72 * 60)).toBe("1H 12M");
    expect(formatDuration(125 * 60 + 30)).toBe("2H 05M");
  });
});
