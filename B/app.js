const canvas = document.getElementById("sphereCanvas");
const ctx = canvas.getContext("2d");
const SPHERE_FRACTION = 0.5;
const BACKDROP_FADE = 0.62;
const micEnableButton = document.getElementById("micEnableButton");
const micDeclineButton = document.getElementById("micDeclineButton");
const micStatusText = document.getElementById("micStatusText");
const listenerPopup = document.getElementById("listenerPopup");

const PARTICLE_COUNT = 3400;
const STRIPE_COUNT = 4;
const SPIKE_SAMPLE_COUNT = 256;
const SPIKE_LENGTH_SCALE = 1.35;
const SPIKE_BASE_RATIO = 0.05;
const SPIKE_DECAY = 0.17;
const SPIKE_MIN_RETENTION = 0.94;
const POINTER_ALIGNMENT_EXP = 3.1;
const POINTER_DISTANCE_FALLOFF = 0.85;
const POINTER_MAX_BOOST = 4.4;
const POINTER_SMOOTHNESS = 0.18;
const POINTER_TARGET_DECAY = 0.1;
const particles = createParticles();
const stripeBuckets = createStripeBuckets(particles);
const positions = createPositionBuffer(particles.length);

let audioContext = null;
let analyser = null;
let timeDomainArray = null;
let frequencyArray = null;
let animationId = null;
let phase = 0;
let mediaStream = null;
const state = {
  isRunning: false,
  volume: 0,
  targetVolume: 0,
};
const pointerState = {
  isDown: false,
  x: 0,
  y: 0,
  smoothX: 0,
  smoothY: 0,
  strength: 0,
  targetStrength: 0,
  shock: 0,
  hasInteracted: false,
};

renderSphere.shouldCheckBounds = true;

setupCanvas();
renderSphere(0, 0);
initializeMicPrompt();

micEnableButton.addEventListener("click", handleMicEnable);
micDeclineButton.addEventListener("click", handleMicDecline);
canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointercancel", handlePointerUp);
canvas.addEventListener("pointerleave", handlePointerLeave);

window.addEventListener("resize", () => {
  setupCanvas();
  renderSphere(state.volume, phase);
});

async function handleMicEnable() {
  disableMicButtons(true);
  const success = await enableAudio();
  if (success) {
    setMicStatus("");
    hideListenerPopup();
  } else {
    disableMicButtons(false);
  }
}

function handlePointerDown(event) {
  pointerState.hasInteracted = true;
  pointerState.isDown = true;
  pointerState.targetStrength = 1.1;
  pointerState.shock = 1.4;
  updatePointerFromEvent(event);
  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      console.debug("Pointer capture unavailable", err);
    }
  }
}

function handlePointerMove(event) {
  updatePointerFromEvent(event);
  if (pointerState.isDown) {
    pointerState.targetStrength = 1.05;
  } else {
    pointerState.targetStrength = Math.max(pointerState.targetStrength, 0.38);
  }
}

function handlePointerUp(event) {
  pointerState.isDown = false;
  pointerState.targetStrength = Math.max(pointerState.targetStrength, 0.18);
  pointerState.shock = Math.max(pointerState.shock, 0.22);
  if (canvas.releasePointerCapture) {
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch (err) {
      /* noop */
    }
  }
}

function handlePointerLeave() {
  pointerState.isDown = false;
  pointerState.targetStrength = 0;
}

function handleMicDecline() {
  cleanupAudioResources();
  setMicStatus("마이크 미사용", false);
  hideListenerPopup();
  renderSphere(0, phase);
}

function disableMicButtons(disabled) {
  micEnableButton.disabled = disabled;
  micDeclineButton.disabled = disabled;
}

async function enableAudio() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMicStatus("미지원", true);
    return false;
  }

  try {
    setMicStatus("연결 중", false);
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.65;
    timeDomainArray = new Uint8Array(analyser.fftSize);
    frequencyArray = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    state.isRunning = true;
    state.volume = 0;
    state.targetVolume = 0;

    if (!animationId) {
      loop();
    }

    setMicStatus("마이크 활성화", false);
    return true;
  } catch (error) {
    console.error(error);
    setMicStatus("거부됨", true);
    cleanupAudioResources();
    return false;
  }
}

