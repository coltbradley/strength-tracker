// A short tone for the end of rest.
//
// WHY THIS EXISTS AT ALL: the rest strip's only announcement used to be
// `new Notification(...)`, and an iPhone home-screen app cannot run that
// constructor — only `ServiceWorkerRegistration.showNotification`, which needs
// a push subscription and a server we do not have. `navigator.vibrate` does
// not exist on iOS either. So on the one device this app is actually used on,
// rest ended in complete silence and the lifter found out by picking the phone
// up. A tone is the one cue an installed iOS web app can produce by itself.
//
// WHY AN OSCILLATOR AND NOT A FILE: an audio file is an asset, and an asset is
// a precache entry in the service worker, a byte range that has to survive
// every deploy, and one more thing that can 404 into a silent failure offline.
// Two sine blips are a dozen lines and no bytes.
//
// WHY THE UNLOCK IS SEPARATE: iOS refuses to start an AudioContext outside a
// user gesture, and it stays refused — a context created during a timer
// callback is born "suspended" and never recovers. So the context has to be
// created (and resumed) on a real tap, and the LOG tap is the natural one: by
// definition it is the gesture that starts the rest this cue will end. That is
// the whole reason `unlockRestCue` is a separate export rather than something
// `playRestCue` does for itself.
//
// EVERYTHING HERE IS BEST-EFFORT AND SILENT. A missing AudioContext, a
// rejected resume, a browser that throws on `createOscillator` — none of them
// is a fact the lifter can act on mid-set, and none of them costs any data. A
// cue that fails is a cue that did not happen, not an error.

/** Structural type: we never touch anything beyond this, and typing it
 *  ourselves means the module compiles whether or not the DOM lib in use
 *  declares `webkitAudioContext`. */
type AudioContextCtor = new () => AudioContext;

/**
 * The one context. Created on the first unlock and kept for the life of the
 * page: Safari caps how many AudioContexts a document may create, and a new
 * one per rest would hit that cap inside a single workout.
 */
let ctx: AudioContext | null = null;

function contextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * Call from a real user gesture — the LOG tap. Creates the context the first
 * time and resumes it every time, because iOS suspends it again whenever the
 * app is backgrounded and a suspended context plays nothing.
 *
 * Idempotent and cheap after the first call, which is why the caller does not
 * have to remember whether it has run.
 */
export function unlockRestCue(): void {
  try {
    if (ctx === null) {
      const Ctor = contextCtor();
      if (Ctor === null) return;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") {
      // Deliberately not awaited: the gesture is over by the time it settles,
      // and the only thing a rejection tells us is that there will be no
      // sound — which is already the situation we are trying to leave.
      void Promise.resolve(ctx.resume()).catch(() => undefined);
    }
  } catch {
    // No audio on this device. Nothing to say and nothing to retry.
    ctx = null;
  }
}

/** peak gain of one blip — audible across a gym, nowhere near clipping */
const PEAK = 0.25;
/** seconds each blip sounds for */
const BLIP_SECONDS = 0.12;
/** seconds between the start of the first blip and the second */
const BLIP_GAP_SECONDS = 0.18;

/**
 * One blip. The gain ramps in and out rather than switching, because a square
 * edge on a sine wave is a click, and two clicks either side of a short tone
 * is most of what the tone sounds like.
 */
function blip(ac: AudioContext, at: number, hz: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = hz;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(PEAK, at + 0.01);
  gain.gain.linearRampToValueAtTime(0, at + BLIP_SECONDS);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(at);
  // A stopped oscillator is collected; one that is only disconnected is not.
  osc.stop(at + BLIP_SECONDS + 0.02);
}

/**
 * Play the cue. Does nothing at all until `unlockRestCue` has run from a
 * gesture — not as a policy of ours, but because there is no context to play
 * into, and creating one here is exactly the move iOS refuses.
 */
export function playRestCue(): void {
  const ac = ctx;
  if (ac === null) return;
  try {
    // Backgrounding suspends the context. Resume is asynchronous, so this
    // particular cue may still be lost; the next one will not be. Scheduling
    // the blips regardless is harmless either way.
    if (ac.state === "suspended") {
      void Promise.resolve(ac.resume()).catch(() => undefined);
    }
    const t = ac.currentTime;
    blip(ac, t, 880);
    blip(ac, t + BLIP_GAP_SECONDS, 1320);
  } catch {
    // cosmetic, exactly like the notification path next to it
  }
}
