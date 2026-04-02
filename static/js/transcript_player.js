/**
 * VoiceNotes PM - Transcript Player module.
 * Provides synchronized audio playback with sentence-level highlighting,
 * click-to-seek, smooth auto-scroll, manual scroll override, and
 * in-transcript text search.
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
    let searchInput = null;
    let initialized = false;

    // Scroll tracking
    let userScrolledAway = false;
    let programmaticScroll = false;
    let scrollDebounceTimer = null;

    // Search state
    let searchMatches = [];
    let currentMatchIdx = -1;

    // Bound handlers for clean removal
    let boundOnTimeUpdate = null;
    let boundOnEnded = null;
    let boundOnPlay = null;
    let boundOnPause = null;
    let boundOnLoadedMeta = null;
    let boundOnTimeUpdateMini = null;
    let boundOnLoadedMetaMini = null;

    function formatTime(seconds) {
        if (seconds == null || !isFinite(seconds) || seconds < 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Initialize the transcript player. Safe to call multiple times;
     * cleans up previous instance first.
     */
    function init(container, segs, audioUrl) {
        if (!container || !segs || !segs.length || !audioUrl) return;

        // Clean up any previous instance
        destroy();

        containerEl = container;
        segments = segs;
        initialized = true;

        container.innerHTML = '';
        container.classList.add('transcript-player-active');
        container.style.display = 'block';

        // Search bar
        const searchBar = document.createElement('div');
        searchBar.className = 'transcript-search-bar';

        searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'transcript-search-input';
        searchInput.placeholder = 'Search transcript...';
        searchInput.addEventListener('input', onSearchInput);
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) navigateSearch(-1);
                else navigateSearch(1);
            }
            if (e.key === 'Escape') {
                searchInput.value = '';
                clearSearch();
                searchInput.blur();
            }
        });

        const searchCount = document.createElement('span');
        searchCount.className = 'transcript-search-count';
        searchCount.id = 'transcript-search-count';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'transcript-search-nav';
        prevBtn.title = 'Previous match';
        prevBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
        prevBtn.addEventListener('click', () => navigateSearch(-1));

        const nextBtn = document.createElement('button');
        nextBtn.className = 'transcript-search-nav';
        nextBtn.title = 'Next match';
        nextBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        nextBtn.addEventListener('click', () => navigateSearch(1));

        searchBar.appendChild(searchInput);
        searchBar.appendChild(searchCount);
        searchBar.appendChild(prevBtn);
        searchBar.appendChild(nextBtn);
        container.appendChild(searchBar);

        // Scroll wrapper for segments
        scrollContainer = document.createElement('div');
        scrollContainer.className = 'transcript-segments-scroll';
        container.appendChild(scrollContainer);

        // Render segment spans
        segmentEls = [];
        segments.forEach((seg, idx) => {
            const row = document.createElement('div');
            row.className = 'transcript-segment';
            row.dataset.idx = idx;
            row.dataset.start = seg.start;
            row.dataset.end = seg.end;

            const ts = document.createElement('span');
            ts.className = 'segment-timestamp';
            ts.textContent = formatTime(seg.start);

            const txt = document.createElement('span');
            txt.className = 'segment-text';
            txt.textContent = seg.text;

            row.appendChild(ts);
            row.appendChild(txt);

            row.addEventListener('click', () => onSegmentClick(idx));

            scrollContainer.appendChild(row);
            segmentEls.push(row);
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

        // Create audio element — preload auto so play at 0 works immediately
        audio = new Audio(audioUrl);
        audio.preload = 'auto';

        // #region agent log
        audio.addEventListener('loadedmetadata', () => { fetch('http://127.0.0.1:7536/ingest/1f6990e5-0d9c-41d5-8d17-473da87fda65',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4f20df'},body:JSON.stringify({sessionId:'4f20df',location:'transcript_player.js:init-loadedmetadata',message:'Audio metadata loaded',data:{duration:audio.duration,src:audio.src.substring(0,120),seekable_length:audio.seekable.length,seekable_end:audio.seekable.length>0?audio.seekable.end(audio.seekable.length-1):0,segments_count:segments.length,last_segment_end:segments.length>0?segments[segments.length-1].end:0},timestamp:Date.now(),hypothesisId:'H-C'})}).catch(()=>{}); });
        // #endregion

        // #region agent log
        audio.addEventListener('error', () => { fetch('http://127.0.0.1:7536/ingest/1f6990e5-0d9c-41d5-8d17-473da87fda65',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4f20df'},body:JSON.stringify({sessionId:'4f20df',location:'transcript_player.js:audio-error',message:'Audio element error',data:{error_code:audio.error?audio.error.code:null,error_msg:audio.error?audio.error.message:'none',src:audio.src.substring(0,120)},timestamp:Date.now(),hypothesisId:'H-A'})}).catch(()=>{}); });
        // #endregion

        // Bind all event handlers (stored for clean removal)
        boundOnTimeUpdate = onTimeUpdate;
        boundOnEnded = onEnded;
        audio.addEventListener('timeupdate', boundOnTimeUpdate);
        audio.addEventListener('ended', boundOnEnded);

        // Detect manual scrolling
        scrollContainer.addEventListener('scroll', onUserScroll, { passive: true });

        // Wire up mini-player controls
        initMiniPlayer();
    }

    function onSegmentClick(idx) {
        if (!audio) return;
        const seg = segments[idx];
        if (!seg) return;

        // #region agent log
        const beforeTime = audio.currentTime;
        const dur = audio.duration;
        // #endregion

        audio.currentTime = seg.start;
        setActiveSegment(idx);
        updateProgressBar();
        userScrolledAway = false;
        hideBackToPlayback();

        // #region agent log
        fetch('http://127.0.0.1:7536/ingest/1f6990e5-0d9c-41d5-8d17-473da87fda65',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4f20df'},body:JSON.stringify({sessionId:'4f20df',location:'transcript_player.js:onSegmentClick',message:'Segment clicked',data:{idx:idx,seg_start:seg.start,seg_end:seg.end,seg_text:seg.text.substring(0,60),audio_duration:dur,before_currentTime:beforeTime,after_currentTime:audio.currentTime,paused:audio.paused,readyState:audio.readyState,seekable_length:audio.seekable.length,seekable_end:audio.seekable.length>0?audio.seekable.end(audio.seekable.length-1):0,buffered_length:audio.buffered.length,buffered_end:audio.buffered.length>0?audio.buffered.end(audio.buffered.length-1):0},timestamp:Date.now(),hypothesisId:'H-D'})}).catch(()=>{});
        // #endregion

        audio.play().catch((err) => {
            // #region agent log
            fetch('http://127.0.0.1:7536/ingest/1f6990e5-0d9c-41d5-8d17-473da87fda65',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4f20df'},body:JSON.stringify({sessionId:'4f20df',location:'transcript_player.js:play-failed',message:'audio.play() rejected',data:{error:err.message,idx:idx,seg_start:seg.start},timestamp:Date.now(),hypothesisId:'H-D'})}).catch(()=>{});
            // #endregion
            console.warn('Playback failed:', err);
        });
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

        // Remove any stale listeners from previous init by cloning nodes
        if (playPauseBtn) {
            const fresh = playPauseBtn.cloneNode(true);
            playPauseBtn.parentNode.replaceChild(fresh, playPauseBtn);
            fresh.addEventListener('click', () => {
                if (!audio) return;
                if (audio.paused) {
                    audio.play().catch((err) => console.warn('Play failed:', err));
                } else {
                    audio.pause();
                }
            });
        }

        if (progressBar) {
            const freshBar = progressBar.cloneNode(true);
            progressBar.parentNode.replaceChild(freshBar, progressBar);
            freshBar.addEventListener('click', (e) => {
                if (!audio || !audio.duration) return;
                const rect = freshBar.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                audio.currentTime = pct * audio.duration;
                updateProgressBar();
            });
        }

        if (speedSelect) {
            const freshSpeed = speedSelect.cloneNode(true);
            speedSelect.parentNode.replaceChild(freshSpeed, speedSelect);
            freshSpeed.addEventListener('change', () => {
                if (audio) audio.playbackRate = parseFloat(freshSpeed.value);
            });
        }

        boundOnPlay = () => {
            const btn = document.getElementById('player-play-pause');
            if (btn) btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        };
        boundOnPause = () => {
            const btn = document.getElementById('player-play-pause');
            if (btn) btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        };
        boundOnTimeUpdateMini = () => {
            if (!audio) return;
            if (currentTimeEl) currentTimeEl.textContent = formatTime(audio.currentTime);
            updateProgressBar();
        };
        boundOnLoadedMetaMini = () => {
            if (!audio) return;
            if (totalTimeEl) totalTimeEl.textContent = formatTime(audio.duration);
        };

        audio.addEventListener('play', boundOnPlay);
        audio.addEventListener('pause', boundOnPause);
        audio.addEventListener('timeupdate', boundOnTimeUpdateMini);
        audio.addEventListener('loadedmetadata', boundOnLoadedMetaMini);

        // If metadata already loaded (cached), set total now
        if (audio.duration && isFinite(audio.duration)) {
            if (totalTimeEl) totalTimeEl.textContent = formatTime(audio.duration);
        }
    }

    function updateProgressBar() {
        const fill = document.getElementById('player-progress-fill');
        if (fill && audio && audio.duration) {
            fill.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
        }
    }

    // -----------------------------------------------------------------------
    // Playback sync
    // -----------------------------------------------------------------------
    function onTimeUpdate() {
        if (!audio || !segments.length) return;
        const t = audio.currentTime;

        let newIdx = -1;
        for (let i = 0; i < segments.length; i++) {
            const segStart = segments[i].start;
            const nextStart = (i < segments.length - 1) ? segments[i + 1].start : Infinity;
            if (t >= segStart && t < nextStart) {
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
        if (idx >= 0 && segmentEls[idx]) {
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
        }, 500);
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

    // -----------------------------------------------------------------------
    // Transcript search
    // -----------------------------------------------------------------------
    function onSearchInput() {
        const query = (searchInput.value || '').trim();
        if (!query || query.length < 2) {
            clearSearch();
            return;
        }
        performSearch(query);
    }

    function performSearch(query) {
        clearSearchHighlights();
        searchMatches = [];
        currentMatchIdx = -1;

        const regex = new RegExp('(' + escapeRegExp(query) + ')', 'gi');

        segments.forEach((seg, idx) => {
            const el = segmentEls[idx];
            if (!el) return;
            const textSpan = el.querySelector('.segment-text');
            if (!textSpan) return;

            if (regex.test(seg.text)) {
                regex.lastIndex = 0;
                el.classList.add('search-match');
                searchMatches.push(idx);

                // Highlight matching text within the span
                const parts = seg.text.split(regex);
                textSpan.innerHTML = '';
                parts.forEach(part => {
                    if (regex.test(part)) {
                        const mark = document.createElement('mark');
                        mark.className = 'transcript-highlight';
                        mark.textContent = part;
                        textSpan.appendChild(mark);
                    } else {
                        textSpan.appendChild(document.createTextNode(part));
                    }
                    regex.lastIndex = 0;
                });
            }
        });

        updateSearchCount();
        if (searchMatches.length > 0) {
            currentMatchIdx = 0;
            scrollToMatch(0);
        }
    }

    function navigateSearch(direction) {
        if (!searchMatches.length) return;
        currentMatchIdx = (currentMatchIdx + direction + searchMatches.length) % searchMatches.length;
        scrollToMatch(currentMatchIdx);
        updateSearchCount();
    }

    function scrollToMatch(matchIdx) {
        const segIdx = searchMatches[matchIdx];
        const el = segmentEls[segIdx];
        if (!el) return;

        // Remove focus class from all, add to current
        segmentEls.forEach(e => e.classList.remove('search-focus'));
        el.classList.add('search-focus');

        programmaticScroll = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        clearTimeout(scrollDebounceTimer);
        scrollDebounceTimer = setTimeout(() => {
            programmaticScroll = false;
        }, 500);
    }

    function updateSearchCount() {
        const el = document.getElementById('transcript-search-count');
        if (!el) return;
        if (searchMatches.length > 0) {
            el.textContent = (currentMatchIdx + 1) + '/' + searchMatches.length;
        } else if (searchInput && searchInput.value.trim().length >= 2) {
            el.textContent = 'No results';
        } else {
            el.textContent = '';
        }
    }

    function clearSearch() {
        clearSearchHighlights();
        searchMatches = [];
        currentMatchIdx = -1;
        const el = document.getElementById('transcript-search-count');
        if (el) el.textContent = '';
    }

    function clearSearchHighlights() {
        segmentEls.forEach((el, idx) => {
            el.classList.remove('search-match', 'search-focus');
            const textSpan = el.querySelector('.segment-text');
            if (textSpan) {
                textSpan.textContent = segments[idx].text;
            }
        });
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    function getPlainText() {
        return segments.map(s => s.text).join('\n\n');
    }

    function destroy() {
        if (audio) {
            audio.pause();
            if (boundOnTimeUpdate) audio.removeEventListener('timeupdate', boundOnTimeUpdate);
            if (boundOnEnded) audio.removeEventListener('ended', boundOnEnded);
            if (boundOnPlay) audio.removeEventListener('play', boundOnPlay);
            if (boundOnPause) audio.removeEventListener('pause', boundOnPause);
            if (boundOnTimeUpdateMini) audio.removeEventListener('timeupdate', boundOnTimeUpdateMini);
            if (boundOnLoadedMetaMini) audio.removeEventListener('loadedmetadata', boundOnLoadedMetaMini);
            audio.src = '';
            audio = null;
        }
        if (scrollContainer) {
            scrollContainer.removeEventListener('scroll', onUserScroll);
        }
        const player = document.getElementById('audio-mini-player');
        if (player) player.style.display = 'none';
        clearTimeout(scrollDebounceTimer);
        segments = [];
        segmentEls = [];
        activeIdx = -1;
        userScrolledAway = false;
        programmaticScroll = false;
        containerEl = null;
        scrollContainer = null;
        backToPlaybackBtn = null;
        searchInput = null;
        searchMatches = [];
        currentMatchIdx = -1;
        initialized = false;
        boundOnTimeUpdate = null;
        boundOnEnded = null;
        boundOnPlay = null;
        boundOnPause = null;
        boundOnLoadedMeta = null;
        boundOnTimeUpdateMini = null;
        boundOnLoadedMetaMini = null;
    }

    return { init, destroy, getPlainText };
})();
