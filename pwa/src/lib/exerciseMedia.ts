// Where the seed's demo photos live.
//
// `exercises.images` stores PATHS ("Barbell_Squat/0.jpg"), not URLs, and the
// database CHECK refuses anything else. The host is this one constant, so a
// mirror or a move is one edit here and nothing in 873 rows. It is also why a
// row can never point a session screen at an origin nobody chose: the library
// is shared, and an 'edited' row is read by every account.
//
// These are cross-origin and the service worker caches nothing cross-origin on
// purpose (fonts are self-hosted for the same reason), so photos are an
// online nicety. The STEPS travel with the exercise row and are cached in
// IndexedDB like every other read, so they survive a basement.

export const EXERCISE_IMAGE_BASE =
  "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

const IMAGE_PATH = /^[0-9A-Za-z_-]+\/[0-9]+\.jpg$/;

/** A bare path becomes a URL; anything else becomes nothing. Defence in depth
 *  with the DB check — the client never trusts the shape it was handed. */
export function exerciseImageUrl(path: string): string | null {
  return IMAGE_PATH.test(path) ? EXERCISE_IMAGE_BASE + path : null;
}