function cleanupAudioResources() {
  stopAnimation();
  state.isRunning = false;
  state.volume = 0;
  state.targetVolume = 0;

  if (audioContext) {
    audioContext.close().catch((err) => {
      console.error(err);
    });
    audioContext = null;
  }

  analyser = null;
  timeDomainArray = null;
  frequencyArray = null;

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (err) {
        console.error(err);
      }
    });
    mediaStream = null;
  }
}

function stopAnimation() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

function loop() {
  if (!state.isRunning || !analyser) {
    animationId = null;
    return;
  }

  analyser.getByteTimeDomainData(timeDomainArray);
  analyser.getByteFrequencyData(frequencyArray);
  const volume = computeVolume(timeDomainArray);
  state.targetVolume = volume;
  state.volume += (state.targetVolume - state.volume) * 0.12;

  phase += 0.017 + state.volume * 0.32;
  advancePointerState();

  renderSphere(state.volume, phase);
  animationId = requestAnimationFrame(loop);
}

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = window.innerWidth || canvas.clientWidth || canvas.width;
  const displayHeight =
    window.innerHeight || canvas.clientHeight || canvas.height;

  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  canvas.width = Math.max(1, Math.floor(displayWidth * dpr));
  canvas.height = Math.max(1, Math.floor(displayHeight * dpr));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  if (!pointerState.hasInteracted) {
    pointerState.x = displayWidth / 2;
    pointerState.y = displayHeight / 2;
    pointerState.smoothX = pointerState.x;
    pointerState.smoothY = pointerState.y;
  }
}

