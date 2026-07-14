(function minimalWaveVisualizer() {
  "use strict";

  const ROOT_ID = "minimal-wave-visualizer";
  const EXTENSION_VERSION = "MWV v1.0";
  const PROJECT_SETUP_URL = "https://github.com/Adamvi/Minimal-Wave-Visualizer#native-fft-setup";
  const NATIVE_BASS_URL = "ws://127.0.0.1:43827/mwv-bass-v1";
  const BAR_COUNT = 56;
  const BAR_REFERENCE_FRAME_MS = 1000 * 1024 / 44100;
  const FALLBACK_FRAME_MS = 15;
  const NATIVE_SOURCE_MAX_AGE_MS = 250;
  const NATIVE_SOURCE_FUTURE_TOLERANCE_MS = 1000;
  const DROP_DURATION_MS = 1450;
  const WAVE_MAX_DEPTH = 0.62;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function statusText(nativeActive) {
    return `${EXTENSION_VERSION} ${nativeActive ? "FFT" : "PREVIEW"}`;
  }

  function parseNativeBassFrame(payload, receivedAt, receivedUnixMs = Date.now()) {
    if (!payload || typeof payload !== "object" || payload.v !== 1 ||
        typeof payload.capturing !== "boolean") {
      return null;
    }

    const numericFields = ["pid", "sampleRate", "subDb", "energy", "onset", "activeMs"];
    if (numericFields.some((field) => typeof payload[field] !== "number")) {
      return null;
    }

    const pid = finiteNumber(payload.pid);
    const sampleRate = finiteNumber(payload.sampleRate);
    const subDb = finiteNumber(payload.subDb);
    const energy = finiteNumber(payload.energy);
    const onset = finiteNumber(payload.onset);
    const activeMs = finiteNumber(payload.activeMs);
    const timestamp = finiteNumber(receivedAt);
    const receivedUnixTimestamp = finiteNumber(receivedUnixMs);
    const capturedAtUnixMs = payload.capturedAtUnixMs === undefined
      ? null
      : typeof payload.capturedAtUnixMs === "number" ? finiteNumber(payload.capturedAtUnixMs) : null;

    if ([pid, sampleRate, subDb, energy, onset, activeMs, timestamp, receivedUnixTimestamp].some((value) => value === null) ||
        (payload.capturedAtUnixMs !== undefined && capturedAtUnixMs === null)) {
      return null;
    }

    if (payload.capturing && pid <= 0) {
      return null;
    }

    let spectrum = null;
    if (payload.spectrum !== undefined && payload.spectrum !== null) {
      if (!Array.isArray(payload.spectrum) || payload.spectrum.length !== BAR_COUNT ||
          payload.spectrum.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        return null;
      }
      spectrum = payload.spectrum.map((value) => clamp(value, 0, 1));
    }

    return {
      v: 1,
      capturing: payload.capturing,
      pid: Math.round(clamp(pid, 0, 2147483647)),
      sampleRate: Math.round(clamp(sampleRate, 8000, 192000)),
      subDb: clamp(subDb, -120, 6),
      energy: clamp(energy, 0, 1),
      onset: clamp(onset, 0, 1),
      activeMs: Math.round(clamp(activeMs, 0, 600000)),
      spectrum,
      receivedAt: Math.max(0, timestamp),
      receivedUnixMs: Math.max(0, receivedUnixTimestamp),
      capturedAtUnixMs: capturedAtUnixMs === null ? null : Math.max(0, Math.round(capturedAtUnixMs)),
    };
  }

  function nativeFrameSourceFresh(frame, nowUnixMs) {
    const now = finiteNumber(nowUnixMs);
    const capturedAt = frame && frame.capturedAtUnixMs !== null && frame.capturedAtUnixMs !== undefined
      ? finiteNumber(frame.capturedAtUnixMs)
      : null;
    if (!frame || now === null) {
      return false;
    }
    if (capturedAt === null) {
      return true;
    }

    const age = now - capturedAt;
    return age >= -NATIVE_SOURCE_FUTURE_TOLERANCE_MS && age <= NATIVE_SOURCE_MAX_AGE_MS;
  }

  function nativeBassAvailable(frame, now, nowUnixMs = Date.now()) {
    const timestamp = finiteNumber(now);
    if (!frame || !frame.capturing || timestamp === null || !nativeFrameSourceFresh(frame, nowUnixMs)) {
      return false;
    }

    const age = timestamp - frame.receivedAt;
    return age >= 0 && age <= 200;
  }

  function nativeBassMotion(frame, now, playing, reduceMotion, previousFrame = null) {
    if (!nativeBassAvailable(frame, now) || !playing || reduceMotion) {
      return null;
    }

    const toneChange = previousFrame && previousFrame.energy >= 0.1 && frame.energy >= 0.1
      ? bassToneChange(previousFrame.spectrum, frame.spectrum)
      : 0;

    return {
      energy: frame.energy,
      target: clamp(0.65 * frame.energy + 0.18 * frame.onset, 0, 1),
      releaseSeconds: clamp(0.06 + frame.activeMs / 1000, 0.06, 0.8),
      reactivity: clamp(frame.onset * 3 + toneChange, 0, 1),
    };
  }

  function nativeBassStatus(frame, socketOpen) {
    return Boolean(socketOpen && frame && frame.capturing);
  }

  function bassShakeRate(activeMs, reactivity) {
    const sustained = clamp(((finiteNumber(activeMs) ?? 0) - 180) / 420, 0, 1);
    return 8.3 - sustained * (1 - clamp(finiteNumber(reactivity) ?? 0, 0, 1)) * 6.1;
  }

  function bassTonePosition(spectrum) {
    if (!Array.isArray(spectrum)) {
      return null;
    }

    const count = Math.min(6, spectrum.length);
    let total = 0;
    let weighted = 0;
    for (let index = 0; index < count; index += 1) {
      const level = clamp(finiteNumber(spectrum[index]) ?? 0, 0, 1);
      total += level;
      weighted += level * index;
    }

    return total >= 0.12 ? weighted / total / Math.max(1, count - 1) : null;
  }

  function bassToneChange(previousSpectrum, spectrum) {
    const previous = bassTonePosition(previousSpectrum);
    const current = bassTonePosition(spectrum);
    return previous === null || current === null ? 0 : clamp(Math.abs(current - previous) * 1.35, 0, 1);
  }

  function average(values) {
    if (!values.length) {
      return 0.35;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function normalizeDurationMs(value) {
    const duration = finiteNumber(value);

    if (!duration || duration <= 0) {
      return 0;
    }

    return duration > 10000 ? duration : duration * 1000;
  }

  function normalizePercent(value) {
    const percent = finiteNumber(value);

    if (percent === null) {
      return null;
    }

    return clamp(percent > 1 ? percent / 100 : percent, 0, 1);
  }

  function normalizeProgressMs(value, durationMs) {
    const progress = finiteNumber(value);

    if (progress === null || progress < 0) {
      return null;
    }

    if (durationMs > 0 && progress <= 1) {
      return progress * durationMs;
    }

    if (durationMs > 10000 && progress <= durationMs / 1000 + 5) {
      return progress * 1000;
    }

    return durationMs > 0 ? clamp(progress, 0, durationMs) : progress;
  }

  function stableVisualizerBottom(playbarTop, viewportHeight, currentBottom) {
    const top = finiteNumber(playbarTop);

    if (top === null || top < viewportHeight * 0.5 || top > viewportHeight) {
      return currentBottom || 96;
    }

    return Math.max(76, viewportHeight - top + 10);
  }

  function loudnessLevel(segment, seconds) {
    const start = finiteNumber(segment && segment.loudness_start);
    const max = finiteNumber(segment && segment.loudness_max);

    if (max === null && start === null) {
      return 0.35;
    }

    const segmentStart = finiteNumber(segment && segment.start) || 0;
    const maxTime = finiteNumber(segment && segment.loudness_max_time) || 0;
    const localTime = Math.max(0, seconds - segmentStart);
    const attack = maxTime > 0 ? clamp(localTime / maxTime, 0, 1) : 1;
    const loudness = (start ?? max) + ((max ?? start) - (start ?? max)) * attack;

    return Math.pow(clamp((loudness + 42) / 36, 0, 1), 1.35);
  }

  function pitchValues(segment) {
    const pitches = Array.isArray(segment && segment.pitches)
      ? segment.pitches
      : [];

    return Array.from({ length: 12 }, (_, index) =>
      clamp(finiteNumber(pitches[index]) ?? 0.35, 0, 1)
    );
  }

  function pitchAt(pitches, position) {
    if (!pitches.length) {
      return 0.35;
    }

    const scaled = clamp(position, 0, 1) * (pitches.length - 1);
    const lower = Math.floor(scaled);
    const upper = Math.min(pitches.length - 1, lower + 1);
    const mix = scaled - lower;

    return pitches[lower] * (1 - mix) + pitches[upper] * mix;
  }

  function timbreLevel(segment, index) {
    const timbre = Array.isArray(segment && segment.timbre)
      ? segment.timbre
      : [];
    const value = finiteNumber(timbre[index]);

    return value === null ? 0.5 : clamp(0.5 + value / 120, 0, 1);
  }

  function bassToneLevel(segment) {
    const brightness = timbreLevel(segment, 1);
    const flatness = timbreLevel(segment, 2);
    const darkness = clamp((0.5 - brightness) / 0.4, 0, 1);
    const body = clamp((0.5 - flatness) / 0.4, 0, 1);

    return clamp(darkness * 0.65 + body * 0.35, 0, 1);
  }

  function attackLevel(segment) {
    const start = finiteNumber(segment && segment.loudness_start);
    const max = finiteNumber(segment && segment.loudness_max);
    const rise = start === null && max === null
      ? 0.35
      : clamp(((max ?? start) - (start ?? max)) / 30, 0, 1);
    const maxTime = finiteNumber(segment && segment.loudness_max_time);
    const fast = maxTime === null ? 0.45 : clamp(1 - maxTime / 0.28, 0, 1);

    return clamp(rise * 0.58 + fast * 0.22 + timbreLevel(segment, 3) * 0.2, 0, 1);
  }

  function fallbackLevels(count, seconds, playing) {
    return Array.from({ length: count }, (_, index) => {
      const t = index / Math.max(1, count - 1);
      const pulse = playing ? Math.sin(seconds * 5.4 + index * 0.48) * 0.11 : 0;

      return clamp(
        0.18 +
          Math.sin(t * Math.PI * 6 + seconds * 0.9) * 0.24 +
          Math.sin(t * Math.PI * 17 + seconds * 1.6) * 0.15 +
          pulse,
        0.03,
        0.92
      );
    });
  }

  function findSegmentIndex(segments, seconds) {
    let low = 0;
    let high = segments.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const segment = segments[mid];
      const start = finiteNumber(segment.start) || 0;
      const end = start + (finiteNumber(segment.duration) || 0);

      if (seconds < start) {
        high = mid - 1;
      } else if (seconds >= end && mid < segments.length - 1) {
        low = mid + 1;
      } else {
        return mid;
      }
    }

    return clamp(low, 0, segments.length - 1);
  }

  function timedPulse(items, seconds, width) {
    const timedItems = Array.isArray(items) ? items : [];

    if (!timedItems.length) {
      return 0;
    }

    const index = findSegmentIndex(timedItems, seconds);
    const item = timedItems[index];
    const start = finiteNumber(item && item.start) || 0;
    const confidence = finiteNumber(item && item.confidence) ?? 0.6;
    const distance = Math.abs(seconds - start);

    return clamp(1 - distance / width, 0, 1) * clamp(confidence, 0.25, 1);
  }

  function peakLoudnessDb(segment) {
    return (
      finiteNumber(segment && segment.loudness_max) ??
      finiteNumber(segment && segment.loudness_start)
    );
  }

  function peakLoudnessLevel(segment) {
    const loudness = peakLoudnessDb(segment);

    if (loudness === null) {
      return 0.35;
    }

    return Math.pow(clamp((loudness + 42) / 36, 0, 1), 1.25);
  }

  function percentile(values, position) {
    if (!values.length) {
      return null;
    }

    const sorted = [...values].sort((first, second) => first - second);
    const index = clamp(position, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.min(sorted.length - 1, lower + 1);
    const mix = index - lower;

    return sorted[lower] * (1 - mix) + sorted[upper] * mix;
  }

  function buildBassProfile(audioData) {
    const segments = Array.isArray(audioData && audioData.segments)
      ? audioData.segments
      : [];
    const loudnessValues = segments.map(peakLoudnessDb).filter((value) => value !== null);
    const toneValues = segments.map(bassToneLevel);

    if (!loudnessValues.length) {
      return null;
    }

    let loudnessLow = percentile(loudnessValues, 0.15);
    let loudnessHigh = percentile(loudnessValues, 0.9);
    if (loudnessHigh - loudnessLow < 6) {
      const midpoint = (loudnessLow + loudnessHigh) / 2;
      loudnessLow = midpoint - 3;
      loudnessHigh = midpoint + 3;
    }

    let toneLow = percentile(toneValues, 0.2) ?? 0;
    let toneHigh = percentile(toneValues, 0.8) ?? 1;
    const toneAdaptive = toneHigh - toneLow >= 0.12;

    return { loudnessHigh, loudnessLow, toneAdaptive, toneHigh, toneLow };
  }

  function profileLevel(value, low, high, fallback) {
    return value === null || !Number.isFinite(low) || !Number.isFinite(high)
      ? fallback
      : clamp((value - low) / Math.max(0.001, high - low), 0, 1);
  }

  function bassToneEvidence(segment, profile, segmentElapsed) {
    const absoluteTone = bassToneLevel(segment);
    const relativeTone = profile && profile.toneAdaptive
      ? profileLevel(absoluteTone, profile.toneLow, profile.toneHigh, absoluteTone)
      : absoluteTone;
    const tone = clamp(absoluteTone * 0.45 + relativeTone * 0.55, 0, 1);
    const duration = clamp(finiteNumber(segment && segment.duration) ?? 0.35, 0.04, 1);
    const floor = 0.25 * clamp(segmentElapsed / Math.min(0.12, duration * 0.35), 0, 1);

    return floor + tone * (1 - floor);
  }

  function smoothBassEnvelope(current, target, deltaSeconds, bassDuration = 0.4) {
    const duration = clamp(finiteNumber(bassDuration) ?? 0.4, 0.06, 0.8);
    const timeConstant = target > current
      ? clamp(duration * 0.16, 0.012, 0.035)
      : clamp(duration * 0.55, 0.06, 0.32);
    const mix = 1 - Math.exp(-Math.max(0, deltaSeconds) / timeConstant);

    return current + (target - current) * mix;
  }

  function timbreValues(segment) {
    const timbre = Array.isArray(segment && segment.timbre)
      ? segment.timbre
      : [];

    return Array.from({ length: 12 }, (_, index) =>
      clamp(0.5 + (finiteNumber(timbre[index]) ?? 0) / 120, 0, 1)
    );
  }

  function vectorDistance(first, second) {
    const length = Math.max(first.length, second.length);

    if (!length) {
      return 0;
    }

    let total = 0;
    for (let index = 0; index < length; index += 1) {
      total += Math.abs((first[index] ?? 0) - (second[index] ?? 0));
    }

    return clamp(total / length, 0, 1);
  }

  function vocalPresenceLevel(segment) {
    const pitches = pitchValues(segment);
    const focusedPitches = [...pitches].sort((first, second) => second - first).slice(0, 3);
    const pitchFocus = clamp((average(focusedPitches) - average(pitches)) * 1.7, 0, 1);
    const brightness = timbreLevel(segment, 1);
    const body = 1 - timbreLevel(segment, 2);
    const balancedBrightness = clamp(1 - Math.abs(brightness - 0.58) * 1.7, 0, 1);
    const sustain = clamp((finiteNumber(segment && segment.duration) || 0) / 0.45, 0, 1);

    // ponytail: Spotify analysis has no vocal labels; replace this heuristic if stem probabilities become available.
    return clamp(
      pitchFocus * 0.52 + balancedBrightness * 0.18 + body * 0.15 + sustain * 0.15 - 0.2,
      0,
      1
    );
  }

  function beatDurationAt(audioData, seconds) {
    const beats = Array.isArray(audioData && audioData.beats)
      ? audioData.beats
      : [];

    if (beats.length) {
      const beat = beats[findSegmentIndex(beats, seconds)];
      const duration = finiteNumber(beat && beat.duration);

      if (duration && duration > 0) {
        return duration;
      }
    }

    const tempo = finiteNumber(audioData && audioData.track && audioData.track.tempo);
    return tempo && tempo > 0 ? 60 / tempo : 0.5;
  }

  function motionMetrics(audioData, seconds, bassProfile) {
    const segments = Array.isArray(audioData && audioData.segments)
      ? audioData.segments
      : [];
    const beatDuration = beatDurationAt(audioData, seconds);

    if (!segments.length) {
      return {
        bass: 0,
        bassDuration: 0,
        dropScore: 0,
        impact: 0,
        novelty: 0,
        sectionChange: 0,
        vocalOnset: 0,
        beatDuration,
      };
    }

    const segmentIndex = findSegmentIndex(segments, seconds);
    const segment = segments[segmentIndex];
    const previous = segments[Math.max(0, segmentIndex - 1)];
    const profile = bassProfile === undefined ? buildBassProfile(audioData) : bassProfile;
    const segmentStart = finiteNumber(segment && segment.start) || 0;
    const segmentElapsed = Math.max(0, seconds - segmentStart);
    const bassDuration = clamp(finiteNumber(segment && segment.duration) ?? beatDuration, 0.04, 1.2);
    const attack = attackLevel(segment);
    const attackPunch = attack * Math.exp(-segmentElapsed * 8);
    const segmentJump = clamp((peakLoudnessLevel(segment) - peakLoudnessLevel(previous)) * 2.35, 0, 1);
    const pitchNovelty = vectorDistance(pitchValues(segment), pitchValues(previous));
    const timbreNovelty = vectorDistance(timbreValues(segment), timbreValues(previous));
    const beat = timedPulse(audioData && audioData.beats, seconds, 0.16);
    const sections = Array.isArray(audioData && audioData.sections)
      ? audioData.sections
      : [];
    let sectionChange = 0;
    let sectionJump = 0;

    if (sections.length) {
      const sectionIndex = findSegmentIndex(sections, seconds);
      const section = sections[sectionIndex];
      const previousSection = sections[Math.max(0, sectionIndex - 1)];
      const sectionStart = finiteNumber(section && section.start) || 0;
      const sectionElapsed = Math.max(0, seconds - sectionStart);
      const sectionConfidence = clamp(finiteNumber(section && section.confidence) ?? 0.65, 0.3, 1);
      const loudness = finiteNumber(section && section.loudness);
      const previousLoudness = finiteNumber(previousSection && previousSection.loudness);

      sectionChange = sectionIndex > 0
        ? clamp(1 - sectionElapsed / 0.85, 0, 1) * sectionConfidence
        : 0;
      sectionJump = loudness !== null && previousLoudness !== null
        ? clamp((loudness - previousLoudness) / 14, 0, 1)
        : 0;
    }

    const novelty = clamp(
      pitchNovelty * 1.2 +
        timbreNovelty * 0.8 +
        sectionChange * 0.45 +
        sectionJump * 0.55,
      0,
      1
    );
    const vocalRise = clamp((vocalPresenceLevel(segment) - vocalPresenceLevel(previous)) * 1.35, 0, 1);
    const vocalOnset = clamp(
      vocalRise *
        Math.exp(-segmentElapsed * 7) *
        (0.7 + timbreNovelty * 0.75 + pitchNovelty * 0.35) *
        (0.45 + peakLoudnessLevel(segment) * 0.55),
      0,
      1
    );
    const relativeEnergy = profile
      ? profileLevel(peakLoudnessDb(segment), profile.loudnessLow, profile.loudnessHigh, 0.35)
      : peakLoudnessLevel(segment);
    const previousEnergy = profile
      ? profileLevel(peakLoudnessDb(previous), profile.loudnessLow, profile.loudnessHigh, relativeEnergy)
      : peakLoudnessLevel(previous);
    const energyRise = clamp((relativeEnergy - previousEnergy) * 1.8, 0, 1) * Math.exp(-segmentElapsed * 7);
    const toneEvidence = bassToneEvidence(segment, profile, segmentElapsed);
    const sustainedBass = relativeEnergy * toneEvidence;
    const bassOnset = clamp(energyRise * 0.7 + attackPunch * 0.55, 0, 1) * toneEvidence;
    const beatReinforcement = beat * Math.max(sustainedBass, bassOnset);
    const bass = clamp(
      sustainedBass * 0.62 + bassOnset * 0.58 + beatReinforcement * 0.22,
      0,
      1
    );
    const dropScore = clamp(
      sectionChange * 0.36 +
        novelty * 0.38 +
        segmentJump * 0.25 +
        sectionJump * 0.3 +
        attackPunch * 0.25 +
        beat * 0.14,
      0,
      1
    );
    const impact = clamp(
      segmentJump * 0.55 + sectionJump * 0.55 + attackPunch * 0.35 + beat * 0.12,
      0,
      1
    );

    return {
      bass,
      bassDuration,
      dropScore,
      impact,
      novelty,
      sectionChange,
      vocalOnset,
      beatDuration,
    };
  }

  function dropShouldTrigger(metrics, seconds, lastDropAt) {
    const previousDropAt = finiteNumber(lastDropAt);
    const cooldown = Math.max(1.6, (metrics.beatDuration || 0.5) * 1.75);
    const sinceLastDrop = previousDropAt === null ? Infinity : seconds - previousDropAt;

    const impactDrop =
      metrics.dropScore >= 0.66 &&
      (metrics.novelty >= 0.3 || metrics.sectionChange >= 0.28) &&
      (metrics.impact >= 0.28 || metrics.bass >= 0.3);
    const sectionDrop =
      metrics.dropScore >= 0.58 &&
      metrics.sectionChange >= 0.55 &&
      metrics.impact >= 0.22;

    return sinceLastDrop >= cooldown && (impactDrop || sectionDrop);
  }

  function vocalShouldTrigger(metrics, seconds, lastWaveAt) {
    const previousWaveAt = finiteNumber(lastWaveAt);
    const cooldown = Math.max(2.4, (metrics.beatDuration || 0.5) * 3);
    const sinceLastWave = previousWaveAt === null ? Infinity : seconds - previousWaveAt;

    return sinceLastWave >= cooldown && metrics.vocalOnset >= 0.52 && metrics.novelty >= 0.2;
  }

  function shakeIntensity(bass) {
    return Math.pow(clamp((bass - 0.08) / 0.92, 0, 1), 0.45);
  }

  function dropVisualState(elapsed, strength) {
    const time = clamp(elapsed, 0, 1);
    const power = clamp(strength, 0, 1);
    const travel = 1 - Math.pow(1 - time, 3.4);
    const reveal = Math.sin(Math.min(1, time * 5) * Math.PI * 0.5);
    const displacement = reveal * Math.pow(1 - time, 1.35) * power;
    const impact = Math.exp(-time * 18) * power;

    return {
      impactX: 1 + impact * 0.018,
      impactY: 1 - impact * 0.075,
      displacement,
      ringProgress: travel,
      rippleGap: 0.024 + power * 0.018,
      rimOpacity: clamp(displacement * 1.35, 0, 1),
      waveDepth: 0.5 + travel * 0.08,
      waveOpacity: clamp(displacement * 1.35, 0, 0.94),
      waveThickness: 44 + power * 22 + travel * 18,
    };
  }

  function shockwaveGeometry(rect, viewportWidth, viewportHeight) {
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    const radius = Math.max(
      Math.hypot(x, y / WAVE_MAX_DEPTH),
      Math.hypot(viewportWidth - x, y / WAVE_MAX_DEPTH),
      Math.hypot(x, (viewportHeight - y) / WAVE_MAX_DEPTH),
      Math.hypot(viewportWidth - x, (viewportHeight - y) / WAVE_MAX_DEPTH)
    );
    const size = Math.max(rect.right - rect.left, radius * 2.08);

    return {
      size,
      startScale: clamp(((rect.right - rect.left) * 0.86) / size, 0.04, 0.32),
      x,
      y,
    };
  }

  function segmentLevels(audioData, seconds, count, playing) {
    const segments = Array.isArray(audioData && audioData.segments)
      ? audioData.segments
      : [];

    if (!segments.length) {
      return fallbackLevels(count, seconds, playing);
    }

    const segmentIndex = findSegmentIndex(segments, seconds);
    const segment = segments[segmentIndex];
    const previous = segments[Math.max(0, segmentIndex - 1)];
    const loudness = loudnessLevel(segment, seconds);
    const previousLoudness = loudnessLevel(previous, seconds);
    const impact = clamp((loudness - previousLoudness) * 4.4, 0, 0.95);
    const beat = timedPulse(audioData && audioData.beats, seconds, 0.18);
    const tatum = timedPulse(audioData && audioData.tatums, seconds, 0.09);
    const segmentStart = finiteNumber(segment && segment.start) || 0;
    const segmentElapsed = Math.max(0, seconds - segmentStart);
    const transitionProgress = clamp(segmentElapsed / 0.075, 0, 1);
    const transitionMix = transitionProgress * transitionProgress * (3 - 2 * transitionProgress);
    const attack = attackLevel(segment);
    const attackPunch = attack * Math.exp(-segmentElapsed * 8);
    const bassPulse = clamp(impact * 0.38 + beat * 0.62 + tatum * 0.2 + attackPunch * 0.7, 0, 1);
    const currentPitches = pitchValues(segment);
    const previousPitches = pitchValues(previous);
    const pitches = currentPitches.map(
      (value, index) => previousPitches[index] + (value - previousPitches[index]) * transitionMix
    );
    const brightness = timbreLevel(previous, 1) +
      (timbreLevel(segment, 1) - timbreLevel(previous, 1)) * transitionMix;
    const flatness = timbreLevel(previous, 2) +
      (timbreLevel(segment, 2) - timbreLevel(previous, 2)) * transitionMix;
    const displayLoudness = previousLoudness + (loudness - previousLoudness) * transitionMix;

    const levels = Array.from({ length: count }, (_, index) => {
      const position = index / Math.max(1, count - 1);
      const lowWeight = clamp(1 - position / 0.62, 0, 1);
      const highWeight = clamp((position - 0.38) / 0.62, 0, 1);
      const midWeight = clamp(1 - Math.abs(position - 0.5) / 0.5, 0, 1);
      const centerWeight = clamp(1 - Math.abs(position - 0.5) / 0.5, 0, 1);
      const bassWeight = 0.68 + centerWeight * 0.18 + lowWeight * 0.08;
      const pitch = pitchAt(pitches, position);
      const pitchMotion = Math.abs(pitch - pitchAt(previousPitches, position));
      const pulse = playing
        ? Math.sin(seconds * (7.4 + pitch * 2.4) + index * 0.27) *
          (0.035 + bassPulse * (0.24 + bassWeight * 0.24))
        : 0;
      const spectralDetail =
        pitch * 0.25 +
        pitchMotion * 0.22 +
        brightness * highWeight * 0.13 +
        flatness * midWeight * 0.08;
      const energy =
        displayLoudness * (0.34 + centerWeight * 0.12) +
        spectralDetail +
        bassPulse * bassWeight;

      return clamp(0.035 + Math.pow(clamp(energy, 0, 1), 1.08) * 0.92 + pulse, 0.03, 1);
    });

    return levels.map((level, index) => {
      const previousLevel = levels[Math.max(0, index - 1)];
      const nextLevel = levels[Math.min(levels.length - 1, index + 1)];

      return clamp(level * 0.64 + (previousLevel + nextLevel) * 0.18, 0.03, 1);
    });
  }

  function nativeSpectrumLevels(frame, count) {
    return frame && Array.isArray(frame.spectrum) && frame.spectrum.length === count
      ? frame.spectrum
      : null;
  }

  function spatialSmoothLevels(levels) {
    return levels.map((level, index) => {
      const current = clamp(finiteNumber(level) ?? 0, 0, 1);
      const previous = clamp(finiteNumber(levels[Math.max(0, index - 1)]) ?? 0, 0, 1);
      const next = clamp(finiteNumber(levels[Math.min(levels.length - 1, index + 1)]) ?? 0, 0, 1);

      return clamp(current * 0.72 + previous * 0.14 + next * 0.14, 0, 1);
    });
  }

  function normalizeSpectrumPeak(levels) {
    const peak = levels.reduce((highest, level) => Math.max(highest, clamp(finiteNumber(level) ?? 0, 0, 1)), 0);
    return peak < 0.015
      ? levels.map(() => 0)
      : levels.map((level) => clamp((finiteNumber(level) ?? 0) / peak, 0, 1));
  }

  function roughness(values) {
    if (values.length < 2) {
      return 0;
    }

    let total = 0;
    for (let index = 1; index < values.length; index += 1) {
      total += Math.abs(values[index] - values[index - 1]);
    }

    return total / (values.length - 1);
  }

  function edgeFade(index, count) {
    const distance = Math.min(index, count - 1 - index);

    return clamp(distance / 5, 0, 1);
  }

  function smoothLevel(current, next, deltaMs = BAR_REFERENCE_FRAME_MS) {
    const speed = next > current ? 0.48 : 0.16;
    const frames = clamp((finiteNumber(deltaMs) ?? BAR_REFERENCE_FRAME_MS) / BAR_REFERENCE_FRAME_MS, 0, 8);
    const timeAdjustedSpeed = 1 - Math.pow(1 - speed, frames);
    return current + (next - current) * timeAdjustedSpeed;
  }

  function barStateOpacity(playing, hasNativeSpectrum, hasAnalysis) {
    return !playing ? 0.52 : hasNativeSpectrum || hasAnalysis ? 1 : 0.58;
  }

  function barVisualState(level, index, count, stateOpacity) {
    const boundedLevel = clamp(finiteNumber(level) ?? 0, 0, 1);
    const fade = edgeFade(index, count);
    const edgeSize = 0.62 + fade * 0.38;
    const visibleLevel = 0.1 + boundedLevel * 0.9;

    return {
      scale: clamp(visibleLevel * edgeSize, 0.1, 1),
      thin: clamp(0.32 + boundedLevel * 0.68, 0.28, 1),
      opacity: clamp(stateOpacity * (0.55 + boundedLevel * 0.45) * (0.72 + fade * 0.28), 0, 1),
    };
  }

  function barUpdateNeeded(nativeFrameAt, previousNativeFrameAt, now, previousUpdateAt, force, animateFallback) {
    if (force) {
      return true;
    }
    return nativeFrameAt !== null
      ? nativeFrameAt !== previousNativeFrameAt
      : animateFallback && now - previousUpdateAt >= FALLBACK_FRAME_MS;
  }

  function backgroundNativeFrameRenderNeeded(focused, frame, now, previousNativeFrameAt, nowUnixMs) {
    return !focused && nativeBassAvailable(frame, now, nowUnixMs) && frame.receivedAt !== previousNativeFrameAt;
  }

  function foregroundDrawShouldContinue(focused) {
    return Boolean(focused);
  }

  function focusResyncNeeded(pending, hasNativeLevels) {
    return Boolean(pending && hasNativeLevels);
  }

  function focusStateFromDocument(cached, reported) {
    return typeof reported === "boolean" ? reported : Boolean(cached);
  }

  function visibilityStateHidden(state) {
    return state === "hidden";
  }

  function fallbackShockwaveMode(nativeStatusActive) {
    return !nativeStatusActive;
  }

  function nextBarLevel(current, next, deltaMs, snap) {
    return snap ? next : smoothLevel(current, next, deltaMs);
  }

  function removeWindowListeners(target, listeners) {
    for (const [type, callback] of listeners) {
      target.removeEventListener(type, callback);
    }
    listeners.length = 0;
  }

  function runSelfCheck() {
    const audioData = {
      segments: [
        {
          start: 0,
          duration: 1,
          loudness_start: -48,
          loudness_max: -44,
          loudness_max_time: 0.1,
          pitches: [0.2, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3, 0.3, 0.2, 0.2, 0.2, 0.2],
        },
        {
          start: 1,
          duration: 1,
          loudness_start: -38,
          loudness_max: -8,
          loudness_max_time: 0.08,
          pitches: [0.9, 0.8, 0.9, 0.8, 0.3, 0.3, 0.3, 0.3, 0.2, 0.2, 0.2, 0.2],
        },
        {
          start: 2,
          duration: 1,
          loudness_start: -24,
          loudness_max: -18,
          loudness_max_time: 0.1,
          pitches: [0.1, 0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.3, 1, 0.95, 1, 0.95],
        },
      ],
      beats: [
        { start: 0, duration: 1, confidence: 0.3 },
        { start: 1, duration: 1, confidence: 1 },
        { start: 2, duration: 1, confidence: 0.4 },
      ],
      tatums: [
        { start: 1, duration: 0.25, confidence: 1 },
        { start: 1.25, duration: 0.25, confidence: 0.8 },
      ],
    };

    const quiet = segmentLevels(audioData, 0.2, 12, true);
    const loud = segmentLevels(audioData, 1.2, 12, true);
    const bright = segmentLevels(audioData, 2.2, 12, true);
    const fallback = segmentLevels({ segments: [] }, 7.2, 12, true);
    const spectrumFixture = Array.from({ length: 56 }, (_, index) => index === 33 ? 0.9 : 0.1);
    const nativeFrame = parseNativeBassFrame({
      v: 1,
      capturing: true,
      pid: 20368,
      sampleRate: 44100,
      subDb: -24.3,
      energy: 0.72,
      onset: 0.18,
      activeMs: 210,
      spectrum: spectrumFixture,
    }, 1000);
    const timestampedNativeFrame = parseNativeBassFrame({
      ...nativeFrame,
      capturedAtUnixMs: 10000,
    }, 1000, 10200);
    const clampedNativeFrame = parseNativeBassFrame({
      v: 1,
      capturing: true,
      pid: 4e9,
      sampleRate: 500000,
      subDb: -500,
      energy: 5,
      onset: -2,
      activeMs: 900000,
    }, 1000);
    const nativeMotion = nativeBassMotion(nativeFrame, 1100, true, false);
    const nativeShortMotion = nativeBassMotion({ ...nativeFrame, activeMs: 40 }, 1100, true, false);
    const nativeLongMotion = nativeBassMotion({ ...nativeFrame, activeMs: 700 }, 1100, true, false);
    const nativeBars = nativeSpectrumLevels(nativeFrame, 56);
    const pitchA = Array.from({ length: 12 }, (_, index) => index === 2 ? 1 : 0.1);
    const pitchB = Array.from({ length: 12 }, (_, index) => index === 9 ? 1 : 0.1);
    const pitchOnlyA = segmentLevels({
      segments: [{
        start: 0,
        duration: 1,
        loudness_start: -28,
        loudness_max: -24,
        loudness_max_time: 0.1,
        pitches: pitchA,
        timbre: [20, 0, 0, 0],
      }],
    }, 0.3, 12, true);
    const pitchOnlyB = segmentLevels({
      segments: [{
        start: 0,
        duration: 1,
        loudness_start: -28,
        loudness_max: -24,
        loudness_max_time: 0.1,
        pitches: pitchB,
        timbre: [20, 0, 0, 0],
      }],
    }, 0.3, 12, true);
    const softBass = segmentLevels({
      segments: [{
        start: 0,
        duration: 1,
        loudness_start: -28,
        loudness_max: -26,
        loudness_max_time: 0.24,
        pitches: Array(12).fill(0.2),
        timbre: [20, 0, 0, -30],
      }],
      beats: [{ start: 0, duration: 1, confidence: 0.2 }],
    }, 0.03, 12, true);
    const hardBass = segmentLevels({
      segments: [{
        start: 0,
        duration: 1,
        loudness_start: -42,
        loudness_max: -8,
        loudness_max_time: 0.04,
        pitches: Array(12).fill(0.2),
        timbre: [20, 0, 0, 80],
      }],
      beats: [{ start: 0, duration: 1, confidence: 1 }],
    }, 0.03, 12, true);
    const fallbackTransitionData = {
      segments: [
        {
          start: 0,
          duration: 1,
          loudness_start: -24,
          loudness_max: -24,
          loudness_max_time: 1,
          pitches: Array(12).fill(0.05),
          timbre: Array(12).fill(-60),
        },
        {
          start: 1,
          duration: 1,
          loudness_start: -24,
          loudness_max: -24,
          loudness_max_time: 1,
          pitches: Array(12).fill(1),
          timbre: Array(12).fill(-60),
        },
      ],
    };
    const fallbackBeforeBoundary = segmentLevels(fallbackTransitionData, 0.999, 12, true);
    const fallbackAfterBoundary = segmentLevels(fallbackTransitionData, 1.001, 12, true);
    const repeatedBeatData = {
      track: { tempo: 120 },
      sections: [{ start: 0, duration: 8, confidence: 1, loudness: -22 }],
      segments: [
        {
          start: 0,
          duration: 0.5,
          loudness_start: -28,
          loudness_max: -24,
          loudness_max_time: 0.08,
          pitches: Array(12).fill(0.35),
          timbre: Array(12).fill(0),
        },
        {
          start: 0.5,
          duration: 0.5,
          loudness_start: -28,
          loudness_max: -24,
          loudness_max_time: 0.08,
          pitches: Array(12).fill(0.35),
          timbre: Array(12).fill(0),
        },
        {
          start: 1,
          duration: 0.5,
          loudness_start: -28,
          loudness_max: -24,
          loudness_max_time: 0.08,
          pitches: Array(12).fill(0.35),
          timbre: Array(12).fill(0),
        },
      ],
      beats: [
        { start: 0, duration: 0.5, confidence: 1 },
        { start: 0.5, duration: 0.5, confidence: 1 },
        { start: 1, duration: 0.5, confidence: 1 },
      ],
      tatums: [{ start: 1, duration: 0.25, confidence: 1 }],
    };
    const softDropData = {
      track: { tempo: 128 },
      sections: [
        { start: 0, duration: 2, confidence: 1, loudness: -28 },
        { start: 2, duration: 4, confidence: 0.3, loudness: -27 },
      ],
      segments: [
        {
          start: 1.5,
          duration: 0.5,
          loudness_start: -32,
          loudness_max: -28,
          loudness_max_time: 0.18,
          pitches: Array(12).fill(0.25),
          timbre: Array(12).fill(0),
        },
        {
          start: 2,
          duration: 0.5,
          loudness_start: -30,
          loudness_max: -26,
          loudness_max_time: 0.24,
          pitches: Array(12).fill(0.35),
          timbre: Array(12).fill(2),
        },
      ],
      beats: [{ start: 2, duration: 0.47, confidence: 0.25 }],
    };
    const hardDropData = {
      track: { tempo: 128 },
      sections: [
        { start: 0, duration: 2, confidence: 1, loudness: -30 },
        { start: 2, duration: 4, confidence: 1, loudness: -8 },
      ],
      segments: [
        {
          start: 1.5,
          duration: 0.5,
          loudness_start: -38,
          loudness_max: -32,
          loudness_max_time: 0.18,
          pitches: [0.5, 0.45, 0.5, 0.45, 0.22, 0.2, 0.18, 0.16, 0.08, 0.08, 0.06, 0.06],
          timbre: [20, -35, -10, 20, -8, -8, -8, -8, -8, -8, -8, -8],
        },
        {
          start: 2,
          duration: 0.5,
          loudness_start: -42,
          loudness_max: -7,
          loudness_max_time: 0.04,
          pitches: [1, 0.95, 0.9, 0.85, 0.3, 0.25, 0.2, 0.2, 0.08, 0.06, 0.05, 0.05],
          timbre: [45, -42, -15, 90, 12, 8, 5, 8, 4, 3, 2, 2],
        },
      ],
      beats: [{ start: 2, duration: 0.47, confidence: 1 }],
      tatums: [{ start: 2, duration: 0.235, confidence: 1 }],
    };
    const highAttackData = {
      track: { tempo: 128 },
      sections: [{ start: 0, duration: 4, confidence: 1, loudness: -10 }],
      segments: [
        {
          start: 1.5,
          duration: 0.5,
          loudness_start: -36,
          loudness_max: -28,
          loudness_max_time: 0.12,
          pitches: [0.08, 0.08, 0.06, 0.06, 0.25, 0.25, 0.3, 0.3, 1, 0.95, 0.9, 0.9],
          timbre: [30, 80, 35, 55, 18, 22, 20, 35, 26, 34, 24, 32],
        },
        {
          start: 2,
          duration: 0.5,
          loudness_start: -42,
          loudness_max: -7,
          loudness_max_time: 0.04,
          pitches: [0.06, 0.05, 0.05, 0.04, 0.25, 0.25, 0.28, 0.3, 1, 1, 0.95, 0.95],
          timbre: [50, 90, 45, 95, 24, 30, 25, 42, 35, 44, 33, 40],
        },
      ],
      beats: [{ start: 2, duration: 0.47, confidence: 1 }],
      tatums: [{ start: 2, duration: 0.235, confidence: 1 }],
    };
    const lowBassData = {
      track: { tempo: 100 },
      sections: [{ start: 0, duration: 4, confidence: 1, loudness: -13 }],
      segments: [
        {
          start: 1.5,
          duration: 0.5,
          loudness_start: -27,
          loudness_max: -24,
          loudness_max_time: 0.2,
          pitches: Array(12).fill(0.2),
          timbre: [18, -48, -12, 5, -10, -8, -8, -8, -8, -8, -8, -8],
        },
        {
          start: 2,
          duration: 1,
          loudness_start: -20,
          loudness_max: -12,
          loudness_max_time: 0.22,
          pitches: Array(12).fill(0.2),
          timbre: [36, -56, -18, 12, -12, -10, -10, -10, -10, -10, -10, -10],
        },
      ],
      beats: [{ start: 2, duration: 0.6, confidence: 0.6 }],
    };
    const noBassBeatData = {
      track: { tempo: 120 },
      sections: [{ start: 0, duration: 4, confidence: 1, loudness: -25 }],
      segments: [
        {
          start: 0,
          duration: 1,
          loudness_start: -26,
          loudness_max: -25,
          loudness_max_time: 0.24,
          pitches: Array(12).fill(0.35),
          timbre: Array(12).fill(0),
        },
        {
          start: 1,
          duration: 1,
          loudness_start: -26,
          loudness_max: -25,
          loudness_max_time: 0.24,
          pitches: Array(12).fill(0.35),
          timbre: Array(12).fill(0),
        },
      ],
      beats: [
        { start: 0, duration: 0.5, confidence: 1 },
        { start: 0.5, duration: 0.5, confidence: 1 },
        { start: 1, duration: 0.5, confidence: 1 },
      ],
      tatums: [{ start: 1, duration: 0.25, confidence: 1 }],
    };
    const vocalOnsetData = {
      track: { tempo: 120 },
      sections: [{ start: 0, duration: 6, confidence: 1, loudness: -18 }],
      segments: [
        {
          start: 0,
          duration: 2,
          loudness_start: -24,
          loudness_max: -18,
          loudness_max_time: 0.1,
          pitches: Array(12).fill(0.35),
          timbre: [25, -50, 20, 50, 0, 0, 0, 0, 0, 0, 0, 0],
        },
        {
          start: 2,
          duration: 0.55,
          loudness_start: -24,
          loudness_max: -16,
          loudness_max_time: 0.12,
          pitches: [1, 0.9, 0.82, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12],
          timbre: [28, 8, -20, -8, 0, 0, 0, 0, 0, 0, 0, 0],
        },
      ],
      beats: [{ start: 2, duration: 0.5, confidence: 0.5 }],
    };
    const makeSustainedBassData = (loudnessOffset, timbre, bassDuration = 1) => ({
      track: { tempo: 100 },
      sections: [{ start: 0, duration: 2 + bassDuration, confidence: 1, loudness: -18 + loudnessOffset }],
      segments: [
        {
          start: 0,
          duration: 1,
          loudness_start: -34 + loudnessOffset,
          loudness_max: -30 + loudnessOffset,
          loudness_max_time: 0.2,
          pitches: Array(12).fill(0.2),
          timbre: Array(12).fill(0),
        },
        {
          start: 1,
          duration: bassDuration,
          loudness_start: -16 + loudnessOffset,
          loudness_max: -12 + loudnessOffset,
          loudness_max_time: Math.min(0.3, bassDuration * 0.35),
          pitches: Array(12).fill(0.2),
          timbre,
        },
        {
          start: 1 + bassDuration,
          duration: 1,
          loudness_start: -32 + loudnessOffset,
          loudness_max: -28 + loudnessOffset,
          loudness_max_time: 0.2,
          pitches: Array(12).fill(0.2),
          timbre: Array(12).fill(0),
        },
      ],
      beats: [{ start: 1, duration: 0.6, confidence: 0.8 }],
    });
    const sustainedBassData = makeSustainedBassData(0, [36, -55, -25, 5, 0, 0, 0, 0, 0, 0, 0, 0]);
    const brightBassData = makeSustainedBassData(0, [40, 55, 45, 100, 0, 0, 0, 0, 0, 0, 0, 0]);
    const shortBrightBassData = makeSustainedBassData(0, [40, 55, 45, 100, 0, 0, 0, 0, 0, 0, 0, 0], 0.09);
    const quietBassData = makeSustainedBassData(-18, [36, -55, -25, 5, 0, 0, 0, 0, 0, 0, 0, 0]);
    const loudBassData = makeSustainedBassData(4, [36, -55, -25, 5, 0, 0, 0, 0, 0, 0, 0, 0]);
    const repeatedBeatMetrics = motionMetrics(repeatedBeatData, 1, buildBassProfile(repeatedBeatData));
    const softDropMetrics = motionMetrics(softDropData, 2.03, buildBassProfile(softDropData));
    const hardDropMetrics = motionMetrics(hardDropData, 2.03, buildBassProfile(hardDropData));
    const highAttackMetrics = motionMetrics(highAttackData, 2.03, buildBassProfile(highAttackData));
    const lowBassMetrics = motionMetrics(lowBassData, 2.03, buildBassProfile(lowBassData));
    const noBassBeatMetrics = motionMetrics(noBassBeatData, 1, buildBassProfile(noBassBeatData));
    const vocalOnsetMetrics = motionMetrics(vocalOnsetData, 2.03, buildBassProfile(vocalOnsetData));
    const fallbackMetrics = motionMetrics({ segments: [] }, 3, null);
    const sustainedBassMetrics = motionMetrics(sustainedBassData, 1.6, buildBassProfile(sustainedBassData));
    const brightBassMetrics = motionMetrics(brightBassData, 1.6, buildBassProfile(brightBassData));
    const shortBrightBassMetrics = motionMetrics(shortBrightBassData, 1.045, buildBassProfile(shortBrightBassData));
    const quietBassMetrics = motionMetrics(quietBassData, 1.6, buildBassProfile(quietBassData));
    const loudBassMetrics = motionMetrics(loudBassData, 1.6, buildBassProfile(loudBassData));

    if (stableVisualizerBottom(null, 1000, 112) !== 112) {
      throw new Error("missing playbar should preserve the last stable visualizer position");
    }

    if (stableVisualizerBottom(0, 1000, 112) !== 112) {
      throw new Error("full-height footer geometry should not move the visualizer");
    }

    if (stableVisualizerBottom(900, 1000, 0) !== 110) {
      throw new Error("valid playbar geometry should place the visualizer above the player");
    }

    if (normalizeDurationMs(200) !== 200000) {
      throw new Error("duration seconds should normalize to milliseconds");
    }

    if (normalizeProgressMs(90, 200000) !== 90000) {
      throw new Error("progress seconds should normalize to milliseconds");
    }

    if (normalizeProgressMs(90000, 200000) !== 90000) {
      throw new Error("progress milliseconds should stay milliseconds");
    }

    if (normalizeProgressMs(0.5, 200000) !== 100000) {
      throw new Error("progress ratio should normalize against duration");
    }

    if (quiet.join(",") === loud.join(",")) {
      throw new Error("segment lookup did not change output");
    }

    if (average(loud) <= average(quiet)) {
      throw new Error("loud segment should draw taller than quiet segment");
    }

    if (Math.abs(average(loud.slice(0, 4)) - average(loud.slice(8))) > 0.45) {
      throw new Error("beat impact should not hard-bias one side");
    }

    if (!nativeFrame || !nativeMotion || Math.abs(nativeMotion.target - 0.5004) > 0.001) {
      throw new Error("valid native bass frames should drive the documented shake target");
    }

    if (!clampedNativeFrame || clampedNativeFrame.energy !== 1 || clampedNativeFrame.onset !== 0 ||
        clampedNativeFrame.subDb !== -120 || clampedNativeFrame.sampleRate !== 192000 ||
        clampedNativeFrame.pid !== 2147483647 || clampedNativeFrame.activeMs !== 600000) {
      throw new Error("native bass payload fields should be validated and clamped");
    }

    if (parseNativeBassFrame({ ...nativeFrame, v: 2 }, 1000) !== null ||
        parseNativeBassFrame({ ...nativeFrame, energy: "loud" }, 1000) !== null ||
        parseNativeBassFrame({ ...nativeFrame, spectrum: [0.5] }, 1000) !== null) {
      throw new Error("invalid native bass payloads should be rejected");
    }

    if (!timestampedNativeFrame || timestampedNativeFrame.capturedAtUnixMs !== 10000 ||
        !nativeFrameSourceFresh(timestampedNativeFrame, 10250) ||
        nativeFrameSourceFresh(timestampedNativeFrame, 10251) ||
        !nativeFrameSourceFresh(nativeFrame, 999999)) {
      throw new Error("native frames should reject stale source timestamps while accepting old helpers");
    }

    if (nativeBassMotion(nativeFrame, 1201, true, false) !== null ||
        nativeBassMotion(nativeFrame, 1100, false, false) !== null ||
        nativeBassMotion(nativeFrame, 1100, true, true) !== null) {
      throw new Error("stale frames, pause, and reduced motion should disable native bass motion");
    }

    if (!nativeShortMotion || !nativeLongMotion || nativeShortMotion.releaseSeconds >= nativeLongMotion.releaseSeconds) {
      throw new Error("native bass duration should lengthen the release envelope");
    }

    if (!nativeBars || nativeBars.indexOf(Math.max(...nativeBars)) !== 33 || nativeBars.join(",") !== spectrumFixture.join(",")) {
      throw new Error("native FFT spectrum should drive all visualizer bars without Spotify reshaping");
    }

    if (!nativeBassStatus(nativeFrame, true) || nativeBassStatus(nativeFrame, false) ||
        !nativeBassStatus({ ...nativeFrame, receivedAt: 0 }, true)) {
      throw new Error("FFT status should follow the live socket instead of stale audio frames");
    }

    if (average(bright.slice(8)) <= average(bright.slice(0, 4))) {
      throw new Error("high-pitch segment should favor right-side bars");
    }

    if (pitchOnlyA.join(",") === pitchOnlyB.join(",")) {
      throw new Error("different pitch classes should change the wave shape");
    }

    if (average(hardBass) <= average(softBass) + 0.12) {
      throw new Error("strong attack and beat should make bass motion taller");
    }

    if (dropShouldTrigger(repeatedBeatMetrics, 1, -Infinity)) {
      throw new Error("repeated similar beats should not trigger drop shockwaves");
    }

    if (!dropShouldTrigger(hardDropMetrics, 2.03, -Infinity)) {
      throw new Error("loud section novelty should trigger a drop shockwave");
    }

    if (dropShouldTrigger(softDropMetrics, 2.03, -Infinity)) {
      throw new Error("small section changes should not trigger drop shockwaves");
    }

    if (hardDropMetrics.dropScore <= softDropMetrics.dropScore) {
      throw new Error("stronger attack and loudness jump should raise drop score");
    }

    if (dropShouldTrigger(hardDropMetrics, 2.5, 2.03)) {
      throw new Error("drop cooldown should block duplicate shockwaves");
    }

    if (!vocalShouldTrigger(vocalOnsetMetrics, 2.03, -Infinity)) {
      throw new Error("a clear vocal-like onset should trigger a shockwave");
    }

    if (dropShouldTrigger(vocalOnsetMetrics, 2.03, -Infinity)) {
      throw new Error("vocal onset should not need to masquerade as a drop");
    }

    if (vocalShouldTrigger(vocalOnsetMetrics, 2.4, 2.03)) {
      throw new Error("vocal cooldown should block repeated phrase shockwaves");
    }

    if (vocalShouldTrigger(highAttackMetrics, 2.03, -Infinity)) {
      throw new Error("bright instrumental attacks should not count as vocal onsets");
    }

    if (hardDropMetrics.bass <= softDropMetrics.bass) {
      throw new Error("hard bass should produce stronger shake metric");
    }

    if (shakeIntensity(noBassBeatMetrics.bass) > 0.12) {
      throw new Error("beat timing without bass-like attack should not visibly shake");
    }

    if (shakeIntensity(highAttackMetrics.bass) > 0.12) {
      throw new Error("bright high-frequency attacks should not visibly shake");
    }

    if (shakeIntensity(lowBassMetrics.bass) <= 0.2) {
      throw new Error("dark low-frequency bass should visibly shake");
    }

    if (shakeIntensity(lowBassMetrics.bass) <= shakeIntensity(highAttackMetrics.bass) + 0.2) {
      throw new Error("low-frequency bass should shake more than high-frequency attacks");
    }

    if (shakeIntensity(sustainedBassMetrics.bass) <= 0.25) {
      throw new Error("sustained bass should remain visible after its attack has decayed");
    }

    if (shakeIntensity(brightBassMetrics.bass) <= 0.15) {
      throw new Error("bright high-attack mixes should not suppress simultaneous deep bass");
    }

    if (shakeIntensity(shortBrightBassMetrics.bass) <= 0.15) {
      throw new Error("short bright bass should activate before its segment ends");
    }

    if (Math.abs(quietBassMetrics.bass - loudBassMetrics.bass) > 0.08) {
      throw new Error("track-relative bass should behave consistently across mastering levels");
    }

    const quietBassProfile = buildBassProfile(quietBassData);
    if (!quietBassProfile || quietBassProfile.loudnessHigh - quietBassProfile.loudnessLow < 6) {
      throw new Error("bass profile should enforce a stable loudness range");
    }

    const bassAttackEnvelope = smoothBassEnvelope(0, 0.8, 0.035);
    const bassBoundaryEnvelope = smoothBassEnvelope(bassAttackEnvelope, 0.65, 0.016);
    const bassReleaseEnvelope = smoothBassEnvelope(bassBoundaryEnvelope, 0, 0.016);
    if (bassBoundaryEnvelope <= bassAttackEnvelope || bassReleaseEnvelope <= bassBoundaryEnvelope * 0.85) {
      throw new Error("bass envelope should bridge segment boundaries and release gradually");
    }

    if (smoothBassEnvelope(0.8, 0, 2) > 0.001) {
      throw new Error("bass envelope should fully release when motion stops");
    }

    if (smoothBassEnvelope(0.8, 0, 0.08, 0.08) >= smoothBassEnvelope(0.8, 0, 0.08, 0.8)) {
      throw new Error("short bass should release faster than long bass");
    }

    if (shakeIntensity(hardDropMetrics.bass) <= shakeIntensity(softDropMetrics.bass) + 0.18) {
      throw new Error("hard bass should produce visibly stronger shake");
    }

    if (shakeIntensity(0.55) <= 0.5) {
      throw new Error("medium bass should not be over-suppressed");
    }

    if (shakeIntensity(0.28) <= 0.2) {
      throw new Error("low bass should not be over-suppressed");
    }

    if (shakeIntensity(0.09) <= 0.1 || shakeIntensity(0.15) <= 0.3) {
      throw new Error("track-confirmed low bass scores should create visible motion");
    }

    const impactStart = dropVisualState(0, 1);
    const impactRelease = dropVisualState(0.2, 1);
    const wavePeak = dropVisualState(0.15, 1);
    const waveTail = dropVisualState(0.75, 1);
    const waveEnd = dropVisualState(1, 1);
    const geometry = shockwaveGeometry(
      { left: 300, right: 700, top: 700, bottom: 744 },
      1000,
      800
    );

    if (impactStart.impactY >= impactRelease.impactY || impactRelease.impactY > 1) {
      throw new Error("drop impact should compress immediately and rebound without drifting down");
    }

    if (impactStart.ringProgress >= wavePeak.ringProgress || wavePeak.ringProgress >= waveTail.ringProgress) {
      throw new Error("drop wave should travel outward");
    }

    if (wavePeak.displacement <= waveTail.displacement) {
      throw new Error("drop displacement should weaken while expanding");
    }

    if (waveEnd.waveOpacity !== 0 || waveEnd.displacement !== 0 || waveEnd.rimOpacity !== 0) {
      throw new Error("drop wave should fully clear at the end");
    }

    if (![impactStart, wavePeak, waveTail, waveEnd].every((state) => state.waveOpacity >= 0 && state.waveOpacity <= 1)) {
      throw new Error("drop wave opacity should stay bounded");
    }

    if (geometry.x !== 500 || geometry.y !== 722 || geometry.size * geometry.startScale < 330) {
      throw new Error("drop wave should originate at and cover the visualizer");
    }

    if (wavePeak.waveThickness < 60 || wavePeak.waveThickness <= dropVisualState(0.15, 0.55).waveThickness) {
      throw new Error("strong shockwaves should use a visibly thicker pressure band");
    }

    if (fallbackMetrics.dropScore !== 0 || fallbackMetrics.bass !== 0 || fallbackMetrics.vocalOnset !== 0) {
      throw new Error("fallback metrics should stay quiet without analysis");
    }

    if (roughness(bright.slice(8)) > 0.28) {
      throw new Error("right-side bars should stay spatially smooth");
    }

    if (edgeFade(0, 56) >= edgeFade(8, 56)) {
      throw new Error("edge bars should scale down before inner bars");
    }

    if (!fallback.every((value) => value >= 0.03 && value <= 1)) {
      throw new Error("fallback level out of range");
    }

    if (smoothLevel(0.2, 0.8) <= 0.2 || smoothLevel(0.2, 0.8) >= 0.8) {
      throw new Error("smoothing should reduce upward snapping");
    }

    if (smoothLevel(0.8, 0.2) <= 0.2 || smoothLevel(0.8, 0.2) >= 0.8) {
      throw new Error("smoothing should reduce downward snapping");
    }

    const spatialImpulse = spatialSmoothLevels([0, 0, 1, 0, 0]);
    if (Math.abs(spatialImpulse[2] - 0.72) > 0.0001 ||
        Math.abs(spatialImpulse[1] - 0.14) > 0.0001 ||
        Math.abs(spatialImpulse[3] - 0.14) > 0.0001 ||
        !spatialImpulse.every((value) => value >= 0 && value <= 1)) {
      throw new Error("FFT spatial smoothing should use a bounded 72/14/14 kernel");
    }

    const quietSpectrum = normalizeSpectrumPeak([0.1, 0.5, 0.25]);
    const loudSpectrum = normalizeSpectrumPeak([0.2, 1, 0.5]);
    if (quietSpectrum.join(",") !== loudSpectrum.join(",") ||
        Math.max(...quietSpectrum) !== 1 ||
        normalizeSpectrumPeak([0.001, 0]).some((value) => value !== 0)) {
      throw new Error("FFT bar peaks should be volume-independent without amplifying silence");
    }

    if (Math.abs(smoothLevel(0.2, 0.8) - 0.488) > 0.0001 ||
        Math.abs(smoothLevel(0.8, 0.2) - 0.704) > 0.0001) {
      throw new Error("bar attack and release should use 48% and 16% smoothing");
    }

    if (smoothLevel(0.2, 0.8, 120) < 0.75 || smoothLevel(0.8, 0.2, 120) > 0.55) {
      throw new Error("bar smoothing should catch up after a delayed render frame");
    }

    const silentEdge = barVisualState(0, 0, 56, 1);
    const silentCenter = barVisualState(0, 27, 56, 1);
    const symmetricLeft = barVisualState(0.6, 8, 56, 1);
    const symmetricRight = barVisualState(0.6, 47, 56, 1);
    if (silentEdge.scale < 0.1 || silentCenter.scale < 0.1) {
      throw new Error("every rendered FFT bar should retain a 10% minimum height");
    }
    if (Math.abs(symmetricLeft.scale - symmetricRight.scale) > 0.0001 ||
        Math.abs(symmetricLeft.opacity - symmetricRight.opacity) > 0.0001) {
      throw new Error("equal-frequency levels should render symmetrically");
    }
    if (barStateOpacity(true, true, false) !== 1) {
      throw new Error("native FFT bars should remain full quality without Spotify analysis");
    }

    if (!barUpdateNeeded(101, 100, 0, 0, false, true) ||
        barUpdateNeeded(100, 100, 0, 0, false, true) ||
        !barUpdateNeeded(null, null, 17, 0, false, true) ||
        barUpdateNeeded(null, null, 8, 0, false, true) ||
        barUpdateNeeded(null, null, 34, 0, false, false) ||
        !barUpdateNeeded(null, null, 0, 0, true, false)) {
      throw new Error("bars should update for new FFT frames, smooth 60 FPS fallback, or state changes");
    }
    const fallbackBoundaryJump = Math.max(...fallbackAfterBoundary.map(
      (level, index) => Math.abs(level - fallbackBeforeBoundary[index])
    ));
    if (fallbackBoundaryJump > 0.035) {
      throw new Error("fallback spectrum changes should crossfade at Spotify segment boundaries");
    }

    if (!backgroundNativeFrameRenderNeeded(false, timestampedNativeFrame, 1050, 999, 10200) ||
        backgroundNativeFrameRenderNeeded(true, timestampedNativeFrame, 1050, 999, 10200) ||
        backgroundNativeFrameRenderNeeded(false, timestampedNativeFrame, 1050, 1000, 10200) ||
        backgroundNativeFrameRenderNeeded(false, timestampedNativeFrame, 1050, 999, 10251) ||
        nextBarLevel(0.2, 0.8, 200, true) !== 0.8) {
      throw new Error("unfocused FFT frames should drive motion once and focus resync should snap to live levels");
    }
    if (!foregroundDrawShouldContinue(true) || foregroundDrawShouldContinue(false)) {
      throw new Error("the full animation loop should run only while Spotify is focused");
    }
    if (focusStateFromDocument(true, false) || !focusStateFromDocument(false, true) ||
        !focusStateFromDocument(true, undefined)) {
      throw new Error("document focus should correct stale cached state and preserve it when unavailable");
    }
    if (!focusResyncNeeded(true, true) || focusResyncNeeded(true, false) ||
        focusResyncNeeded(false, true)) {
      throw new Error("focus resync should force only the first native-spectrum frame");
    }
    if (!visibilityStateHidden("hidden") || visibilityStateHidden("visible")) {
      throw new Error("only a hidden document should pause visual motion");
    }
    if (!fallbackShockwaveMode(false) || fallbackShockwaveMode(true)) {
      throw new Error("fallback shockwaves should avoid viewport-sized backdrop filtering");
    }

    const removedListeners = [];
    const cleanupListeners = [["focus", () => {}], ["blur", () => {}]];
    removeWindowListeners({
      removeEventListener(type) {
        removedListeners.push(type);
      },
    }, cleanupListeners);
    if (removedListeners.join(",") !== "focus,blur" || cleanupListeners.length !== 0) {
      throw new Error("focus-safe window listeners should be removed during destruction");
    }

    if (bassShakeRate(800, 0) >= 3 || bassShakeRate(40, 0) <= 7.5 || bassShakeRate(800, 1) <= 7.5) {
      throw new Error("steady bass should shake slowly while short hits and reactive pulses stay fast");
    }

    if (statusText(false) !== "MWV v1.0 PREVIEW" || statusText(true) !== "MWV v1.0 FFT") {
      throw new Error("v1.0 status should clearly distinguish preview and native FFT modes");
    }

    const lowBassTone = Array.from({ length: 56 }, (_, index) => index === 1 ? 0.9 : 0);
    const highBassTone = Array.from({ length: 56 }, (_, index) => index === 5 ? 0.9 : 0);
    const highFrequencyOnly = Array.from({ length: 56 }, (_, index) => index === 45 ? 0.9 : 0);
    if (bassToneChange(lowBassTone, highBassTone) < 0.8 ||
        bassToneChange(lowBassTone, lowBassTone) !== 0 ||
        bassToneChange(lowBassTone, highFrequencyOnly) !== 0) {
      throw new Error("rapid sub-bass tone changes should react without following high frequencies");
    }

    const steadyBassFrame = { ...nativeFrame, onset: 0, activeMs: 800, spectrum: lowBassTone };
    const steadyBassMotion = nativeBassMotion(steadyBassFrame, 1100, true, false, steadyBassFrame);
    const changedBassMotion = nativeBassMotion(
      { ...steadyBassFrame, spectrum: highBassTone },
      1100,
      true,
      false,
      steadyBassFrame
    );
    const spikedBassMotion = nativeBassMotion({ ...steadyBassFrame, onset: 0.3 }, 1100, true, false, steadyBassFrame);
    if (!steadyBassMotion || steadyBassMotion.reactivity !== 0 ||
        !changedBassMotion || changedBassMotion.reactivity < 0.8 ||
        !spikedBassMotion || spikedBassMotion.reactivity < 0.8) {
      throw new Error("native motion should react to bass spikes and bass-tone changes");
    }
  }

  if (typeof process !== "undefined" && process.argv.includes("--self-check")) {
    runSelfCheck();
    return;
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  if (window.__minimalWaveVisualizer) {
    window.__minimalWaveVisualizer.destroy();
  }

  let root;
  let statusLink;
  let bars = [];
  let raf = 0;
  let currentUri = "";
  let loadingUri = "";
  let audioData = null;
  let bassProfile = null;
  let bassEnvelope = 0;
  let bassEnvelopeDuration = 0.22;
  let bassReactivity = 0;
  let shakePhase = 0;
  let lastBassFrameAt = 0;
  let progressMs = 0;
  let durationMs = 0;
  let displayedLevels = [];
  let renderedBarStyles = [];
  let lastBarUpdateAt = 0;
  let lastNativeBarFrameAt = null;
  let lastBarStateKey = "";
  let renderedShakeX = "";
  let windowFocused = document.hasFocus();
  let focusResyncPending = false;
  let visibilityPaused = visibilityStateHidden(document.visibilityState);
  let smoothRestorePending = false;
  let playerPlaying = true;
  let playerListeners = [];
  let windowListeners = [];
  let documentListeners = [];
  let placementTimer = 0;
  let placedBottom = 0;
  let lastTrackCheck = 0;
  let lastAnalysisAttempt = 0;
  let analysisFailures = 0;
  let lastWaveAt = -Infinity;
  let lastDrawSeconds = 0;
  let shockwave;
  let shockwaveAnimation;
  let pressureAnimation;
  let impactAnimation;
  let nativeSocket = null;
  let nativeBassFrame = null;
  let previousNativeBassFrame = null;
  let nativeReconnectTimer = 0;
  let nativeReconnectDelay = 500;
  let nativeDestroyed = false;
  let waveOriginX = window.innerWidth / 2;
  let waveOriginY = window.innerHeight * 0.8;
  let waveStartScale = 0.12;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function resetBassMotion(clearProfile) {
    bassEnvelope = 0;
    bassEnvelopeDuration = 0.22;
    bassReactivity = 0;
    shakePhase = 0;
    lastBassFrameAt = 0;
    if (clearProfile) {
      bassProfile = null;
    }
  }

  function scheduleNativeBassReconnect() {
    if (nativeDestroyed || nativeReconnectTimer || typeof window.WebSocket !== "function") {
      return;
    }

    const delay = nativeReconnectDelay;
    nativeReconnectDelay = Math.min(5000, Math.round(nativeReconnectDelay * 1.8));
    nativeReconnectTimer = window.setTimeout(() => {
      nativeReconnectTimer = 0;
      connectNativeBass();
    }, delay);
  }

  function connectNativeBass() {
    if (nativeDestroyed || nativeSocket || typeof window.WebSocket !== "function") {
      return;
    }

    let socket;
    try {
      socket = new window.WebSocket(NATIVE_BASS_URL);
    } catch (error) {
      scheduleNativeBassReconnect();
      return;
    }

    nativeSocket = socket;
    socket.onopen = () => {
      if (socket === nativeSocket) {
        nativeReconnectDelay = 500;
      }
    };
    socket.onmessage = (event) => {
      if (socket !== nativeSocket || typeof event.data !== "string" || event.data.length > 4096) {
        return;
      }

      try {
        const receivedAt = performance.now();
        const receivedUnixMs = Date.now();
        const frame = parseNativeBassFrame(JSON.parse(event.data), receivedAt, receivedUnixMs);
        if (frame && nativeFrameSourceFresh(frame, receivedUnixMs)) {
          previousNativeBassFrame = nativeBassFrame;
          nativeBassFrame = frame;
          if (documentHiddenState()) {
            pauseHiddenMotion();
            return;
          }
          resumeVisibleMotion();
          if (documentFocusState()) {
            if (!windowFocused) {
              resumeForegroundDraw();
            }
          } else {
            suspendForegroundDraw();
          }
          if (focusResyncPending && windowFocused) {
            if (!raf) {
              raf = window.requestAnimationFrame(draw);
            }
          } else if (playerPlaying && !reducedMotion.matches && backgroundNativeFrameRenderNeeded(
            windowFocused,
            frame,
            receivedAt,
            lastNativeBarFrameAt,
            receivedUnixMs
          )) {
            renderMotionFrame(receivedAt, isPlaying());
          }
        }
      } catch (error) {
        console.debug("[minimal-wave-visualizer] invalid native bass frame", error);
      }
    };
    socket.onerror = () => {
      socket.close();
    };
    socket.onclose = () => {
      if (socket === nativeSocket) {
        nativeSocket = null;
        nativeBassFrame = null;
        previousNativeBassFrame = null;
        scheduleNativeBassReconnect();
      }
    };
  }

  function disconnectNativeBass() {
    nativeDestroyed = true;
    window.clearTimeout(nativeReconnectTimer);
    nativeReconnectTimer = 0;
    nativeBassFrame = null;
    previousNativeBassFrame = null;

    if (nativeSocket) {
      const socket = nativeSocket;
      nativeSocket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
  }

  function resetDropMotion() {
    lastWaveAt = -Infinity;
    lastDrawSeconds = 0;
    resetBassMotion(false);
    cancelShockwaveAnimations();
  }

  function documentFocusState() {
    try {
      return focusStateFromDocument(windowFocused, document.hasFocus());
    } catch {
      return Boolean(windowFocused);
    }
  }

  function documentHiddenState() {
    return visibilityStateHidden(document.visibilityState);
  }

  function suspendForegroundDraw() {
    windowFocused = false;
    focusResyncPending = false;
    window.cancelAnimationFrame(raf);
    raf = 0;
  }

  function pauseHiddenMotion() {
    const transitioned = !visibilityPaused;
    visibilityPaused = true;
    smoothRestorePending = false;
    suspendForegroundDraw();

    if (!transitioned) {
      return;
    }

    resetBassMotion(false);
    cancelShockwaveAnimations();
    if (renderedShakeX !== "0.00px") {
      renderedShakeX = "0.00px";
      root?.style.setProperty("--shake-x", renderedShakeX);
    }
  }

  function resumeVisibleMotion() {
    if (!visibilityPaused) {
      return;
    }

    visibilityPaused = false;
    smoothRestorePending = true;
    const now = performance.now();
    updateProgress();
    lastBarUpdateAt = now;
    lastBassFrameAt = now;
    lastDrawSeconds = progressMs / 1000;
    lastWaveAt = lastDrawSeconds;
  }

  function resumeForegroundDraw() {
    if (documentHiddenState()) {
      pauseHiddenMotion();
      return;
    }

    resumeVisibleMotion();
    windowFocused = true;
    focusResyncPending = !smoothRestorePending;
    if (!raf) {
      raf = window.requestAnimationFrame(draw);
    }
  }

  function injectStyle() {
    const existing = document.getElementById(ROOT_ID + "-style");
    if (existing) {
      existing.remove();
    }

    const style = document.createElement("style");
    style.id = ROOT_ID + "-style";
    style.textContent = `
      .minimal-wave-visualizer__shockwave {
        --glass-blur: 1.4px;
        --glass-contrast: 1.08;
        --glass-saturate: 1.2;
        --rim-opacity: 0.72;
        --ripple-opacity: 0.48;
        --ripple-scale: 0.96;
        --wave-depth: 0.52;
        --wave-size: 100px;
        --wave-thickness: 64px;
        --wave-x: 50vw;
        --wave-y: 80vh;
        -webkit-mask-image: radial-gradient(
          circle,
          transparent calc(50% - var(--wave-thickness)),
          rgba(0,0,0,0.45) calc(50% - var(--wave-thickness) + 2px),
          #000 calc(50% - var(--wave-thickness) + 8px),
          #000 calc(50% - 3px),
          transparent 50%
        );
        -webkit-mask-repeat: no-repeat;
        background: radial-gradient(
          circle,
          transparent calc(50% - var(--wave-thickness)),
          rgba(255,255,255,var(--rim-opacity)) calc(50% - var(--wave-thickness) + 3px),
          rgba(255,255,255,0.11) calc(50% - var(--wave-thickness) + 15px),
          rgba(30,215,96,0.12) calc(50% - 11px),
          rgba(0,0,0,0.38) calc(50% - 3px),
          transparent 50%
        );
        border-radius: 50%;
        contain: layout paint style;
        height: var(--wave-size);
        isolation: isolate;
        left: var(--wave-x);
        mask-image: radial-gradient(
          circle,
          transparent calc(50% - var(--wave-thickness)),
          rgba(0,0,0,0.45) calc(50% - var(--wave-thickness) + 2px),
          #000 calc(50% - var(--wave-thickness) + 8px),
          #000 calc(50% - 3px),
          transparent 50%
        );
        mask-repeat: no-repeat;
        opacity: 0;
        pointer-events: none;
        position: fixed;
        top: var(--wave-y);
        transform: translate(-50%, -50%) scale(0.12) scaleY(var(--wave-depth));
        transform-origin: 50% 50%;
        visibility: hidden;
        width: var(--wave-size);
        z-index: 2147483646;
      }

      @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .minimal-wave-visualizer__shockwave {
          -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate)) contrast(var(--glass-contrast));
          backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate)) contrast(var(--glass-contrast));
        }

        .minimal-wave-visualizer__shockwave.is-analysis-fallback {
          -webkit-backdrop-filter: none;
          backdrop-filter: none;
        }
      }

      .minimal-wave-visualizer__shockwave::before,
      .minimal-wave-visualizer__shockwave::after {
        border-radius: inherit;
        content: "";
        inset: 0;
        pointer-events: none;
        position: absolute;
      }

      .minimal-wave-visualizer__shockwave::before {
        -webkit-mask-image: radial-gradient(circle, transparent calc(50% - var(--wave-thickness)), #000 calc(50% - var(--wave-thickness) + 4px), #000 calc(50% - 2px), transparent 50%);
        background: linear-gradient(180deg, rgba(255,255,255,0.88), rgba(255,255,255,0.05) 42%, rgba(0,0,0,0.34) 73%, rgba(30,215,96,0.16));
        mask-image: radial-gradient(circle, transparent calc(50% - var(--wave-thickness)), #000 calc(50% - var(--wave-thickness) + 4px), #000 calc(50% - 2px), transparent 50%);
        opacity: var(--rim-opacity);
      }

      .minimal-wave-visualizer__shockwave::after {
        background: radial-gradient(circle, transparent calc(50% - 5px), rgba(255,255,255,0.7) calc(50% - 3px), rgba(30,215,96,0.12) calc(50% - 1px), transparent 50%);
        opacity: var(--ripple-opacity);
        transform: scale(var(--ripple-scale));
      }

      .minimal-wave-visualizer__shockwave.is-active {
        visibility: visible;
        will-change: opacity, transform;
      }

      .minimal-wave-visualizer {
        --shake-x: 0px;
        --shake-y: 0px;
        align-items: center;
        background: linear-gradient(180deg, rgba(255,255,255,0.065), rgba(255,255,255,0.018));
        border: 1px solid rgba(255,255,255,0.11);
        border-radius: 10px;
        box-sizing: border-box;
        display: flex;
        gap: 2px;
        height: 50px;
        isolation: isolate;
        justify-content: stretch;
        left: 50%;
        min-width: 260px;
        overflow: visible;
        padding: 5px 3px;
        pointer-events: none;
        position: fixed;
        right: auto;
        transform: translateX(-50%) translate3d(var(--shake-x), var(--shake-y), 0);
        transition: border-color 180ms ease, background-color 180ms ease;
        will-change: transform;
        width: min(54vw, 740px);
        z-index: 2147483647;
      }

      .minimal-wave-visualizer__status {
        color: rgba(255,255,255,0.72);
        cursor: pointer;
        font: 600 9px/1 system-ui, sans-serif;
        letter-spacing: 0.05em;
        pointer-events: auto;
        position: absolute;
        right: 3px;
        text-decoration: none;
        text-shadow: 0 1px 4px rgba(0,0,0,0.8);
        top: -14px;
      }

      .minimal-wave-visualizer__status:hover,
      .minimal-wave-visualizer__status:focus-visible {
        color: rgba(255,255,255,0.98);
        text-decoration: underline;
      }

      .minimal-wave-visualizer__bar {
        background: linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.34));
        border-radius: 999px;
        flex: 1 1 var(--bar-width, 3px);
        height: calc(100% - 2px);
        min-width: 1px;
        opacity: var(--opacity, 0.55);
        position: relative;
        transform: scaleX(var(--thin, 0.65)) scaleY(var(--scale, 0.1));
        transform-origin: 50% 50%;
        transition: opacity 160ms ease, transform 20ms linear;
        z-index: 1;
      }

      .minimal-wave-visualizer.is-paused .minimal-wave-visualizer__bar {
        transition-duration: 220ms;
      }

      .minimal-wave-visualizer.is-fallback .minimal-wave-visualizer__bar {
        transition: opacity 160ms ease, transform 34ms linear;
      }

      @media (max-width: 900px) {
        .minimal-wave-visualizer {
          left: 16px;
          min-width: 0;
          right: 16px;
          transform: translate3d(var(--shake-x), var(--shake-y), 0);
          width: auto;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createShockwaveLayer() {
    shockwave = document.createElement("div");
    shockwave.className = "minimal-wave-visualizer__shockwave";
    document.body.appendChild(shockwave);
  }

  function positionShockwave() {
    if (!root || !shockwave) {
      return;
    }

    const geometry = shockwaveGeometry(
      root.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight
    );
    waveOriginX = geometry.x;
    waveOriginY = geometry.y;
    waveStartScale = geometry.startScale;
    shockwave.style.setProperty("--wave-size", geometry.size.toFixed(1) + "px");
    shockwave.style.setProperty("--wave-x", geometry.x.toFixed(1) + "px");
    shockwave.style.setProperty("--wave-y", geometry.y.toFixed(1) + "px");
  }

  function cancelShockwaveAnimations() {
    shockwaveAnimation?.cancel();
    pressureAnimation?.cancel();
    impactAnimation?.cancel();
    shockwaveAnimation = null;
    pressureAnimation = null;
    impactAnimation = null;
    shockwave?.classList.remove("is-active");
    shockwave?.classList.remove("is-analysis-fallback");
    shockwave?.style.removeProperty("will-change");
  }

  function startShockwave(strength, analysisFallback) {
    if (!root || !shockwave || reducedMotion.matches || typeof shockwave.animate !== "function") {
      return;
    }

    cancelShockwaveAnimations();
    const pressureTarget = document.querySelector(".Root__top-container");
    const targetRect = pressureTarget ? pressureTarget.getBoundingClientRect() : null;
    positionShockwave();

    const power = clamp(strength, 0, 1);
    const peak = dropVisualState(0.15, power);
    const offsets = [0, 0.08, 0.28, 0.62, 1];
    const frames = offsets.map((offset) => {
      const state = dropVisualState(offset, power);
      const scale = waveStartScale + (1.045 - waveStartScale) * state.ringProgress;

      return {
        offset,
        opacity: state.waveOpacity,
        transform: `translate(-50%, -50%) scale3d(${scale.toFixed(4)}, ${(scale * state.waveDepth).toFixed(4)}, 1)`,
      };
    });

    shockwave.style.setProperty("--glass-blur", (0.7 + power * 1.1).toFixed(2) + "px");
    shockwave.style.setProperty("--glass-contrast", (1.03 + power * 0.08).toFixed(3));
    shockwave.style.setProperty("--glass-saturate", (1.08 + power * 0.18).toFixed(3));
    shockwave.style.setProperty("--rim-opacity", Math.max(0.52, peak.rimOpacity).toFixed(3));
    shockwave.style.setProperty("--ripple-opacity", (0.28 + power * 0.34).toFixed(3));
    shockwave.style.setProperty("--ripple-scale", (1 - peak.rippleGap).toFixed(3));
    shockwave.style.setProperty("--wave-thickness", peak.waveThickness.toFixed(1) + "px");
    shockwave.classList.toggle("is-analysis-fallback", analysisFallback);
    shockwave.classList.add("is-active");
    shockwave.style.setProperty("will-change", "opacity, transform");

    const waveAnimation = shockwave.animate(frames, {
      duration: DROP_DURATION_MS,
      easing: "linear",
    });
    shockwaveAnimation = waveAnimation;
    waveAnimation.onfinish = () => {
      if (shockwaveAnimation !== waveAnimation) {
        return;
      }
      shockwaveAnimation = null;
      shockwave.classList.remove("is-active");
      shockwave.style.removeProperty("will-change");
    };

    const visualizerImpact = root.animate([
      { offset: 0, scale: "1 1" },
      { offset: 0.18, scale: `${(1 + power * 0.018).toFixed(4)} ${(1 - power * 0.075).toFixed(4)}` },
      { offset: 0.52, scale: `${(1 - power * 0.004).toFixed(4)} ${(1 + power * 0.012).toFixed(4)}` },
      { offset: 1, scale: "1 1" },
    ], {
      duration: 360,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
    impactAnimation = visualizerImpact;
    visualizerImpact.onfinish = () => {
      if (impactAnimation === visualizerImpact) {
        impactAnimation = null;
      }
    };

    if (pressureTarget && targetRect && typeof pressureTarget.animate === "function") {
      const origin = `${(waveOriginX - targetRect.left).toFixed(1)}px ${(waveOriginY - targetRect.top).toFixed(1)}px`;
      const pressurePulse = pressureTarget.animate([
        { offset: 0, transform: "scale3d(1, 1, 1)", transformOrigin: origin },
        { offset: 0.28, transform: `scale3d(${(1 + power * 0.007).toFixed(4)}, ${(1 - power * 0.012).toFixed(4)}, 1)`, transformOrigin: origin },
        { offset: 0.62, transform: `scale3d(${(1 - power * 0.002).toFixed(4)}, ${(1 + power * 0.004).toFixed(4)}, 1)`, transformOrigin: origin },
        { offset: 1, transform: "scale3d(1, 1, 1)", transformOrigin: origin },
      ], {
        composite: "add",
        duration: 280,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
      pressureAnimation = pressurePulse;
      pressurePulse.onfinish = () => {
        if (pressureAnimation === pressurePulse) {
          pressureAnimation = null;
        }
      };
    }
  }

  function getPlaybar() {
    return Array.from(document.querySelectorAll(
      '[data-testid="now-playing-bar"], .Root__now-playing-bar, footer'
    )).find((element) => element.getBoundingClientRect().height > 0);
  }

  function placeRoot() {
    if (!root || !document.body) {
      return;
    }

    const playbar = getPlaybar();
    const playbarTop = playbar ? playbar.getBoundingClientRect().top : null;

    placedBottom = stableVisualizerBottom(playbarTop, window.innerHeight, placedBottom);
    root.style.bottom = Math.round(placedBottom) + "px";
    positionShockwave();
  }

  function currentTrackUri() {
    try {
      return window.Spicetify && Spicetify.Player && Spicetify.Player.data
        ? Spicetify.Player.data.item && Spicetify.Player.data.item.uri
        : "";
    } catch (error) {
      return "";
    }
  }

  function isPlaying() {
    try {
      return Boolean(
        window.Spicetify &&
          Spicetify.Player &&
          typeof Spicetify.Player.isPlaying === "function" &&
          Spicetify.Player.isPlaying()
      );
    } catch (error) {
      return true;
    }
  }

  function eventProgressValue(event) {
    const data = event && event.data;

    if (finiteNumber(data) !== null) {
      return data;
    }

    return (
      finiteNumber(data && data.position) ??
      finiteNumber(data && data.progress) ??
      finiteNumber(data && data.progress_ms) ??
      finiteNumber(data && data.positionAsOfTimestamp)
    );
  }

  function playerDurationRaw(player) {
    if (player && typeof player.getDuration === "function") {
      const value = finiteNumber(player.getDuration());
      if (value !== null) {
        return value;
      }
    }

    return finiteNumber(player && player.data && player.data.item && player.data.item.duration)
      ?? finiteNumber(player && player.data && player.data.item && player.data.item.duration_ms)
      ?? finiteNumber(player && player.data && player.data.item && player.data.item.metadata && player.data.item.metadata.duration);
  }

  function updateProgress(event) {
    try {
      const player = window.Spicetify && Spicetify.Player;
      const nextDuration = normalizeDurationMs(playerDurationRaw(player));
      const percent = player && typeof player.getProgressPercent === "function"
        ? normalizePercent(player.getProgressPercent())
        : null;
      const eventProgress = normalizeProgressMs(eventProgressValue(event), nextDuration);
      const directProgress = player && typeof player.getProgress === "function"
        ? normalizeProgressMs(player.getProgress(), nextDuration)
        : null;
      const nextProgress = directProgress ?? eventProgress ?? (percent !== null && nextDuration ? percent * nextDuration : null);

      durationMs = nextDuration || durationMs;

      if (nextProgress !== null) {
        progressMs = durationMs ? clamp(nextProgress, 0, durationMs) : Math.max(0, nextProgress);
      }

    } catch (error) {
      progressMs = 0;
    }
  }

  async function loadTrackData(force) {
    const uri = currentTrackUri();
    const now = performance.now();

    if (!uri) {
      window.setTimeout(loadTrackData, 700);
      return;
    }

    if (uri !== currentUri) {
      currentUri = uri;
      loadingUri = "";
      audioData = null;
      bassProfile = null;
      analysisFailures = 0;
      lastAnalysisAttempt = 0;
      resetDropMotion();
    }

    if (audioData || loadingUri === uri) {
      return;
    }

    const retryDelay = analysisFailures ? 5000 : 1000;
    if (!force && now - lastAnalysisAttempt < retryDelay) {
      return;
    }

    lastAnalysisAttempt = now;
    loadingUri = uri;

    if (!window.Spicetify || typeof Spicetify.getAudioData !== "function") {
      loadingUri = "";
      analysisFailures += 1;
      return;
    }

    try {
      const nextAudioData = await Spicetify.getAudioData(uri);
      if (uri === currentUri) {
        audioData = nextAudioData;
        bassProfile = buildBassProfile(nextAudioData);
        analysisFailures = 0;
      }
    } catch (error) {
      analysisFailures += 1;
      console.debug("[minimal-wave-visualizer] audio data unavailable", error);
    } finally {
      if (loadingUri === uri) {
        loadingUri = "";
      }
    }
  }

  function renderBars(now, playing, canAnimateMotion, nativeLevels, nativeFrameAt, force = false, snap = false) {
    const barStateKey = `${playing}:${canAnimateMotion}:${Boolean(nativeLevels)}:${Boolean(audioData)}`;
    const forceBarUpdate = force || displayedLevels.length !== bars.length || barStateKey !== lastBarStateKey;
    if (!barUpdateNeeded(
      nativeFrameAt,
      lastNativeBarFrameAt,
      now,
      lastBarUpdateAt,
      forceBarUpdate,
      canAnimateMotion
    )) {
      return false;
    }

    const liveLevels = nativeLevels
      ? normalizeSpectrumPeak(spatialSmoothLevels(nativeLevels))
      : segmentLevels(audioData, progressMs / 1000, bars.length, canAnimateMotion);
    const stateOpacity = barStateOpacity(playing, Boolean(nativeLevels), Boolean(audioData));
    const barDeltaMs = lastBarUpdateAt ? now - lastBarUpdateAt : BAR_REFERENCE_FRAME_MS;

    for (let index = 0; index < bars.length; index += 1) {
      const current = displayedLevels[index] ?? liveLevels[index];
      const level = nextBarLevel(current, liveLevels[index], barDeltaMs, snap);
      displayedLevels[index] = level;
      const visual = barVisualState(level, index, bars.length, stateOpacity);
      const scale = visual.scale.toFixed(3);
      const thin = visual.thin.toFixed(3);
      const opacity = visual.opacity.toFixed(3);
      const styleKey = `${scale}:${thin}:${opacity}`;
      if (renderedBarStyles[index] !== styleKey) {
        renderedBarStyles[index] = styleKey;
        bars[index].style.setProperty("--scale", scale);
        bars[index].style.setProperty("--thin", thin);
        bars[index].style.setProperty("--opacity", opacity);
      }
    }

    lastBarUpdateAt = now;
    lastNativeBarFrameAt = nativeFrameAt;
    lastBarStateKey = barStateKey;
    return true;
  }

  function renderMotionFrame(now, playing) {
    playerPlaying = playing;

    updateProgress();

    const seconds = progressMs / 1000;
    const metrics = motionMetrics(audioData, seconds, bassProfile);
    const canAnimateMotion = playing && !reducedMotion.matches;
    const bassDeltaSeconds = lastBassFrameAt
      ? clamp((now - lastBassFrameAt) / 1000, 0, 0.1)
      : 1 / 60;
    const jumped = lastDrawSeconds > 0 && Math.abs(seconds - lastDrawSeconds) > 2;

    if (jumped) {
      resetDropMotion();
    }
    lastDrawSeconds = seconds;

    const nativeStatusActive = nativeBassStatus(
      nativeBassFrame,
      Boolean(nativeSocket && nativeSocket.readyState === 1)
    );
    const nativeMotion = nativeBassMotion(
      nativeBassFrame,
      now,
      playing,
      reducedMotion.matches,
      previousNativeBassFrame
    );
    const nativeLevels = nativeMotion ? nativeSpectrumLevels(nativeBassFrame, bars.length) : null;

    const dropTriggered = canAnimateMotion && dropShouldTrigger(metrics, seconds, lastWaveAt);
    const vocalTriggered = canAnimateMotion && vocalShouldTrigger(metrics, seconds, lastWaveAt);

    if (dropTriggered || vocalTriggered) {
      lastWaveAt = seconds;
      const strength = dropTriggered
        ? clamp(0.55 + ((metrics.dropScore - 0.66) / 0.34) * 0.45, 0.55, 1)
        : clamp(0.6 + ((metrics.vocalOnset - 0.52) / 0.48) * 0.28, 0.6, 0.88);
      startShockwave(strength, fallbackShockwaveMode(nativeStatusActive));
    }

    if (!canAnimateMotion && (shockwaveAnimation || pressureAnimation || impactAnimation)) {
      cancelShockwaveAnimations();
    }

    if (canAnimateMotion && nativeMotion) {
      bassEnvelopeDuration = nativeMotion.releaseSeconds;
      bassReactivity = Math.max(
        nativeMotion.reactivity,
        bassReactivity * Math.exp(-bassDeltaSeconds / 0.13)
      );
      bassEnvelope = smoothBassEnvelope(
        bassEnvelope,
        nativeMotion.target,
        bassDeltaSeconds,
        bassEnvelopeDuration
      );
      lastBassFrameAt = now;
    } else if (canAnimateMotion && audioData) {
      bassReactivity = 0;
      if (metrics.bass > 0.1) {
        bassEnvelopeDuration = metrics.bassDuration;
      }
      bassEnvelope = smoothBassEnvelope(
        bassEnvelope,
        metrics.bass,
        bassDeltaSeconds,
        bassEnvelopeDuration
      );
      lastBassFrameAt = now;
    } else {
      resetBassMotion(false);
    }

    const shakeEnergy = canAnimateMotion
      ? nativeMotion ? clamp(bassEnvelope, 0, 1) : shakeIntensity(bassEnvelope)
      : 0;
    const shakeHz = nativeMotion ? bassShakeRate(nativeBassFrame.activeMs, bassReactivity) : 8.3;
    shakePhase = canAnimateMotion
      ? (shakePhase + bassDeltaSeconds * Math.PI * 2 * shakeHz) % (Math.PI * 2)
      : 0;
    const shakeX = Math.sin(shakePhase) * shakeEnergy * (2.8 + shakeEnergy * 1.6);

    const version = statusText(nativeStatusActive);
    if (root.dataset.version !== version) {
      root.dataset.version = version;
      statusLink.textContent = version;
      statusLink.title = nativeStatusActive
        ? "Native Spotify FFT is active. Open the project page."
        : "Preview mode is active. Open the native FFT setup guide.";
    }

    const nextShakeX = shakeX.toFixed(2) + "px";
    if (nextShakeX !== renderedShakeX) {
      renderedShakeX = nextShakeX;
      root.style.setProperty("--shake-x", nextShakeX);
    }

    if (now - lastTrackCheck > 500) {
      lastTrackCheck = now;
      loadTrackData(false);
    }

    root.classList.toggle("is-paused", !playing);
    root.classList.toggle("is-fallback", !nativeStatusActive);
    const resyncBars = focusResyncNeeded(focusResyncPending, Boolean(nativeLevels));
    const barsRendered = renderBars(
      now,
      playing,
      canAnimateMotion,
      nativeLevels,
      nativeLevels ? nativeBassFrame.receivedAt : null,
      resyncBars,
      resyncBars
    );
    if (resyncBars && barsRendered) {
      focusResyncPending = false;
    }
    if (smoothRestorePending && barsRendered) {
      smoothRestorePending = false;
    }
  }

  function draw() {
    if (documentHiddenState()) {
      pauseHiddenMotion();
      return;
    }

    resumeVisibleMotion();
    if (!documentFocusState()) {
      suspendForegroundDraw();
      return;
    }

    windowFocused = true;
    renderMotionFrame(performance.now(), isPlaying());
    raf = foregroundDrawShouldContinue(windowFocused) ? window.requestAnimationFrame(draw) : 0;
  }

  function addPlayerListener(type, callback) {
    if (
      window.Spicetify &&
      Spicetify.Player &&
      typeof Spicetify.Player.addEventListener === "function"
    ) {
      Spicetify.Player.addEventListener(type, callback);
      playerListeners.push([type, callback]);
    }
  }

  function destroy() {
    window.cancelAnimationFrame(raf);
    window.clearInterval(placementTimer);
    disconnectNativeBass();
    resetBassMotion(true);
    cancelShockwaveAnimations();

    for (const [type, callback] of playerListeners) {
      if (
        window.Spicetify &&
        Spicetify.Player &&
        typeof Spicetify.Player.removeEventListener === "function"
      ) {
        Spicetify.Player.removeEventListener(type, callback);
      }
    }

    removeWindowListeners(window, windowListeners);
    removeWindowListeners(document, documentListeners);

    document.getElementById(ROOT_ID + "-style")?.remove();
    shockwave?.remove();
    root?.remove();
    statusLink = null;
    delete window.__minimalWaveVisualizer;
  }

  function boot() {
    if (!document.body) {
      window.setTimeout(boot, 50);
      return;
    }

    injectStyle();
    createShockwaveLayer();

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "minimal-wave-visualizer";
    root.dataset.version = statusText(false);
    root.title = "Minimal Wave Visualizer";

    statusLink = document.createElement("a");
    statusLink.className = "minimal-wave-visualizer__status";
    statusLink.href = PROJECT_SETUP_URL;
    statusLink.target = "_blank";
    statusLink.rel = "noopener noreferrer";
    statusLink.textContent = statusText(false);
    statusLink.title = "Preview mode is active. Open the native FFT setup guide.";
    root.appendChild(statusLink);

    bars = Array.from({ length: BAR_COUNT }, () => {
      const bar = document.createElement("span");
      bar.className = "minimal-wave-visualizer__bar";
      root.appendChild(bar);
      return bar;
    });

    document.body.appendChild(root);
    playerPlaying = isPlaying();
    connectNativeBass();
    placeRoot();
    placementTimer = window.setInterval(placeRoot, 1500);
    const resetPlayerMotion = (event) => {
      playerPlaying = isPlaying();
      updateProgress(event);
      resetBassMotion(false);
    };

    addPlayerListener("songchange", () => {
      currentUri = "";
      displayedLevels = [];
      renderedBarStyles = [];
      lastNativeBarFrameAt = null;
      lastBarStateKey = "";
      resetBassMotion(true);
      resetDropMotion();
      updateProgress();
      loadTrackData(true);
      window.setTimeout(placeRoot, 120);
    });
    addPlayerListener("onplaypause", resetPlayerMotion);
    addPlayerListener("onprogress", updateProgress);
    addPlayerListener("progress", updateProgress);
    addPlayerListener("seek", resetPlayerMotion);
    addPlayerListener("onseek", resetPlayerMotion);

    const handleWindowBlur = suspendForegroundDraw;
    const handleWindowFocus = resumeForegroundDraw;
    const handleVisibilityChange = () => {
      if (documentHiddenState()) {
        pauseHiddenMotion();
      } else {
        resumeVisibleMotion();
        if (documentFocusState()) {
          resumeForegroundDraw();
        }
      }
    };

    for (const [type, callback] of [
      ["resize", placeRoot],
      ["blur", handleWindowBlur],
      ["focus", handleWindowFocus],
    ]) {
      window.addEventListener(type, callback);
      windowListeners.push([type, callback]);
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    documentListeners.push(["visibilitychange", handleVisibilityChange]);
    window.__minimalWaveVisualizer = { destroy };
    updateProgress();
    loadTrackData(true);
    draw();
  }

  boot();
})();
