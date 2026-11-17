/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

type GamePhase = 'TITLE' | 'PLAYING' | 'GAME_OVER';
type MoneyVariant = 'single' | 'tall' | 'wide';
type CurrencyTone = 'green' | 'red';
type CameraStatus = 'off' | 'loading' | 'active' | 'error';
type JumpSensitivity = 'easy' | 'normal' | 'hard';

const SENSITIVITY_THRESHOLDS: Record<JumpSensitivity, { vel: number; lift: number }> = {
  easy: { vel: 0.85, lift: 0.14 },
  normal: { vel: 1.25, lift: 0.2 },
  hard: { vel: 1.85, lift: 0.28 },
};

interface MoneyStack {
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  variant: MoneyVariant;
  tone: CurrencyTone;
  bobPhase: number;
}

interface Cloud {
  x: number;
  y: number;
  scale: number;
  speed: number;
}

interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  color: string;
  kind: 'dust' | 'bill';
  rotation: number;
  vRot: number;
}

interface FloatingNotice {
  text: string;
  x: number;
  y: number;
  life: number;
  maxLife: number;
}

interface GroundPebble {
  x: number;
  yOffset: number;
  w: number;
  h: number;
}

interface PlayerState {
  x: number;
  y: number;
  width: number;
  height: number;
  vy: number;
  grounded: boolean;
  fastFalling: boolean;
  ducking: boolean;
  runPhase: number;
  blinkTimer: number;
  isBlinking: boolean;
  jumpBufferTimer: number;
  holdingJump: boolean;
  jumpHoldTimer: number;
}

const LOGICAL_WIDTH = 900;
const LOGICAL_HEIGHT = 360;
const GROUND_Y = 292;
const PLAYER_X = 88;
const PLAYER_WIDTH = 48;
const PLAYER_HEIGHT = 60;
const GRAVITY = 2650;
const JUMP_VELOCITY = -820;
const INITIAL_SPEED = 390;
const MAX_SPEED = 940;
const SPEED_RAMP_PER_SEC = 10.5;
const HIGH_SCORE_STORAGE_KEY = 'wowo_jumpu_best_score';
const MUTE_STORAGE_KEY = 'wowo_jumpu_muted';

