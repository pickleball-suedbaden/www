// Pickleball Südbaden e.V. · session organiser · signals made with Web Audio (no sound files).
// Loud, simple shapes that carry through a speaker in a sports hall:
//   warn  – two double beeps, 1 minute before the end
//   horn  – two long blasts at the end ("finish the point")
//   start – three short beeps and a long one when the changeover ends

let ctx = null, out = null;

export function audioReady() { return !!ctx && ctx.state === 'running'; }

/** Create or resume the audio context. Call from a tap (iOS only allows audio after one). */
export function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iOS: play with the silent switch on
  } catch (e) { /* ignore */ }
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
    out = ctx.createGain();
    out.gain.value = 0.95;
    comp.connect(out).connect(ctx.destination);
    out = comp;
    // A silent buffer finishes the unlock on older iOS versions.
    const b = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
    src.buffer = b; src.connect(ctx.destination); src.start(0);
  }
  if (ctx.state !== 'running') ctx.resume();
  return true;
}

function tone(freqs, start, dur, type = 'square', vol = 0.5, vibrato = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.02);
  g.gain.setValueAtTime(vol, start + dur - 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  g.connect(out);
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    if (vibrato) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 6; lg.gain.value = vibrato;
      lfo.connect(lg).connect(o.frequency); lfo.start(start); lfo.stop(start + dur);
    }
    o.connect(g); o.start(start); o.stop(start + dur + 0.02);
  }
}

export function play(kind) {
  if (!ctx) return false;
  if (ctx.state !== 'running') ctx.resume();
  const t = ctx.currentTime + 0.05;
  if (kind === 'warn') {
    for (const k of [0, 0.7]) { tone([1320], t + k, 0.16, 'square', 0.5); tone([1320], t + k + 0.24, 0.16, 'square', 0.5); }
  } else if (kind === 'horn') {
    tone([233, 294, 349], t, 1.3, 'sawtooth', 0.6, 3);
    tone([233, 294, 349], t + 1.55, 1.8, 'sawtooth', 0.6, 3);
  } else if (kind === 'start') {
    for (const k of [0, 0.6, 1.2]) tone([880], t + k, 0.18, 'square', 0.5);
    tone([1320, 660], t + 1.8, 0.9, 'square', 0.55);
  }
  return true;
}