function computeVolume(timeDomain) {
  let sumSquares = 0;
  for (let i = 0; i < timeDomain.length; i += 1) {
    const centered = (timeDomain[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  const rms = Math.sqrt(sumSquares / timeDomain.length);
  return Math.min(rms * 3.8, 1);
}

function advancePointerState() {
  const pointer = pointerState;
  if (!pointer.isDown && pointer.targetStrength > 0) {
    pointer.targetStrength = Math.max(
      0,
      pointer.targetStrength - POINTER_TARGET_DECAY
    );
  }
  pointer.smoothX += (pointer.x - pointer.smoothX) * (POINTER_SMOOTHNESS * 1.4);
  pointer.smoothY += (pointer.y - pointer.smoothY) * (POINTER_SMOOTHNESS * 1.4);
  pointer.strength += (pointer.targetStrength - pointer.strength) * POINTER_SMOOTHNESS;
  pointer.shock *= 0.88;
}

function updatePointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  pointerState.x = event.clientX - rect.left;
  pointerState.y = event.clientY - rect.top;
}

function renderSphere(volume, timePhase) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  ctx.fillStyle = `rgba(5, 5, 5, ${BACKDROP_FADE})`;
  ctx.fillRect(0, 0, width, height);

  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.min(centerX, centerY);
  const volumeBoost = volume * volume;
  const dynamicScale = 1 + volume * 0.32 + volumeBoost * 0.8;
  const rawRadius = baseRadius * SPHERE_FRACTION * dynamicScale;
  const maxRadius = baseRadius * 0.94;
  const radiusScale = rawRadius > maxRadius ? maxRadius / rawRadius : 1;
  const radius = rawRadius * radiusScale;
  const freedom = Math.min(volumeBoost * 3.2, 4.5) * radiusScale;
  const warpPhase = timePhase * (0.6 + freedom * 0.4);
  const chaosPhase = timePhase * (1.2 + freedom * 0.9);

  const shouldCheckBounds = renderSphere.shouldCheckBounds;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const freqData = frequencyArray;
  const freqLength = freqData ? freqData.length : 0;
  const usableFreq = freqLength > 0 ? Math.min(freqLength, SPIKE_SAMPLE_COUNT) : 0;
  const pointerSmoothX = pointerState.smoothX;
  const pointerSmoothY = pointerState.smoothY;
  const pointerDeltaX = pointerSmoothX - centerX;
  const pointerDeltaY = pointerSmoothY - centerY;
  const pointerDistance = Math.sqrt(pointerDeltaX * pointerDeltaX + pointerDeltaY * pointerDeltaY);
  const pointerStrength = Math.min(pointerState.strength * 1.4 + pointerState.shock * 0.9, 1.9);
  const pointerActive = pointerStrength > 0.02;
  const pointerRadius = Math.max(radius, 1e-4);
  const normalizedPointerDistance = pointerDistance / pointerRadius;
  const pointerSurfaceBias = Math.exp(-Math.pow(Math.max(0, normalizedPointerDistance - 0.2) / POINTER_DISTANCE_FALLOFF, 2));
  const basePointerInfluence = pointerActive
    ? pointerStrength * Math.max(0.12, pointerSurfaceBias)
    : 0;
  const pointerDirX = pointerDistance > 1e-4 ? pointerDeltaX / pointerDistance : 0;
  const pointerDirY = pointerDistance > 1e-4 ? pointerDeltaY / pointerDistance : -1;

  for (let i = 0; i < particles.length; i += 1) {
    const particle = particles[i];
    const position = positions[i];
    const bandFactor = particle.band / STRIPE_COUNT;
    const seed = particle.seed;
    const freqIndex =
      usableFreq > 0
        ? Math.floor(particle.freqSeed * usableFreq) % usableFreq
        : 0;
    const rawEnergy = usableFreq > 0 ? freqData[freqIndex] / 255 : 0;
    const energy = Math.pow(rawEnergy, 1.6);

    const theta =
      particle.theta +
      timePhase * (0.7 + bandFactor * 0.18 + volume * 0.7 + freedom * 0.2) +
      Math.sin(timePhase * 0.85 + seed * 3.1) * (0.12 + volume * 0.2) +
      Math.cos(chaosPhase * 1.6 + seed * 8.4) * (0.08 + freedom * 0.95);
    const phi =
      particle.phi +
      Math.sin(timePhase * 0.65 + seed * 4.2) * (0.28 + volume * 0.45 + freedom * 0.18) +
      Math.cos(warpPhase * 1.1 + seed * 6.7) * (0.05 + freedom * 0.75);

    const wobble =
      Math.sin(timePhase * 1.4 + seed * 6) * (0.08 + volume * 0.18 + freedom * 0.55) +
      Math.sin(chaosPhase * 2.2 + seed * 12.5) * (freedom * 0.4);

    const x = Math.cos(theta) * Math.cos(phi + wobble * 0.5);
    const y = Math.sin(phi + wobble);
    const z = Math.sin(theta) * Math.cos(phi + wobble * 0.4);

    const shellWarp =
      1 +
      Math.sin(warpPhase * 2.4 + seed * 9.3) * (freedom * 0.8) +
      Math.cos(chaosPhase * 1.9 + bandFactor * Math.PI * 2) * (freedom * 0.5);

    const offsetX =
      Math.sin(chaosPhase * 2.8 + seed * 14.2) *
      baseRadius *
      freedom *
      0.55 *
      radiusScale;
    const offsetY =
      Math.cos(chaosPhase * 2.5 + seed * 10.9) *
      baseRadius *
      freedom *
      0.5 *
      radiusScale;

    const baseX = centerX + x * radius * shellWarp + offsetX;
    const baseY = centerY + y * radius * shellWarp + offsetY;
    const radialX = baseX - centerX;
    const radialY = baseY - centerY;
    const radialDistance = Math.max(
      Math.sqrt(radialX * radialX + radialY * radialY),
      1e-4
    );
    const normalizedX = radialX / radialDistance;
    const normalizedY = radialY / radialDistance;
    let pointerBoost = 0;
    if (pointerActive) {
      const alignment = Math.max(0, normalizedX * pointerDirX + normalizedY * pointerDirY);
      if (alignment > 0) {
        const radialRatio = radialDistance / pointerRadius;
        const pointerCloseness = Math.exp(
          -Math.pow(Math.max(0, radialRatio - normalizedPointerDistance) / POINTER_DISTANCE_FALLOFF, 2)
        );
        const alignmentBoost = Math.pow(alignment, POINTER_ALIGNMENT_EXP);
        pointerBoost =
          basePointerInfluence *
          alignmentBoost *
          (0.45 + pointerCloseness * 0.9);
      }
    }
    const targetSpike =
      energy * (1.6 + freedom * 0.8) +
      volumeBoost * 0.7 +
      volume * 0.48 +
      pointerBoost * POINTER_MAX_BOOST;
    const responseSpeed = 0.34 + volume * 0.45 + pointerStrength * 0.28;
    position.spike += (targetSpike - position.spike) * responseSpeed;
    position.spike = Math.max(position.spike * SPIKE_MIN_RETENTION - SPIKE_DECAY * 0.01, 0);
    const spikeLength =
      radius *
      (SPIKE_BASE_RATIO + position.spike * SPIKE_LENGTH_SCALE) *
      (1 + freedom * 0.45);
    const posX = baseX + normalizedX * spikeLength;
    const posY = baseY + normalizedY * spikeLength;
    const depth = (z + 1) * 0.5;

    position.x = posX;
    position.y = posY;
    position.z = depth;
    position.theta = theta;
    position.coreX = baseX;
    position.coreY = baseY;

    if (shouldCheckBounds) {
      if (posX < minX) minX = posX;
      if (posX > maxX) maxX = posX;
      if (posY < minY) minY = posY;
      if (posY > maxY) maxY = posY;
    }
  }

  ctx.fillStyle = "#fefefe";
  for (let i = 0; i < positions.length; i += 1) {
    const point = positions[i];
    const size =
      (0.6 + point.z * 2.2 + volume * 1.2) *
      (1 + freedom * 1.8) *
      (0.85 + SPHERE_FRACTION * 0.24) *
      2;
    ctx.globalAlpha = 0.08 + point.z * 0.85 + volume * 0.3 + freedom * 0.25;
    const half = size * 0.28;
    ctx.fillRect(point.x - half, point.y - half, half * 2, half * 2);
  }

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = Math.min(0.22 + volume * 0.7 + freedom * 0.6, 0.85);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.38)";
  ctx.lineWidth = Math.max(0.5, 0.8 + volume * 1.8 + freedom * 1.3);
  for (let i = 0; i < positions.length; i += 2) {
    const point = positions[i];
    if (point.spike <= 0.01) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(point.coreX, point.coreY);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = Math.min(0.26 + volume * 0.6 + freedom * 0.25, 0.92);
  ctx.lineWidth = Math.max(0.6, 1.2 + volume * 2.2 + freedom * 1.4);

  for (let band = 0; band < STRIPE_COUNT; band += 1) {
    const bucket = stripeBuckets[band];
    bucket.sort((a, b) => positions[a].theta - positions[b].theta);

    ctx.beginPath();
    for (let i = 0; i < bucket.length; i += 1) {
      const p = positions[bucket[i]];
      if (i === 0) {
        ctx.moveTo(p.x, p.y);
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  if (shouldCheckBounds) {
    const withinBounds =
      minX >= 0 && maxX <= width && minY >= 0 && maxY <= height;
    console.assert(
      withinBounds,
      "Sphere rendering exceeded canvas bounds",
      { minX, maxX, minY, maxY, width, height }
    );
    renderSphere.shouldCheckBounds = false;
  }
}

function setMicStatus(message, isError) {
  if (!micStatusText) {
    return;
  }
  micStatusText.textContent = message;
  micStatusText.dataset.error = isError ? "true" : "false";
}

function initializeMicPrompt() {
  showListenerPopup();
  setMicStatus("", false);
  disableMicButtons(false);
}

function showListenerPopup() {
  if (!listenerPopup) {
    return;
  }
  listenerPopup.classList.remove("is-hidden");
}

function hideListenerPopup() {
  if (!listenerPopup) {
    return;
  }
  listenerPopup.classList.add("is-hidden");
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopAnimation();
    if (audioContext && audioContext.state === "running") {
      audioContext.suspend().catch((err) => {
        console.error(err);
      });
    }
  } else if (state.isRunning && audioContext) {
    if (audioContext.state === "suspended") {
      audioContext.resume().catch((err) => {
        console.error(err);
      });
    }
    if (!animationId) {
      loop();
    }
  }
}

document.addEventListener("visibilitychange", handleVisibilityChange);

function createParticles() {
  const items = [];
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const band = i % STRIPE_COUNT;
    const baseTheta = (band / STRIPE_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const basePhi = (Math.random() - 0.5) * Math.PI * 0.75;
    const seed = Math.random();
    const freqSeed = Math.random();
    items.push({ band, theta: baseTheta, phi: basePhi, seed, freqSeed });
  }
  return items;
}

function createStripeBuckets(items) {
  return Array.from({ length: STRIPE_COUNT }, () => []).map((bucket, idx) => {
    const indices = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].band === idx) {
        indices.push(i);
      }
    }
    return indices;
  });
}

function createPositionBuffer(count) {
  const buffer = new Array(count);
  for (let i = 0; i < count; i += 1) {
    buffer[i] = { x: 0, y: 0, z: 0, theta: 0, spike: 0, coreX: 0, coreY: 0 };
  }
  return buffer;
}

