import { describe, expect, it } from "vitest";
import { EXERCISE_IMAGE_BASE, exerciseImageUrl } from "./exerciseMedia";

describe("exerciseImageUrl", () => {
  it("turns a bare seed path into a URL on the one host", () => {
    expect(exerciseImageUrl("Barbell_Squat/0.jpg")).toBe(
      `${EXERCISE_IMAGE_BASE}Barbell_Squat/0.jpg`,
    );
    expect(exerciseImageUrl("3_4_Sit-Up/1.jpg")).toBe(
      `${EXERCISE_IMAGE_BASE}3_4_Sit-Up/1.jpg`,
    );
  });

  it("refuses anything that is not a bare path, so a row can never pick the host", () => {
    for (const bad of [
      "https://evil.example/pixel.jpg",
      "//evil.example/x.jpg",
      "../../secret/0.jpg",
      "Barbell_Squat/0.png",
      "Barbell Squat/0.jpg",
      "",
    ]) {
      expect(exerciseImageUrl(bad)).toBeNull();
    }
  });
});
