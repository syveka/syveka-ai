/**
 * Reports the device's speech voices now, on every `voiceschanged` update,
 * and once more with `final: true` after `waitMs`. Android lists voices late
 * and in several updates, so an early (possibly partial) list never settles
 * an answer on its own. `onVoices` returning `true` ends the watch early.
 * Returns a cleanup that removes the listener and the timer; it is safe to
 * call more than once.
 */
export function watchVoices(
  synth: SpeechSynthesis,
  onVoices: (voices: SpeechSynthesisVoice[], final: boolean) => boolean | void,
  waitMs: number,
): () => void {
  let done = false;
  const onChange = () => report(false);
  const timer = setTimeout(() => report(true), waitMs);
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    synth.removeEventListener?.("voiceschanged", onChange);
  };
  function report(final: boolean) {
    if (done) return;
    if (onVoices(synth.getVoices(), final) === true) cleanup();
  }
  synth.addEventListener?.("voiceschanged", onChange);
  report(false);
  return cleanup;
}
