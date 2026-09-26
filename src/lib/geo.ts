import { geoArea, geoDistance } from "d3-geo";
import type { Feature, GeoJsonProperties, Geometry, Position } from "geojson";

/**
 * d3 expects clockwise exterior rings. GeoJSON from most other sources
 * (RFC 7946) is counter-clockwise, which d3 reads as "the whole globe except
 * this shape". Reverse the rings of any feature that covers over half the
 * sphere.
 */
export function rewind<T extends Feature<Geometry, GeoJsonProperties>>(
  f: T,
): T {
  if (geoArea(f) <= 2 * Math.PI) return f;
  const g = f.geometry;
  if (g.type === "Polygon")
    g.coordinates = g.coordinates.map((r) => r.toReversed());
  if (g.type === "MultiPolygon")
    g.coordinates = g.coordinates.map((p) => p.map((r) => r.toReversed()));
  return f;
}

/**
 * Points at the given distances along a line, with distances scaled so the
 * whole line measures `total`. GPS tracks run a little long, so this puts
 * "mile 20" at 20/26.2 of the way along rather than at a raw 20 GPS miles.
 */
export function pointsAlong(
  line: Position[],
  total: number,
  at: number[],
): { at: number; position: Position }[] {
  const cumulative = [0];
  for (let i = 1; i < line.length; i++) {
    cumulative.push(
      cumulative[i - 1]! +
        geoDistance(
          line[i - 1] as [number, number],
          line[i] as [number, number],
        ),
    );
  }
  const length = cumulative.at(-1)!;
  return at.map((d) => {
    const target = (d / total) * length;
    const i = Math.max(
      1,
      cumulative.findIndex((c) => c >= target),
    );
    const [a, b] = [line[i - 1]!, line[i]!];
    const span = cumulative[i]! - cumulative[i - 1]! || 1;
    const t = (target - cumulative[i - 1]!) / span;
    return {
      at: d,
      position: [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t],
    };
  });
}
