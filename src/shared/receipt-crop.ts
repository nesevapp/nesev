// Cropping/straightening photographed receipts (used by the crop dialog and the server).
// A quad is four normalized [x, y] corners (0..1, origin top-left) on the image as displayed, i.e. after its
// EXIF orientation, in the order top-left, top-right, bottom-right, bottom-left.

export type QuadPoint = [number, number];
export type Quad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

export const FULL_QUAD: Quad = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** File extensions the crop helper accepts (receipt photos; PDFs can't be cropped). */
export const CROPPABLE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

export function isCroppablePath(path: string | null | undefined): boolean {
  const ext = path?.toLowerCase().split(".").pop();
  return !!ext && CROPPABLE_EXTENSIONS.includes(ext);
}

/** Area of the quad as a fraction of the image (shoelace formula). */
export function quadArea(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i]!;
    const [bx, by] = q[(i + 1) % 4]!;
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

/** Convex and clockwise on screen (TL → TR → BR → BL), i.e. corners neither crossed nor folded in. */
export function isConvexQuad(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i]!;
    const [bx, by] = q[(i + 1) % 4]!;
    const [cx, cy] = q[(i + 2) % 4]!;
    // y points down, so a clockwise turn has a positive cross product
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) <= 0) return false;
  }
  return true;
}

/** Minimum share of the image a crop must keep. */
export const MIN_QUAD_AREA = 0.01;

/** German reason why the quad can't be used, or null. */
export function quadProblem(q: Quad): string | null {
  if (!isConvexQuad(q)) return "Die Ecken überkreuzen sich – bitte so anordnen, dass ein Viereck entsteht";
  if (quadArea(q) < MIN_QUAD_AREA) return "Der Ausschnitt ist zu klein";
  return null;
}