// Synthesized arcade audio with zero external dependencies
const SoundFX = {
  ctx: null as AudioContext | null,

  ensureCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  },

  playJump(muted: boolean) {
    if (muted) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(560, now + 0.11);

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  },

  playMilestone(muted: boolean) {
    if (muted) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = now + idx * 0.065;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.11, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  },

  playGameOver(muted: boolean) {
    if (muted) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.32);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.34);
  },
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(hexA: string, hexB: string, t: number): string {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return `rgb(${r}, ${g}, ${bl})`;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export const WowoGame: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const visionCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [phase, setPhase] = useState<GamePhase>('TITLE');
  const [score, setScore] = useState<number>(0);
  const [bestScore, setBestScore] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(HIGH_SCORE_STORAGE_KEY);
      return saved ? Math.max(0, parseInt(saved, 10) || 0) : 0;
    } catch {
      return 0;
    }
  });
  const [isNewBest, setIsNewBest] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('off');
  const [cameraError, setCameraError] = useState<string>('');
  const [showCameraFeed, setShowCameraFeed] = useState<boolean>(true);
  const [sensitivity, setSensitivity] = useState<JumpSensitivity>('normal');
  const [jumpFlash, setJumpFlash] = useState<boolean>(false);
  const [poseDetected, setPoseDetected] = useState<boolean>(false);

  const phaseRef = useRef<GamePhase>('TITLE');
  const mutedRef = useRef<boolean>(isMuted);
  const bestScoreRef = useRef<number>(bestScore);
  const canRestartAtRef = useRef<number>(0);
  const sensitivityRef = useRef<JumpSensitivity>('normal');

  const visionRef = useRef<{
    poseLandmarker: { detectForVideo: (video: HTMLVideoElement, now: number) => { landmarks?: Array<Array<{ x: number; y: number }>> } } | null;
    stream: MediaStream | null;
    rafId: number;
    lastVideoTime: number;
    lastPredictionTime: number;
    prevY: number;
    baselineY: number;
    prevSampleNow: number;
    smoothedVelocity: number;
    lastJumpAt: number;
    wasJumpingUp: boolean;
    latestLandmarks: Array<{ x: number; y: number }> | null;
    active: boolean;
    lastPoseUiState: boolean;
  }>({
    poseLandmarker: null,
    stream: null,
    rafId: 0,
    lastVideoTime: -1,
    lastPredictionTime: 0,
    prevY: 0,
    baselineY: 0,
    prevSampleNow: 0,
    smoothedVelocity: 0,
    lastJumpAt: 0,
    wasJumpingUp: false,
    latestLandmarks: null,
    active: false,
    lastPoseUiState: false,
  });

  const worldRef = useRef({
    scoreFloat: 0,
    lastDisplayedScore: 0,
    lastMilestone: 0,
    speed: INITIAL_SPEED,
    skylineOffset: 0,
    spawnTimer: 0.9,
    shakeTimer: 0,
    idleTime: 0,
    player: {
      x: PLAYER_X,
      y: GROUND_Y - PLAYER_HEIGHT,
      width: PLAYER_WIDTH,
      height: PLAYER_HEIGHT,
      vy: 0,
      grounded: true,
      fastFalling: false,
      ducking: false,
      runPhase: 0,
      blinkTimer: 2.4,
      isBlinking: false,
      jumpBufferTimer: 0,
      holdingJump: false,
      jumpHoldTimer: 0,
    } as PlayerState,
    obstacles: Array.from({ length: 12 }, (): MoneyStack => ({
      active: false,
      x: 0,
      y: GROUND_Y,
      width: 44,
      height: 38,
      variant: 'single',
      tone: 'red',
      bobPhase: 0,
    })),
    particles: Array.from({ length: 48 }, (): Particle => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: 4,
      life: 0,
      maxLife: 0.4,
      color: '#CBD5E1',
      kind: 'dust',
      rotation: 0,
      vRot: 0,
    })),
    clouds: [
      { x: 140, y: 66, scale: 0.9, speed: 24 },
      { x: 430, y: 48, scale: 1.15, speed: 18 },
      { x: 740, y: 84, scale: 0.8, speed: 30 },
    ] as Cloud[],
    pebbles: Array.from({ length: 28 }, (_, i): GroundPebble => ({
      x: i * 36 + Math.random() * 18,
      yOffset: 8 + Math.random() * 44,
      w: 4 + Math.floor(Math.random() * 10),
      h: 2,
    })),
    notices: [] as FloatingNotice[],
  });

  useEffect(() => {
    mutedRef.current = isMuted;
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, String(isMuted));
    } catch {
      // Ignore storage error
    }
  }, [isMuted]);

  const spawnDust = useCallback((x: number, y: number, count: number) => {
    const { particles } = worldRef.current;
    let spawned = 0;
    for (let i = 0; i < particles.length && spawned < count; i++) {
      const p = particles[i];
      if (!p.active) {
        p.active = true;
        p.kind = 'dust';
        p.x = x + (Math.random() - 0.5) * 14;
        p.y = y - Math.random() * 4;
        p.vx = -60 - Math.random() * 90;
        p.vy = -25 - Math.random() * 55;
        p.size = 3 + Math.random() * 4;
        p.maxLife = 0.28 + Math.random() * 0.2;
        p.life = p.maxLife;
        p.color = '#94A3B8';
        p.rotation = 0;
        p.vRot = 0;
        spawned++;
      }
    }
  }, []);

  const spawnCrashBills = useCallback((x: number, y: number) => {
    const { particles } = worldRef.current;
    let spawned = 0;
    for (let i = 0; i < particles.length && spawned < 16; i++) {
      const p = particles[i];
      if (!p.active) {
        p.active = true;
        p.kind = 'bill';
        p.x = x + (Math.random() - 0.5) * 24;
        p.y = y + (Math.random() - 0.5) * 20;
        p.vx = (Math.random() - 0.35) * 260;
        p.vy = -120 - Math.random() * 240;
        p.size = 11 + Math.random() * 5;
        p.maxLife = 0.8 + Math.random() * 0.5;
        p.life = p.maxLife;
        p.color = spawned % 2 === 0 ? '#EF4444' : '#16A34A';
        p.rotation = Math.random() * Math.PI;
        p.vRot = (Math.random() - 0.5) * 10;
        spawned++;
      }
    }
  }, []);

  const startNewGame = useCallback(() => {
    SoundFX.ensureCtx();
    const w = worldRef.current;
    w.scoreFloat = 0;
    w.lastDisplayedScore = 0;
    w.lastMilestone = 0;
    w.speed = INITIAL_SPEED;
    w.spawnTimer = 0.75;
    w.shakeTimer = 0;
    w.notices = [];

    w.player.x = PLAYER_X;
    w.player.y = GROUND_Y - PLAYER_HEIGHT;
    w.player.vy = 0;
    w.player.grounded = true;
    w.player.fastFalling = false;
    w.player.ducking = false;
    w.player.runPhase = 0;
    w.player.jumpBufferTimer = 0;
    w.player.holdingJump = false;
    w.player.jumpHoldTimer = 0;

    for (const obs of w.obstacles) obs.active = false;
    for (const p of w.particles) p.active = false;

    phaseRef.current = 'PLAYING';
    setPhase('PLAYING');
    setScore(0);
    setIsNewBest(false);
  }, []);

  const triggerJumpPress = useCallback(() => {
    const currentPhase = phaseRef.current;

    if (currentPhase === 'TITLE') {
      startNewGame();
      const p = worldRef.current.player;
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      p.holdingJump = true;
      p.jumpHoldTimer = 0;
      spawnDust(p.x + p.width * 0.4, GROUND_Y, 6);
      SoundFX.playJump(mutedRef.current);
      return;
    }

    if (currentPhase === 'GAME_OVER') {
      if (performance.now() >= canRestartAtRef.current) {
        startNewGame();
      }
      return;
    }

    const p = worldRef.current.player;
    p.holdingJump = true;
    if (p.grounded) {
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      p.fastFalling = false;
      p.ducking = false;
      p.jumpHoldTimer = 0;
      p.jumpBufferTimer = 0;
      spawnDust(p.x + p.width * 0.4, GROUND_Y, 6);
      SoundFX.playJump(mutedRef.current);
    } else {
      // Buffer jump for 120ms if pressed right before touching ground
      p.jumpBufferTimer = 0.12;
    }
  }, [spawnDust, startNewGame]);

  const triggerJumpRelease = useCallback(() => {
    const p = worldRef.current.player;
    p.holdingJump = false;
  }, []);

  const triggerFastDrop = useCallback((active: boolean) => {
    const p = worldRef.current.player;
    if (phaseRef.current !== 'PLAYING') return;
    p.ducking = active;
    if (active && !p.grounded) {
      p.fastFalling = true;
      if (p.vy < 460) p.vy = 460;
    }
  }, []);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  const stopCamera = useCallback(() => {
    const v = visionRef.current;
    v.active = false;
    if (v.rafId) {
      cancelAnimationFrame(v.rafId);
      v.rafId = 0;
    }
    if (v.stream) {
      v.stream.getTracks().forEach((track) => track.stop());
      v.stream = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    v.prevSampleNow = 0;
    v.prevY = 0;
    v.baselineY = 0;
    v.smoothedVelocity = 0;
    v.wasJumpingUp = false;
    v.latestLandmarks = null;
    v.lastPoseUiState = false;
    setPoseDetected(false);
    setCameraStatus('off');
    setCameraError('');
  }, []);

  const runVisionLoop = useCallback(() => {
    const v = visionRef.current;
    if (!v.active) return;

    const video = videoRef.current;
    const outCanvas = visionCanvasRef.current;
    const now = performance.now();

    if (video && v.poseLandmarker && video.readyState >= 2 && video.videoWidth > 0) {
      if (now - v.lastPredictionTime >= 30) {
        v.lastPredictionTime = now;

        if (outCanvas) {
          if (outCanvas.width !== video.videoWidth || outCanvas.height !== video.videoHeight) {
            outCanvas.width = video.videoWidth;
            outCanvas.height = video.videoHeight;
          }
        }

        let didUpdate = false;
        const vidTime = video.currentTime;
        if (v.lastVideoTime !== vidTime || now - v.prevSampleNow >= 45) {
          v.lastVideoTime = vidTime;
          try {
            const result = v.poseLandmarker.detectForVideo(video, now);
            v.latestLandmarks = result?.landmarks?.[0] ?? null;
            didUpdate = true;
          } catch {
            // Skip transient frame error
          }
        }

        const landmarks = v.latestLandmarks;
        const cfg = SENSITIVITY_THRESHOLDS[sensitivityRef.current];

        // Prefer shoulders (11,12) if inside frame; otherwise fall back to ears/nose (7,8,0)
        const hasShoulders =
          landmarks &&
          landmarks[11] &&
          landmarks[12] &&
          landmarks[11].y < 0.96 &&
          landmarks[12].y < 0.96;
        const hasHead =
          landmarks && landmarks[0] && landmarks[7] && landmarks[8];

        const trackPoints = hasShoulders
          ? [landmarks![11], landmarks![12]]
          : hasHead
            ? [landmarks![7], landmarks![8]]
            : null;

        const isTracking = Boolean(trackPoints);
        if (v.lastPoseUiState !== isTracking) {
          v.lastPoseUiState = isTracking;
          setPoseDetected(isTracking);
        }

        if (trackPoints) {
          const leftPt = trackPoints[0];
          const rightPt = trackPoints[1];
          const currentY = hasShoulders
            ? (leftPt.y + rightPt.y) / 2
            : landmarks![0].y;
          const refDist = Math.max(
            0.07,
            Math.hypot(leftPt.x - rightPt.x, leftPt.y - rightPt.y)
          );

          if (didUpdate) {
            let currentVelocity = 0;
            let dy = 0;

            if (v.prevSampleNow > 0) {
              const dt = Math.min(0.15, Math.max(0.016, (now - v.prevSampleNow) / 1000));
              dy = v.prevY - currentY; // positive when moving UP
              currentVelocity = dy / refDist / dt;
            } else {
              v.baselineY = currentY;
            }

            v.smoothedVelocity = v.smoothedVelocity * 0.35 + currentVelocity * 0.65;

            // Update resting baseline slowly when not jumping
            if (Math.abs(currentVelocity) < 0.75) {
              v.baselineY = v.baselineY === 0 ? currentY : v.baselineY * 0.92 + currentY * 0.08;
            } else {
              v.baselineY = v.baselineY * 0.985 + currentY * 0.015;
            }

            const liftRatio = (v.baselineY - currentY) / refDist;
            v.prevY = currentY;
            v.prevSampleNow = now;

            const velocityTriggered = v.smoothedVelocity >= cfg.vel;
            const liftTriggered = liftRatio >= cfg.lift && dy > 0.004;

            if (
              (velocityTriggered || liftTriggered) &&
              !v.wasJumpingUp &&
              now - v.lastJumpAt > 260
            ) {
              v.lastJumpAt = now;
              v.wasJumpingUp = true;
              triggerJumpPress();
              setTimeout(() => triggerJumpRelease(), 140);
              setJumpFlash(true);
              setTimeout(() => setJumpFlash(false), 240);
            } else if (v.smoothedVelocity < cfg.vel * 0.35 && liftRatio < cfg.lift * 0.5) {
              v.wasJumpingUp = false;
            }
          }

          if (outCanvas) {
            const octx = outCanvas.getContext('2d');
            if (octx) {
              octx.clearRect(0, 0, outCanvas.width, outCanvas.height);

              // Tracking line
              octx.beginPath();
              octx.moveTo(leftPt.x * outCanvas.width, leftPt.y * outCanvas.height);
              octx.lineTo(rightPt.x * outCanvas.width, rightPt.y * outCanvas.height);
              octx.strokeStyle = v.smoothedVelocity >= cfg.vel ? '#16A34A' : '#DC2626';
              octx.lineWidth = 3;
              octx.stroke();

              for (const pt of [leftPt, rightPt]) {
                octx.beginPath();
                octx.arc(pt.x * outCanvas.width, pt.y * outCanvas.height, 5, 0, Math.PI * 2);
                octx.fillStyle = '#FFFFFF';
                octx.fill();
                octx.lineWidth = 2;
                octx.strokeStyle = '#DC2626';
                octx.stroke();
              }

              // Vertical velocity meter
              const barX = 14;
              const barY = 18;
              const barW = 12;
              const barH = 88;
              const maxVal = cfg.vel * 1.6;

              octx.fillStyle = 'rgba(15, 23, 42, 0.55)';
              octx.fillRect(barX, barY, barW, barH);

              const fillRatio = Math.min(Math.max(v.smoothedVelocity / maxVal, 0), 1);
              const fillH = fillRatio * barH;
              octx.fillStyle = v.smoothedVelocity >= cfg.vel ? '#22C55E' : '#FACC15';
              octx.fillRect(barX, barY + barH - fillH, barW, fillH);

              const threshY = barY + barH - (cfg.vel / maxVal) * barH;
              octx.fillStyle = '#EF4444';
              octx.fillRect(barX - 3, threshY - 1, barW + 6, 2);
            }
          }
        } else if (outCanvas) {
          const octx = outCanvas.getContext('2d');
          octx?.clearRect(0, 0, outCanvas.width, outCanvas.height);
        }
      }
    }

    v.rafId = requestAnimationFrame(runVisionLoop);
  }, [triggerJumpPress, triggerJumpRelease]);

  const enableCamera = useCallback(async () => {
    SoundFX.ensureCtx();
    setCameraError('');
    setCameraStatus('loading');

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Browser ini tidak mendukung akses kamera.');
      }

      if (!visionRef.current.poseLandmarker) {
        const visionPkgUrl =
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/+esm';
        const { PoseLandmarker, FilesetResolver } = await import(
          /* @vite-ignore */ visionPkgUrl
        );
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm'
        );
        const modelPath =
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
        try {
          visionRef.current.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: modelPath,
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numPoses: 1,
          });
        } catch {
          visionRef.current.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: modelPath,
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            numPoses: 1,
          });
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
      });

      visionRef.current.stream = stream;
      visionRef.current.active = true;
      setCameraStatus('active');
      setShowCameraFeed(true);
    } catch (err) {
      stopCamera();
      setCameraStatus('error');
      const msg =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Izinkan akses kamera di browser untuk lompat pakai kamera.'
          : 'Gagal menyalakan kamera atau model deteksi lompat.';
      setCameraError(msg);
    }
  }, [stopCamera]);

  // Attach MediaStream reliably after React mounts the <video> element
  useEffect(() => {
    if (cameraStatus !== 'active') return;
    const video = videoRef.current;
    const stream = visionRef.current.stream;
    if (!video || !stream) return;

    let cancelled = false;
    const startLoop = () => {
      if (cancelled || !visionRef.current.active) return;
      if (!visionRef.current.rafId) {
        visionRef.current.rafId = requestAnimationFrame(runVisionLoop);
      }
    };

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    video.onloadeddata = () => {
      video.play().catch(() => {});
      startLoop();
    };
    video.onplaying = () => {
      startLoop();
    };

    video.play().then(startLoop).catch(() => {});
    if (video.readyState >= 2) {
      startLoop();
    }

    return () => {
      cancelled = true;
    };
  }, [cameraStatus, runVisionLoop]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  // Keyboard bindings
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        if (document.activeElement instanceof HTMLButtonElement && e.code === 'Space') {
          // Let focused button clicks remain consistent unless game is running
          if (phaseRef.current === 'PLAYING') {
            e.preventDefault();
          } else {
            return;
          }
        } else {
          e.preventDefault();
        }
        if (!e.repeat) {
          triggerJumpPress();
        }
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        e.preventDefault();
        triggerFastDrop(true);
      } else if (e.code === 'Enter' && phaseRef.current !== 'PLAYING') {
        if (!(document.activeElement instanceof HTMLButtonElement)) {
          e.preventDefault();
          triggerJumpPress();
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        triggerJumpRelease();
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        triggerFastDrop(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [triggerFastDrop, triggerJumpPress, triggerJumpRelease]);

  // Main render & game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let lastTimestamp = 0;

    const resizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = LOGICAL_WIDTH * dpr;
      canvas.height = LOGICAL_HEIGHT * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const spawnMoneyObstacle = () => {
      const w = worldRef.current;
      const slot = w.obstacles.find((o) => !o.active);
      if (!slot) return;

      const roll = Math.random();
      const scoreNow = w.lastDisplayedScore;

      let variant: MoneyVariant = 'single';
      if (scoreNow > 180 && roll > 0.66) {
        variant = 'tall';
      } else if (scoreNow > 80 && roll > 0.36) {
        variant = 'wide';
      }

      const tone: CurrencyTone = Math.random() > 0.45 ? 'red' : 'green';

      let width = 44;
      let height = 38;
      if (variant === 'tall') {
        width = 48;
        height = 64;
      } else if (variant === 'wide') {
        width = 80;
        height = 42;
      }

      slot.active = true;
      slot.variant = variant;
      slot.tone = tone;
      slot.width = width;
      slot.height = height;
      slot.x = LOGICAL_WIDTH + 30;
      slot.y = GROUND_Y - height;
      slot.bobPhase = Math.random() * Math.PI * 2;
    };

    const handleCollision = () => {
      const w = worldRef.current;
      phaseRef.current = 'GAME_OVER';
      setPhase('GAME_OVER');
      w.shakeTimer = 0.22;
      canRestartAtRef.current = performance.now() + 360;

      spawnCrashBills(w.player.x + w.player.width * 0.6, w.player.y + w.player.height * 0.4);
      SoundFX.playGameOver(mutedRef.current);

      const finalScore = Math.floor(w.scoreFloat);
      setScore(finalScore);
      if (finalScore > bestScoreRef.current) {
        bestScoreRef.current = finalScore;
        setBestScore(finalScore);
        setIsNewBest(true);
        try {
          localStorage.setItem(HIGH_SCORE_STORAGE_KEY, String(finalScore));
        } catch {
          // Ignore storage error
        }
      }
    };

    const drawBackground = (skyCycle: number) => {
      // Smoothly transition between Morning (0), Sunset (1), Night (2)
      const phaseIdx = skyCycle % 3;
      const stage = Math.floor(phaseIdx);
      const frac = phaseIdx - stage;

      const palettes = [
        { top: '#EFF6FF', bottom: '#FFFFFF', skyline: '#DCE5F2', ground: '#F1F5F9', line: '#94A3B8', cloud: '#FFFFFF' },
        { top: '#FEF3C7', bottom: '#FFF7ED', skyline: '#F3D2B3', ground: '#FEF9EE', line: '#B45309', cloud: '#FFFBEB' },
        { top: '#0F172A', bottom: '#1E293B', skyline: '#334155', ground: '#1E293B', line: '#64748B', cloud: '#475569' },
      ];
      const cur = palettes[stage];
      const nxt = palettes[(stage + 1) % 3];

      const topColor = lerpColor(cur.top, nxt.top, frac);
      const bottomColor = lerpColor(cur.bottom, nxt.bottom, frac);
      const skylineColor = lerpColor(cur.skyline, nxt.skyline, frac);
      const groundColor = lerpColor(cur.ground, nxt.ground, frac);
      const lineColor = lerpColor(cur.line, nxt.line, frac);
      const cloudColor = lerpColor(cur.cloud, nxt.cloud, frac);

      const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
      grad.addColorStop(0, topColor);
      grad.addColorStop(1, bottomColor);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, LOGICAL_WIDTH, GROUND_Y);

      // Stars & crescent moon at night
      const nightAmount =
        stage === 2 ? 1 - frac : stage === 1 ? frac : 0;
      if (nightAmount > 0.08) {
        ctx.save();
        ctx.globalAlpha = nightAmount * 0.85;
        ctx.fillStyle = '#F8FAFC';
        const stars = [
          [90, 42], [180, 74], [275, 32], [380, 62],
          [490, 38], [600, 76], [710, 44], [835, 58],
        ];
        for (const [sx, sy] of stars) {
          ctx.fillRect(sx, sy, 2.5, 2.5);
        }
        // Crescent moon
        ctx.fillStyle = '#FEF08A';
        ctx.beginPath();
        ctx.arc(810, 56, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = topColor;
        ctx.beginPath();
        ctx.arc(817, 52, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Clouds
      ctx.fillStyle = cloudColor;
      for (const c of worldRef.current.clouds) {
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.scale(c.scale, c.scale);
        ctx.globalAlpha = 0.9;
        drawRoundedRect(ctx, -28, -10, 56, 20, 10);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(-10, -10, 12, 0, Math.PI * 2);
        ctx.arc(8, -13, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Distant Jakarta / Nusantara skyline silhouette with Monas
      const offset = worldRef.current.skylineOffset % 450;
      ctx.fillStyle = skylineColor;
      for (let tile = -1; tile < 3; tile++) {
        const bx = tile * 450 - offset;
        // Buildings
        ctx.fillRect(bx + 20, GROUND_Y - 52, 34, 52);
        ctx.fillRect(bx + 62, GROUND_Y - 78, 28, 78);
        ctx.fillRect(bx + 98, GROUND_Y - 40, 40, 40);
        // Monas-inspired monument
        ctx.fillRect(bx + 178, GROUND_Y - 18, 34, 18);
        ctx.fillRect(bx + 189, GROUND_Y - 94, 12, 76);
        ctx.fillRect(bx + 185, GROUND_Y - 98, 20, 5);
        ctx.fillStyle = nightAmount > 0.4 ? '#FBBF24' : skylineColor;
        ctx.beginPath();
        ctx.moveTo(bx + 195, GROUND_Y - 110);
        ctx.lineTo(bx + 191, GROUND_Y - 98);
        ctx.lineTo(bx + 199, GROUND_Y - 98);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = skylineColor;
        // More skyline blocks
        ctx.fillRect(bx + 245, GROUND_Y - 64, 38, 64);
        ctx.fillRect(bx + 292, GROUND_Y - 46, 32, 46);
        ctx.fillRect(bx + 334, GROUND_Y - 86, 30, 86);
        ctx.fillRect(bx + 374, GROUND_Y - 54, 48, 54);
      }

      // Ground area
      ctx.fillStyle = groundColor;
      ctx.fillRect(0, GROUND_Y, LOGICAL_WIDTH, LOGICAL_HEIGHT - GROUND_Y);

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      ctx.lineTo(LOGICAL_WIDTH, GROUND_Y);
      ctx.stroke();

      // Ground pebbles
      ctx.fillStyle = lineColor;
      ctx.globalAlpha = 0.45;
      for (const pebble of worldRef.current.pebbles) {
        ctx.fillRect(Math.floor(pebble.x), GROUND_Y + pebble.yOffset, pebble.w, pebble.h);
      }
      ctx.globalAlpha = 1;
    };

    const drawMoneyBundle = (
      x: number,
      y: number,
      w: number,
      h: number,
      tone: CurrencyTone,
      tilt = 0
    ) => {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(tilt);
      const bx = -w / 2;
      const by = -h / 2;

      const bodyFill = tone === 'red' ? '#EF4444' : '#16A34A';
      const topFill = tone === 'red' ? '#FCA5A5' : '#86EFAC';
      const borderCol = tone === 'red' ? '#991B1B' : '#14532D';
      const paperEdge = tone === 'red' ? '#FEE2E2' : '#DCFCE7';

      // Stack body
      ctx.fillStyle = bodyFill;
      drawRoundedRect(ctx, bx, by + 6, w, h - 6, 4);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = borderCol;
      ctx.stroke();

      // Stacked bill layer stripes on the front edge
      ctx.fillStyle = paperEdge;
      for (let sy = by + 11; sy < by + h - 4; sy += 4.5) {
        ctx.fillRect(bx + 3, sy, w - 6, 1.5);
      }

      // Top banknote face
      ctx.fillStyle = topFill;
      drawRoundedRect(ctx, bx, by, w, 12, 3);
      ctx.fill();
      ctx.strokeStyle = borderCol;
      ctx.lineWidth = 1.75;
      ctx.stroke();

      // Inner banknote decorative frame
      ctx.strokeStyle = borderCol;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 4, by + 2.5, w - 8, 7);

      // Currency strap (gold/kraft paper band around the stack)
      const strapW = Math.max(10, Math.floor(w * 0.28));
      const strapX = -strapW / 2;
      ctx.fillStyle = '#FDE68A';
      ctx.fillRect(strapX, by, strapW, h);
      ctx.strokeStyle = '#B45309';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(strapX, by, strapW, h);

      // Small "Rp" mark on the front strap
      ctx.fillStyle = '#92400E';
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Rp', 0, by + h * 0.56);

      ctx.restore();
    };

    const drawMoneyObstacle = (obs: MoneyStack) => {
      // Ground shadow under stack
      ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
      ctx.beginPath();
      ctx.ellipse(obs.x + obs.width / 2, GROUND_Y + 2, obs.width * 0.48, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      const altTone: CurrencyTone = obs.tone === 'red' ? 'green' : 'red';

      if (obs.variant === 'single') {
        drawMoneyBundle(obs.x, obs.y + 14, obs.width, 24, obs.tone);
        drawMoneyBundle(obs.x + 2, obs.y, obs.width - 4, 20, altTone, -0.04);
      } else if (obs.variant === 'tall') {
        // 3-tier tower of money stacks
        drawMoneyBundle(obs.x, obs.y + 40, obs.width, 24, obs.tone);
        drawMoneyBundle(obs.x + 2, obs.y + 20, obs.width - 4, 24, altTone, 0.03);
        drawMoneyBundle(obs.x + 4, obs.y, obs.width - 8, 24, obs.tone, -0.05);
      } else {
        // Wide double-pile with top bundle
        const halfW = 38;
        drawMoneyBundle(obs.x, obs.y + 18, halfW, 24, obs.tone);
        drawMoneyBundle(obs.x + obs.width - halfW, obs.y + 18, halfW, 24, altTone);
        drawMoneyBundle(obs.x + 16, obs.y, 46, 22, obs.tone, 0.04);
      }
    };

    const drawPrabowo = (p: PlayerState, isDead: boolean) => {
      const groundDist = Math.max(0, GROUND_Y - (p.y + p.height));
      const shadowScale = Math.max(0.35, 1 - groundDist / 160);

      // Ground shadow
      ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
      ctx.beginPath();
      ctx.ellipse(
        p.x + p.width / 2,
        GROUND_Y + 2,
        20 * shadowScale,
        4.5 * shadowScale,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();

      const stride = p.grounded && phaseRef.current === 'PLAYING' ? Math.sin(p.runPhase) : 0;
      const bounce =
        phaseRef.current === 'TITLE'
          ? Math.sin(worldRef.current.idleTime * 3.2) * 1.6
          : p.grounded && phaseRef.current === 'PLAYING'
            ? Math.abs(Math.cos(p.runPhase)) * -2.8
            : 0;

      const squashY = p.ducking && !p.grounded ? 0.92 : 1;
      const leanAngle = isDead ? -0.14 : !p.grounded ? (p.vy < 0 ? -0.06 : 0.08) : 0.05;

      ctx.save();
      ctx.translate(p.x + p.width / 2, p.y + p.height);
      ctx.scale(1, squashY);
      ctx.rotate(leanAngle);
      ctx.translate(0, -p.height + bounce);

      const cx = 0;

      // --- Back Leg ---
      ctx.save();
      ctx.translate(cx - 4, 42);
      const backLegAngle = !p.grounded ? 0.38 : -stride * 0.65;
      ctx.rotate(backLegAngle);
      ctx.fillStyle = '#334155';
      drawRoundedRect(ctx, -4, 0, 8, 15, 3);
      ctx.fill();
      // Shoe
      ctx.fillStyle = '#0F172A';
      drawRoundedRect(ctx, -4, 12, 12, 6, 2.5);
      ctx.fill();
      ctx.restore();

      // --- Back Arm ---
      ctx.save();
      ctx.translate(cx + 8, 25);
      const backArmAngle = !p.grounded ? -0.9 : stride * 0.7;
      ctx.rotate(backArmAngle);
      // White sleeve
      ctx.fillStyle = '#E2E8F0';
      drawRoundedRect(ctx, -3, 0, 7, 11, 3);
      ctx.fill();
      // Forearm/hand
      ctx.fillStyle = '#F1C29B';
      drawRoundedRect(ctx, -2.5, 9, 6, 7, 3);
      ctx.fill();
      ctx.restore();

      // --- Front Leg ---
      ctx.save();
      ctx.translate(cx + 4, 42);
      const frontLegAngle = !p.grounded ? -0.35 : stride * 0.65;
      ctx.rotate(frontLegAngle);
      ctx.fillStyle = '#1E293B';
      drawRoundedRect(ctx, -4.5, 0, 9, 15, 3);
      ctx.fill();
      // Shoe
      ctx.fillStyle = '#0F172A';
      drawRoundedRect(ctx, -4.5, 12, 13, 6, 2.5);
      ctx.fill();
      ctx.restore();

      // --- Torso: White Safari Shirt (Kemeja Putih) ---
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.75;
      drawRoundedRect(ctx, cx - 13, 21, 26, 23, 5);
      ctx.fill();
      ctx.stroke();

      // Shirt collar
      ctx.fillStyle = '#F1F5F9';
      ctx.beginPath();
      ctx.moveTo(cx - 5, 21);
      ctx.lineTo(cx, 27);
      ctx.lineTo(cx + 6, 21);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Center placket + buttons
      ctx.fillStyle = '#64748B';
      ctx.fillRect(cx + 1, 27, 1.5, 16);
      ctx.fillRect(cx + 0.5, 30, 2.5, 2.5);
      ctx.fillRect(cx + 0.5, 36, 2.5, 2.5);

      // Safari chest pockets (left & right)
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(cx - 10, 29, 7, 7);
      ctx.strokeRect(cx + 5, 29, 7, 7);

      // Merah-Putih chest pin
      ctx.fillStyle = '#DC2626';
      ctx.fillRect(cx - 9, 25.5, 5, 1.8);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(cx - 9, 27.3, 5, 1.5);
      ctx.strokeStyle = '#991B1B';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(cx - 9, 25.5, 5, 3.3);

      // --- Head ---
      ctx.fillStyle = '#F1C29B';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.75;
      drawRoundedRect(ctx, cx - 11, 5, 23, 18, 7);
      ctx.fill();
      ctx.stroke();

      // Ear
      ctx.fillStyle = '#E0A97E';
      ctx.beginPath();
      ctx.arc(cx - 10.5, 14, 2.8, 0, Math.PI * 2);
      ctx.fill();

      // Hair at temple
      ctx.fillStyle = '#3F3F46';
      ctx.fillRect(cx - 10, 8, 5, 5);

      // Cheek warmth
      ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
      ctx.beginPath();
      ctx.arc(cx + 6, 16.5, 2.4, 0, Math.PI * 2);
      ctx.fill();

      // Eyes & Expression
      if (isDead) {
        // Shocked X / O expression
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx + 1, 11);
        ctx.lineTo(cx + 5, 15);
        ctx.moveTo(cx + 5, 11);
        ctx.lineTo(cx + 1, 15);
        ctx.moveTo(cx + 7, 11);
        ctx.lineTo(cx + 11, 15);
        ctx.moveTo(cx + 11, 11);
        ctx.lineTo(cx + 7, 15);
        ctx.stroke();

        // Surprised mouth
        ctx.fillStyle = '#9A3412';
        ctx.beginPath();
        ctx.arc(cx + 5, 19, 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Eyebrows
        ctx.fillStyle = '#27272A';
        ctx.fillRect(cx + 1, 10, 4, 1.5);
        ctx.fillRect(cx + 7, 10, 4, 1.5);

        // Eyes (blink support)
        if (p.isBlinking) {
          ctx.fillRect(cx + 1.5, 13.5, 3.5, 1.4);
          ctx.fillRect(cx + 7.5, 13.5, 3.5, 1.4);
        } else {
          ctx.fillStyle = '#0F172A';
          ctx.beginPath();
          ctx.arc(cx + 3.2, 13.5, 1.7, 0, Math.PI * 2);
          ctx.arc(cx + 9, 13.5, 1.7, 0, Math.PI * 2);
          ctx.fill();
        }

        // Friendly confident smile
        ctx.strokeStyle = '#7C2D12';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx + 5.5, 17, 3.2, 0.15, Math.PI - 0.15);
        ctx.stroke();
      }

      // --- Black Indonesian Peci ---
      ctx.save();
      if (isDead) {
        ctx.translate(-2, -5);
        ctx.rotate(-0.18);
      }
      ctx.fillStyle = '#18181B';
      ctx.strokeStyle = '#09090B';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 11.5, 8);
      ctx.lineTo(cx - 9.5, -2);
      ctx.quadraticCurveTo(cx + 0.5, -3.5, cx + 11, -1.5);
      ctx.lineTo(cx + 12.5, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Subtle peci highlight
      ctx.fillStyle = '#3F3F46';
      ctx.fillRect(cx - 7, 1, 15, 1.5);
      ctx.restore();

      // --- Front Arm ---
      ctx.save();
      ctx.translate(cx - 6, 25);
      const frontArmAngle = !p.grounded ? -1.15 : -stride * 0.72;
      ctx.rotate(frontArmAngle);
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.5;
      drawRoundedRect(ctx, -3.5, 0, 7.5, 11.5, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#F1C29B';
      drawRoundedRect(ctx, -3, 10, 6.5, 7, 3);
      ctx.fill();
      ctx.restore();

      ctx.restore();
    };

    const drawParticles = () => {
      for (const p of worldRef.current.particles) {
        if (!p.active) continue;
        const alpha = Math.max(0, p.life / p.maxLife);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        if (p.kind === 'bill') {
          ctx.fillRect(-p.size / 2, -p.size * 0.28, p.size, p.size * 0.56);
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 0.8;
          ctx.strokeRect(-p.size / 2 + 1.5, -p.size * 0.28 + 1, p.size - 3, p.size * 0.56 - 2);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    };

    const drawNotices = () => {
      for (const n of worldRef.current.notices) {
        const alpha = Math.max(0, n.life / n.maxLife);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#D97706';
        ctx.font = 'bold 16px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(n.text, n.x, n.y);
        ctx.restore();
      }
    };

    const tick = (timestamp: number) => {
      if (!lastTimestamp) lastTimestamp = timestamp;
      const dt = Math.min((timestamp - lastTimestamp) / 1000, 0.05);
      lastTimestamp = timestamp;

      const w = worldRef.current;
      const p = w.player;
      const currentPhase = phaseRef.current;

      // Blink animation in all states
      p.blinkTimer -= dt;
      if (p.blinkTimer <= 0) {
        p.isBlinking = !p.isBlinking;
        p.blinkTimer = p.isBlinking ? 0.11 : 2.2 + Math.random() * 2.5;
      }

      if (currentPhase === 'TITLE') {
        w.idleTime += dt;
        for (const c of w.clouds) {
          c.x -= c.speed * 0.5 * dt;
          if (c.x < -60) c.x = LOGICAL_WIDTH + 60;
        }
      } else if (currentPhase === 'PLAYING') {
        // Speed ramp
        if (w.speed < MAX_SPEED) {
          w.speed = Math.min(MAX_SPEED, w.speed + SPEED_RAMP_PER_SEC * dt);
        }

        // Scroll background & pebbles
        w.skylineOffset += w.speed * 0.16 * dt;
        for (const c of w.clouds) {
          c.x -= (c.speed + w.speed * 0.05) * dt;
          if (c.x < -60) {
            c.x = LOGICAL_WIDTH + 60;
            c.y = 36 + Math.random() * 68;
          }
        }
        for (const pebble of w.pebbles) {
          pebble.x -= w.speed * dt;
          if (pebble.x < -20) {
            pebble.x = LOGICAL_WIDTH + Math.random() * 28;
            pebble.yOffset = 8 + Math.random() * 44;
          }
        }

        // Player jump physics (variable height + jump buffer + fast-fall)
        if (p.jumpBufferTimer > 0) {
          p.jumpBufferTimer -= dt;
        }
        if (!p.grounded) {
          if (p.holdingJump && p.vy < 0 && p.jumpHoldTimer < 0.16) {
            p.jumpHoldTimer += dt;
            p.vy += GRAVITY * 0.45 * dt;
          } else {
            const gravMult = p.fastFalling ? 2.2 : 1;
            p.vy += GRAVITY * gravMult * dt;
          }
          p.y += p.vy * dt;

          if (p.y >= GROUND_Y - p.height) {
            p.y = GROUND_Y - p.height;
            p.vy = 0;
            p.grounded = true;
            p.fastFalling = false;
            spawnDust(p.x + p.width * 0.45, GROUND_Y, 5);

            // Execute buffered jump immediately on touchdown
            if (p.jumpBufferTimer > 0) {
              p.vy = JUMP_VELOCITY;
              p.grounded = false;
              p.jumpBufferTimer = 0;
              p.jumpHoldTimer = 0;
              SoundFX.playJump(mutedRef.current);
            }
          }
        } else {
          const prevSin = Math.sin(p.runPhase);
          p.runPhase += dt * (11 + (w.speed - INITIAL_SPEED) * 0.012);
          if (prevSin <= 0 && Math.sin(p.runPhase) > 0) {
            spawnDust(p.x + p.width * 0.3, GROUND_Y, 1);
          }
        }

        // Spawn money obstacles
        w.spawnTimer -= dt;
        if (w.spawnTimer <= 0) {
          spawnMoneyObstacle();
          const speedFactor = INITIAL_SPEED / w.speed;
          w.spawnTimer = (0.88 + Math.random() * 0.72) * Math.max(0.56, speedFactor);
        }

        // Update obstacles & collision check
        const playerBox = {
          left: p.x + 11,
          right: p.x + p.width - 11,
          top: p.y + 8,
          bottom: p.y + p.height - 6,
        };

        for (const obs of w.obstacles) {
          if (!obs.active) continue;
          obs.x -= w.speed * dt;
          if (obs.x + obs.width < -20) {
            obs.active = false;
            continue;
          }

          const obsBox = {
            left: obs.x + 6,
            right: obs.x + obs.width - 6,
            top: obs.y + 5,
            bottom: obs.y + obs.height,
          };

          if (
            playerBox.left < obsBox.right &&
            playerBox.right > obsBox.left &&
            playerBox.top < obsBox.bottom &&
            playerBox.bottom > obsBox.top
          ) {
            handleCollision();
            break;
          }
        }

        // Score & milestones
        if (phaseRef.current === 'PLAYING') {
          w.scoreFloat += dt * 16;
          const nextScore = Math.floor(w.scoreFloat);
          if (nextScore !== w.lastDisplayedScore) {
            w.lastDisplayedScore = nextScore;
            setScore(nextScore);

            const milestone = Math.floor(nextScore / 100);
            if (milestone > w.lastMilestone && nextScore > 0) {
              w.lastMilestone = milestone;
              SoundFX.playMilestone(mutedRef.current);
              w.notices.push({
                text: `+${milestone * 100}`,
                x: p.x + p.width / 2,
                y: p.y - 12,
                life: 0.9,
                maxLife: 0.9,
              });
            }
          }
        }
      }

      // Update particles & floating notices even after game over
      for (const pt of w.particles) {
        if (!pt.active) continue;
        pt.life -= dt;
        if (pt.life <= 0) {
          pt.active = false;
          continue;
        }
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        if (pt.kind === 'bill') {
          pt.vy += 420 * dt;
        }
        pt.rotation += pt.vRot * dt;
      }

      for (let i = w.notices.length - 1; i >= 0; i--) {
        const n = w.notices[i];
        n.life -= dt;
        n.y -= 36 * dt;
        if (n.life <= 0) w.notices.splice(i, 1);
      }

      // Screen shake on hit
      ctx.save();
      if (w.shakeTimer > 0) {
        w.shakeTimer = Math.max(0, w.shakeTimer - dt);
        const mag = (w.shakeTimer / 0.22) * 6;
        ctx.translate((Math.random() - 0.5) * mag * 2, (Math.random() - 0.5) * mag * 2);
      }

      const skyCycle = (w.scoreFloat / 380);
      drawBackground(skyCycle);

      for (const obs of w.obstacles) {
        if (obs.active) drawMoneyObstacle(obs);
      }

      drawPrabowo(p, phaseRef.current === 'GAME_OVER');
      drawParticles();
      drawNotices();
      ctx.restore();

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [spawnCrashBills, spawnDust]);

  const formattedScore = String(score).padStart(5, '0');
  const formattedBest = String(bestScore).padStart(5, '0');

  return (
    <div className="w-full max-w-4xl mx-auto space-y-4">
      {/* Game Frame */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        {/* Tidy Top HUD Bar */}
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-slate-200 bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-slate-900 whitespace-nowrap">
              Wowo Jump
            </h1>
          </div>

          <div className="flex items-center gap-4 sm:gap-5 shrink-0">
            <div className="flex items-center gap-3 sm:gap-4 font-mono text-sm tabular-nums">
              <div className="flex items-center gap-1.5 text-slate-500">
                <span className="text-xs font-medium">BEST</span>
                <span className="font-bold text-slate-700">{formattedBest}</span>
              </div>
              <span className="text-slate-300" aria-hidden="true">
                /
              </span>
              <div className="flex items-center gap-1.5 text-slate-900">
                <span className="text-xs font-medium text-slate-500">SCORE</span>
                <span className="font-bold">{formattedScore}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsMuted((prev) => !prev)}
              aria-label={isMuted ? 'Nyalakan suara' : 'Bisukan suara'}
              title={isMuted ? 'Nyalakan suara' : 'Bisukan suara'}
              className="inline-flex items-center justify-center w-10 h-10 rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 shrink-0"
            >
              {isMuted ? (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Canvas Viewport */}
        <div
          className="relative w-full aspect-[5/2] bg-slate-50 cursor-pointer select-none"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            triggerJumpPress();
          }}
          onPointerUp={() => triggerJumpRelease()}
          onPointerCancel={() => triggerJumpRelease()}
        >
          <canvas
            ref={canvasRef}
            className="w-full h-full block"
          />

          {/* Title Overlay */}
          {phase === 'TITLE' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/75 backdrop-blur-[2px] p-4 text-center">
              <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-slate-900 mb-1.5 text-balance">
                Lompati Tumpukan Uang
              </h2>
              <p className="text-sm text-slate-600 mb-5 max-w-md">
                {cameraStatus === 'active'
                  ? 'Lompat di depan kamera, tekan Space, atau ketuk layar untuk mulai.'
                  : 'Tekan Space, panah atas, ketuk layar, atau aktifkan kamera untuk melompat.'}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={startNewGame}
                  className="px-6 py-3 rounded-xl bg-red-600 text-white font-semibold text-sm sm:text-base hover:bg-red-700 active:scale-[0.98] transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 whitespace-nowrap shrink-0"
                >
                  Start Game
                </button>
                {cameraStatus !== 'active' && (
                  <button
                    type="button"
                    onClick={enableCamera}
                    disabled={cameraStatus === 'loading'}
                    className="px-5 py-3 rounded-xl bg-white border border-slate-300 text-slate-800 font-semibold text-sm sm:text-base hover:bg-slate-50 disabled:opacity-60 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 whitespace-nowrap shrink-0"
                  >
                    {cameraStatus === 'loading' ? 'Memuat Kamera...' : 'Pakai Kamera'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Game Over Overlay */}
          {phase === 'GAME_OVER' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/55 backdrop-blur-[2px] p-4 text-center">
              <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 shadow-lg max-w-xs w-full">
                <p className="text-xs font-semibold text-red-600 mb-1">
                  {isNewBest ? 'Rekor Baru Tercapai' : 'Game Over'}
                </p>
                <div className="font-mono text-3xl font-bold text-slate-900 tabular-nums mb-1">
                  {score}
                </div>
                <p className="text-xs text-slate-500 font-mono tabular-nums mb-4">
                  Best: {bestScore}
                </p>
                <button
                  type="button"
                  onClick={startNewGame}
                  className="w-full px-5 py-2.5 rounded-lg bg-red-600 text-white font-semibold text-sm hover:bg-red-700 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 whitespace-nowrap"
                >
                  Play Again
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Simple Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 bg-slate-50 border-t border-slate-200 text-xs text-slate-600">
          <div className="flex flex-wrap items-center gap-3">
            <span>Space / ↑ / Ketuk: Lompat</span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span>↓ / S: Turun Cepat</span>
          </div>

          <div className="flex items-center gap-2.5">
            {cameraStatus === 'active' ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowCameraFeed((prev) => !prev)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium text-xs hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
                >
                  {showCameraFeed ? 'Sembunyikan Kamera' : 'Tampilkan Kamera'}
                </button>
                <button
                  type="button"
                  onClick={stopCamera}
                  className="px-3.5 py-2 rounded-lg border border-red-200 bg-white text-red-700 font-medium text-xs hover:bg-red-50 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
                >
                  Matikan Kamera
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={enableCamera}
                disabled={cameraStatus === 'loading'}
                className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 font-semibold text-xs hover:bg-slate-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
              >
                {cameraStatus === 'loading' ? 'Memuat Kamera...' : 'Aktifkan Kamera'}
              </button>
            )}

            <button
              type="button"
              onPointerDown={(e) => {
                e.stopPropagation();
                triggerJumpPress();
              }}
              onPointerUp={() => triggerJumpRelease()}
              onPointerLeave={() => triggerJumpRelease()}
              className="sm:hidden px-5 py-2 rounded-lg bg-slate-900 text-white font-semibold text-xs active:scale-95 transition-transform whitespace-nowrap shrink-0"
            >
              Lompat
            </button>
          </div>
        </div>
      </div>

      {/* Inline Camera Error Message */}
      {cameraStatus === 'error' && cameraError && (
        <div className="bg-white border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{cameraError}</span>
          <button
            type="button"
            onClick={() => {
              setCameraStatus('off');
              setCameraError('');
            }}
            className="text-xs font-semibold text-red-700 hover:underline whitespace-nowrap shrink-0"
          >
            Tutup
          </button>
        </div>
      )}

      {/* Camera Jump Tracker Panel (remains mounted while active so tracking works even if preview is collapsed) */}
      {cameraStatus === 'active' && (
        <div
          className={
            showCameraFeed
              ? 'bg-white border border-slate-200 rounded-2xl p-4 shadow-sm'
              : 'fixed -left-[9999px] top-0 w-[320px] h-[240px] opacity-0 pointer-events-none overflow-hidden'
          }
        >
          <div className="flex flex-col sm:flex-row items-center gap-5">
            <div className="relative w-full max-w-[280px] aspect-[4/3] rounded-xl overflow-hidden bg-slate-900 border border-slate-200 shrink-0">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
              <canvas
                ref={visionCanvasRef}
                className="absolute inset-0 w-full h-full scale-x-[-1] pointer-events-none"
              />
              {jumpFlash && (
                <div className="absolute top-2.5 right-2.5 bg-emerald-600 text-white text-xs font-semibold px-2.5 py-1 rounded-md shadow-sm">
                  Lompat!
                </div>
              )}
            </div>

            <div className="flex-1 w-full space-y-3 text-left">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">
                  {poseDetected ? 'Tubuh Terdeteksi — Siap Lompat' : 'Mencari Posisi Tubuh...'}
                </h3>
                <p className="text-sm text-slate-600 mt-0.5">
                  {poseDetected
                    ? 'Lompat di depan kamera untuk membuat Prabowo melompat.'
                    : 'Pastikan wajah atau bahu terlihat di kamera, lalu coba melompat.'}
                </p>
              </div>

              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-slate-500">
                  Sensitivitas Lompatan
                </span>
                <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {(
                    [
                      { id: 'easy', label: 'Sensitif' },
                      { id: 'normal', label: 'Normal' },
                      { id: 'hard', label: 'Tinggi' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setSensitivity(opt.id)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        sensitivity === opt.id
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WowoGame;
