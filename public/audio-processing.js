(function (root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    gain: 2,
    highPassHz: 90,
    compressorThresholdDb: -18,
    compressorRatio: 4,
    limiterThresholdDb: -1.5,
    limiterRatio: 20,
    sampleRate: 48000
  });

  async function createProcessedMicrophone(options = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("این مرورگر امکان دسترسی امن به میکروفون را ندارد.");
    }

    const settings = { ...DEFAULTS, ...options };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: settings.sampleRate },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true }
      },
      video: false
    });

    let context;
    try {
      const AudioContextClass = root.AudioContext || root.webkitAudioContext;
      if (!AudioContextClass) throw new Error("پردازش صوت در این مرورگر پشتیبانی نمی‌شود.");
      context = new AudioContextClass({ latencyHint: "interactive" });
      await context.resume();

      const source = context.createMediaStreamSource(stream);
      const highPass = context.createBiquadFilter();
      highPass.type = "highpass";
      highPass.frequency.value = settings.highPassHz;
      highPass.Q.value = 0.707;

      const voiceCompressor = context.createDynamicsCompressor();
      voiceCompressor.threshold.value = settings.compressorThresholdDb;
      voiceCompressor.knee.value = 12;
      voiceCompressor.ratio.value = settings.compressorRatio;
      voiceCompressor.attack.value = 0.004;
      voiceCompressor.release.value = 0.18;

      const gain = context.createGain();
      gain.gain.value = settings.gain;

      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = settings.limiterThresholdDb;
      limiter.knee.value = 0;
      limiter.ratio.value = settings.limiterRatio;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.08;

      const destination = context.createMediaStreamDestination();
      source.connect(highPass);
      highPass.connect(voiceCompressor);
      voiceCompressor.connect(gain);
      gain.connect(limiter);
      limiter.connect(destination);

      const processedTrack = destination.stream.getAudioTracks()[0];
      if (!processedTrack) throw new Error("ساخت مسیر صوت پردازش‌شده ناموفق بود.");

      let closed = false;
      return {
        track: processedTrack,
        stream: destination.stream,
        sourceStream: stream,
        settings: { ...settings },
        async close() {
          if (closed) return;
          closed = true;
          processedTrack.stop();
          destination.stream.getTracks().forEach(track => track.stop());
          stream.getTracks().forEach(track => track.stop());
          try { source.disconnect(); } catch {}
          try { highPass.disconnect(); } catch {}
          try { voiceCompressor.disconnect(); } catch {}
          try { gain.disconnect(); } catch {}
          try { limiter.disconnect(); } catch {}
          try { await context.close(); } catch {}
        }
      };
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      if (context && context.state !== "closed") {
        try { await context.close(); } catch {}
      }
      throw error;
    }
  }

  root.HamyarAudio = Object.freeze({
    defaults: DEFAULTS,
    createProcessedMicrophone
  });
})(globalThis);
