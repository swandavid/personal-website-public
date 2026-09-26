import { describe, expect, it } from "vitest";
import { geoArea } from "d3-geo";
import type { Feature, Polygon } from "geojson";
import { pointsAlong, rewind } from "./geo";

describe("rewind", () => {
  it("flips a counter-clockwise polygon so it covers only itself", () => {
    const ccw: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    };
    expect(geoArea(ccw)).toBeGreaterThan(2 * Math.PI);
    expect(geoArea(rewind(ccw))).toBeLessThan(0.001);
  });
});

describe("pointsAlong", () => {
  const line = [
    [0, 0],
    [1, 0],
    [2, 0],
  ];

  it("scales distances to the stated total", () => {
    const [half] = pointsAlong(line, 10, [5]);
    expect(half!.position[0]).toBeCloseTo(1, 6);
  });

  it("interpolates inside a segment", () => {
    const [quarter] = pointsAlong(line, 4, [1]);
    expect(quarter!.position[0]).toBeCloseTo(0.5, 6);
  });
});
