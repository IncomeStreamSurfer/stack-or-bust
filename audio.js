// ============================================================================
// STACK OR BUST - Audio System
// ============================================================================

// Audio Context and state
let audioContext = null;
let bgMusic = null;
let isMuted = false;
let audioInitialized = false;

// Volume levels
const MUSIC_VOLUME = 0.25;  // Background music - lower volume
const SFX_VOLUME = 0.5;     // Sound effects - higher volume

// Initialize audio context (must be called after user interaction)
function initAudio() {
    if (audioInitialized) return;

    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioInitialized = true;

        // Show mute button
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) {
            muteBtn.classList.add('visible');
            updateMuteButton();
        }

        // Start background music
        startBackgroundMusic();
    } catch (e) {
        console.log('Web Audio API not supported');
    }
}

// Background Music
function startBackgroundMusic() {
    if (!audioInitialized || bgMusic) return;

    bgMusic = new Audio('Pixel Shuffle Showdown.mp3');
    bgMusic.loop = true;
    bgMusic.volume = isMuted ? 0 : MUSIC_VOLUME;
    bgMusic.play().catch(e => console.log('Music autoplay blocked'));
}

function stopBackgroundMusic() {
    if (bgMusic) {
        bgMusic.pause();
        bgMusic.currentTime = 0;
        bgMusic = null;
    }
}

// Toggle Mute
function toggleMute() {
    isMuted = !isMuted;

    // Update background music
    if (bgMusic) {
        bgMusic.volume = isMuted ? 0 : MUSIC_VOLUME;
    }

    updateMuteButton();
    playClickSound(); // Play sound if unmuting
}

function updateMuteButton() {
    const muteBtn = document.getElementById('mute-btn');
    if (muteBtn) {
        muteBtn.textContent = isMuted ? '🔇' : '🔊';
        muteBtn.classList.toggle('muted', isMuted);
    }
}

// ============================================================================
// Sound Effect Generators (Web Audio API)
// ============================================================================

// Card draw/flip sound - soft whoosh
function playCardDrawSound() {
    if (!audioInitialized || !audioContext || isMuted) return;

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();

    // Noise-like whoosh using frequency sweep
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(200, audioContext.currentTime + 0.15);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, audioContext.currentTime);
    filter.frequency.exponentialRampToValueAtTime(500, audioContext.currentTime + 0.15);

    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(SFX_VOLUME * 0.3, audioContext.currentTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);

    oscillator.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.15);
}

// Win money - cheerful cha-ching coin sound
function playWinSound() {
    if (!audioInitialized || !audioContext || isMuted) return;

    // Play a sequence of ascending tones
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6

    notes.forEach((freq, i) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(freq, audioContext.currentTime);

        const startTime = audioContext.currentTime + i * 0.08;
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(SFX_VOLUME * 0.4, startTime + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + 0.2);

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.start(startTime);
        oscillator.stop(startTime + 0.25);
    });

    // Add coin jingle
    setTimeout(() => playJingleTone(1318.51, 0.1), 100); // E6
    setTimeout(() => playJingleTone(1567.98, 0.15), 180); // G6
}

function playJingleTone(freq, duration) {
    if (!audioContext) return;

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, audioContext.currentTime);

    gain.gain.setValueAtTime(SFX_VOLUME * 0.25, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start();
    osc.stop(audioContext.currentTime + duration);
}

// Lose money - sad womp womp sound
function playLoseSound() {
    if (!audioInitialized || !audioContext || isMuted) return;

    // Descending tones for sad effect
    const notes = [392, 349.23, 293.66]; // G4, F4, D4

    notes.forEach((freq, i) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(freq, audioContext.currentTime + i * 0.25);
        oscillator.frequency.exponentialRampToValueAtTime(freq * 0.9, audioContext.currentTime + i * 0.25 + 0.2);

        const startTime = audioContext.currentTime + i * 0.25;
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(SFX_VOLUME * 0.35, startTime + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + 0.3);

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.start(startTime);
        oscillator.stop(startTime + 0.35);
    });
}

// UI click - cute pop/blip sound
function playClickSound() {
    if (!audioInitialized || !audioContext || isMuted) return;

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5
    oscillator.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + 0.08);

    gainNode.gain.setValueAtTime(SFX_VOLUME * 0.25, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.08);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.08);
}

// Add click sound to all buttons
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', (e) => {
        if (e.target.matches('.btn, .login-btn, .menu-item, .stake-btn, .avatar-option')) {
            playClickSound();
        }
    });
});
