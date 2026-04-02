/**
 * VoiceNotes PM - Transcript Player module.
 * Provides synchronized audio playback with sentence-level highlighting,
 * click-to-seek, smooth auto-scroll, and manual scroll override.
 *
 * Used by both meetings.js (authenticated detail) and shared.js (public share).
 */

window.TranscriptPlayer = (() => {
    let audio = null;
    let segments = [];
    let segmentEls = [];
    let activeIdx = -1;
    let containerEl = null;
    let scrollContainer = null;
    let backToPlaybackBtn = null;

    // Scroll tracking
    let userScrolledAway = false;
    let programmaticScroll = false;
    let scrollDebounceTimer = null;

    function formatTime(seconds) {
        if (!seconds || !isFinite(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    /**
     * Initialize the transcript player.
     * @param {HTMLElement} container - The transcript-content container element
     * @param {Array} segs - Array of {start, end, text} segment objects
     * @param {string} audioUrl - Signed URL for the audio file
     */
    function init(container, segs, audioUrl) {
        if (!container || !segs || !segs.length || !audioUrl) return;

        containerEl = container;
        segments = segs;

        // Build the player DOM
        container.innerHTML = '';
        container.classList.add('transcript-player-active');
        container.style.display = 'block';

        // Scroll wrapper for segments
        scrollContainer = document.createElement('div');
        scrollContainer.className = 'transcript-segments-scroll';
        container.appendChild(scrollContainer);

        // Render segment spans
        segmentEls = [];
        segments.forEach((seg, idx) => {
            const span = document.createElement('div');
            span.className = 'transcript-segment';
            span.dataset.idx = idx;
            span.dataset.start = seg.start;
            span.dataset.end = seg.end;

            const ts = document.createElement('span');
            ts.className = 'segment-timestamp';
            ts.textContent = formatTime(seg.start);

            const txt = document.createElement('span');
            txt.className = 'segment-text';
            txt.textContent = seg.text;

            span.appendChild(ts);
            span.appendChild(txt);

            span.addEventListener('click', () => {
                if (audio) {
                    audio.currentTime = seg.start;
                    audio.play();
                    setActiveSegment(idx);
                    userScrolledAway = false;
                    hideBackToPlayback();
                }
            });

            scrollContainer.appendChild(span);
            segmentEls.push(span);
        });

        // "Back to playback" floating button
        backToPlaybackBtn = document.createElement('button');
        backToPlaybackBtn.className = 'back-to-playback';
        backToPlaybackBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg> Back to playback';
        backToPlaybackBtn.style.display = 'none';
        backToPlaybackBtn.addEventListener('click', () => {
            userScrolledAway = false;
            hideBackToPlayback();
            if (activeIdx >= 0 && segmentEls[activeIdx]) {
                scrollToSegment(activeIdx);
            }
        });
        container.appendChild(backToPlaybackBtn);

        // Create audio element
        audio = new Audio(audioUrl);
        audio.preload = 'metadata';

        // Sync playback highlighting
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('loadedmetadata', () => {
            const totalEl = document.getElementById('player-time-total');
            if (totalEl) totalEl.textContent = formatTime(audio.duration);
        });

        // Detect manual scrolling
        scrollContainer.addEventListener('scroll', onUserScroll, { passive: true });

        // Wire up mini-player controls
        initMiniPlayer();
    }

    function initMiniPlayer() {
        const player = document.getElementById('audio-mini-player');
        if (!player || !audio) return;
        player.style.display = 'flex';

        const playPauseBtn = document.getElementById('player-play-pause');
        const currentTimeEl = document.getElementById('player-time-current');
        const totalTimeEl = document.getElementById('player-time-total');
        const progressBar = document.getElementById('player-progress-bar');
        const progressFill = document.getElementById('player-progress-fill');
        const speedSelect = document.getElementById('player-speed');

        if (playPauseBtn) {
            playPauseBtn.addEventListener('click', () => {
                if (audio.paused) {
                    audio.play();
                } else {
                    audio.pause();
                }
            });
        }

        audio.addEventListener('play', () => {
            if (playPauseBtn) playPauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        });

        audio.addEventListener('pause', () => {
            if (playPauseBtn) playPauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        });

        audio.addEventListener('timeupdate', () => {
            if (currentTimeEl) currentTimeEl.textContent = formatTime(audio.currentTime);
            if (progressFill && audio.duration) {
                progressFill.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
            }
        });

        audio.addEventListener('loadedmetadata', () => {
            if (totalTimeEl) totalTimeEl.textContent = formatTime(audio.duration);
        });

        // Click on progress bar to seek
        if (progressBar) {
            progressBar.addEventListener('click', (e) => {
                if (!audio.duration) return;
                const rect = progressBar.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                audio.currentTime = pct * audio.duration;
            });
        }

        // Playback speed
        if (speedSelect) {
            speedSelect.addEventListener('change', () => {
                audio.playbackRate = parseFloat(speedSelect.value);
            });
        }
    }

    function onTimeUpdate() {
        if (!audio || !segments.length) return;
        const t = audio.currentTime;

        // Find the active segment (linear scan is fine for typical segment counts)
        let newIdx = -1;
        for (let i = 0; i < segments.length; i++) {
            if (t >= segments[i].start && (i === segments.length - 1 || t < segments[i + 1].start)) {
                newIdx = i;
                break;
            }
        }

        if (newIdx !== activeIdx && newIdx >= 0) {
            setActiveSegment(newIdx);
            if (!userScrolledAway) {
                scrollToSegment(newIdx);
            }
        }
    }

    function setActiveSegment(idx) {
        if (activeIdx >= 0 && segmentEls[activeIdx]) {
            segmentEls[activeIdx].classList.remove('active');
        }
        activeIdx = idx;
        if (segmentEls[idx]) {
            segmentEls[idx].classList.add('active');
        }
    }

    function scrollToSegment(idx) {
        const el = segmentEls[idx];
        if (!el || !scrollContainer) return;
        programmaticScroll = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        clearTimeout(scrollDebounceTimer);
        scrollDebounceTimer = setTimeout(() => {
            programmaticScroll = false;
        }, 400);
    }

    function onUserScroll() {
        if (programmaticScroll) return;
        if (!audio || audio.paused) return;
        userScrolledAway = true;
        showBackToPlayback();
    }

    function showBackToPlayback() {
        if (backToPlaybackBtn) backToPlaybackBtn.style.display = 'flex';
    }

    function hideBackToPlayback() {
        if (backToPlaybackBtn) backToPlaybackBtn.style.display = 'none';
    }

    function onEnded() {
        if (activeIdx >= 0 && segmentEls[activeIdx]) {
            segmentEls[activeIdx].classList.remove('active');
        }
        activeIdx = -1;
    }

    /**
     * Get plain text for clipboard copy (without timestamps).
     */
    function getPlainText() {
        return segments.map(s => s.text).join('\n\n');
    }

    /**
     * Clean up player state.
     */
    function destroy() {
        if (audio) {
            audio.pause();
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('ended', onEnded);
            audio.src = '';
            audio = null;
        }
        if (scrollContainer) {
            scrollContainer.removeEventListener('scroll', onUserScroll);
        }
        const player = document.getElementById('audio-mini-player');
        if (player) player.style.display = 'none';
        segments = [];
        segmentEls = [];
        activeIdx = -1;
        userScrolledAway = false;
        containerEl = null;
        scrollContainer = null;
        backToPlaybackBtn = null;
    }

    return { init, destroy, getPlainText };
})();
