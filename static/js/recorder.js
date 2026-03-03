/**
 * VoiceNotes PM - Audio recorder module.
 * Handles MediaRecorder, waveform visualization, full-audio diarization,
 * and overlay state machine.
 *
 * Recording strategy:
 *   - Records continuously for the entire meeting (no chunking).
 *   - On stop, the full audio blob is sent to /api/recordings/diarize
 *     which runs pyannote speaker diarization + whisper transcription.
 *   - The backend returns a speaker-labeled transcript once complete.
 */

window.RecorderModule = (() => {
    // ---- State ----
    let stream = null;
    let mediaRecorder = null;
    let audioChunks = [];          // all data chunks for full recording
    let timerInterval = null;
    let elapsedSeconds = 0;
    let audioContext = null;
    let analyserNode = null;
    let animFrameId = null;
    let isRecording = false;

    // Overlay state machine
    const STATES = ['recording', 'diarizing', 'type-select', 'details', 'summarizing', 'complete'];
    let currentMeetingId = null;
    let currentTranscript = null;
    let selectedMeetingTypeId = null;

    // DOM refs (set on openOverlay)
    let overlay, timerEl, canvas, ctx;

    function getEl(id) { return document.getElementById(id); }

    // ---------------------------------------------------------------------------
    // Overlay management
    // ---------------------------------------------------------------------------
    function openOverlay() {
        overlay = overlay || getEl('recording-overlay');
        if (!overlay) return;
        overlay.classList.add('visible');
        resetOverlayState();
        startRecording();
    }

    function closeOverlay() {
        if (!overlay) return;
        if (isRecording) {
            if (!confirm('Recording is in progress. Close anyway? The recording will be lost.')) return;
        }
        stopEverything();
        overlay.classList.remove('visible');
        resetOverlayState();
    }

    function showState(stateName) {
        STATES.forEach(s => {
            const el = getEl(`state-${s}`);
            if (el) el.classList.remove('active');
        });
        const target = getEl(`state-${stateName}`);
        if (target) target.classList.add('active');
    }

    function resetOverlayState() {
        stopEverything();
        audioChunks = [];
        elapsedSeconds = 0;
        currentMeetingId = null;
        currentTranscript = null;
        selectedMeetingTypeId = null;
        isRecording = false;
        if (getEl('recording-timer')) getEl('recording-timer').textContent = '00:00';
        STATES.forEach(s => {
            const el = getEl(`state-${s}`);
            if (el) el.classList.remove('active');
        });
        clearCanvas();
    }

    // ---------------------------------------------------------------------------
    // Continuous recording (no chunking)
    // ---------------------------------------------------------------------------
    async function startRecording() {
        if (!getEl('waveform-canvas')) return;
        canvas = getEl('waveform-canvas');
        ctx = canvas.getContext('2d');
        timerEl = getEl('recording-timer');

        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            showToast('Microphone access denied. Please allow microphone permission and try again.', 'error');
            closeOverlay();
            return;
        }

        // Web Audio visualization
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 128;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyserNode);
        drawWaveform();

        // Start continuous recording
        isRecording = true;
        audioChunks = [];
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
        mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.start(500); // collect data every 500ms

        // Timer
        elapsedSeconds = 0;
        timerInterval = setInterval(() => {
            elapsedSeconds++;
            const m = Math.floor(elapsedSeconds / 60);
            const s = elapsedSeconds % 60;
            if (timerEl) timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }, 1000);

        showState('recording');

        // Warn on page leave during recording
        window.addEventListener('beforeunload', beforeUnloadHandler);
    }

    function beforeUnloadHandler(e) {
        if (isRecording) {
            e.preventDefault();
            e.returnValue = '';
        }
    }

    function stopRecording() {
        if (!isRecording) return;
        isRecording = false;

        // Stop timer and visuals
        clearInterval(timerInterval);
        timerInterval = null;
        cancelAnimationFrame(animFrameId);
        animFrameId = null;

        window.removeEventListener('beforeunload', beforeUnloadHandler);

        showState('diarizing');

        // Stop the recorder and send the full audio for diarization
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.onstop = async () => {
                const mimeType = mediaRecorder ? mediaRecorder.mimeType : 'audio/webm';
                const blob = new Blob(audioChunks, { type: mimeType });
                audioChunks = [];

                // Clean up audio stream
                if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
                if (audioContext) { audioContext.close(); audioContext = null; }

                await diarizeAndCreateMeeting(blob);
            };
            mediaRecorder.stop();
        } else {
            // Recorder already stopped somehow
            if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
            if (audioContext) { audioContext.close(); audioContext = null; }
            showToast('No audio was captured.', 'error');
            closeOverlay();
        }
    }

    async function diarizeAndCreateMeeting(blob) {
        const startTime = Date.now();

        // Update elapsed time in the diarizing state
        const progressInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const el = getEl('diarize-elapsed');
            if (el) el.textContent = `${elapsed}s elapsed`;
        }, 1000);

        try {
            // Step 1: Submit audio for diarization
            const formData = new FormData();
            formData.append('audio', blob, 'recording.webm');
            formData.append('format', 'webm');

            const submitData = await api('/api/recordings/diarize', {
                method: 'POST',
                body: formData,
            });

            const jobId = submitData.job_id;

            // Step 2: Poll for result (tolerates transient network errors)
            let transcript = null;
            let pollErrors = 0;
            const MAX_POLL_ERRORS = 10; // give up after 10 consecutive failures

            while (true) {
                await new Promise(r => setTimeout(r, 3000));

                let status;
                try {
                    status = await api(`/api/recordings/diarize-status/${jobId}`);
                    pollErrors = 0; // reset on success
                } catch (pollErr) {
                    pollErrors++;
                    console.warn(`Poll error ${pollErrors}/${MAX_POLL_ERRORS}:`, pollErr.message);
                    if (pollErrors >= MAX_POLL_ERRORS) {
                        throw new Error('Lost connection to server. Your recording may still be processing — check your meetings list.');
                    }
                    continue; // retry on next interval
                }

                if (status.status === 'complete') {
                    transcript = status.transcript;
                    break;
                } else if (status.status === 'error') {
                    throw new Error(status.error || 'Diarization failed');
                }
                // else still processing, continue polling
            }

            clearInterval(progressInterval);

            if (!transcript || !transcript.trim()) {
                showToast('No speech was detected. Please try again.', 'error');
                closeOverlay();
                return;
            }

            // Step 3: Create meeting with the diarized transcript
            currentTranscript = transcript;
            const meetingForm = new FormData();
            meetingForm.append('transcript', transcript);

            const data = await api('/api/recordings/upload', {
                method: 'POST',
                body: meetingForm,
            });

            currentMeetingId = data.meeting_id;
            if (getEl('meeting-title-input')) getEl('meeting-title-input').value = '';

            // Show the new meeting in the list right away
            if (window.MeetingsModule && window.MeetingsModule.reload) {
                window.MeetingsModule.reload();
            }

            await loadMeetingTypes();
            showTranscriptPreview(currentTranscript);
            showState('type-select');

        } catch (err) {
            clearInterval(progressInterval);
            showToast(`Transcription failed: ${err.message}`, 'error');
            closeOverlay();
        }
    }

    function stopEverything() {
        isRecording = false;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.onstop = null; // prevent trigger
            mediaRecorder.stop();
        }
        clearInterval(timerInterval);
        timerInterval = null;
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (audioContext) { audioContext.close(); audioContext = null; }
        window.removeEventListener('beforeunload', beforeUnloadHandler);
    }

    // ---------------------------------------------------------------------------
    // Waveform visualization
    // ---------------------------------------------------------------------------
    function drawWaveform() {
        if (!analyserNode || !canvas || !ctx) return;
        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        function draw() {
            animFrameId = requestAnimationFrame(draw);
            analyserNode.getByteFrequencyData(dataArray);

            // Clear
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const barWidth = (canvas.width / bufferLength) * 2.2;
            const gap = 2;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const barHeight = (dataArray[i] / 255) * canvas.height;
                const alpha = 0.5 + (dataArray[i] / 255) * 0.5;
                ctx.fillStyle = `rgba(129, 140, 248, ${alpha})`;
                ctx.beginPath();
                ctx.roundRect(x, canvas.height - barHeight, barWidth - gap, barHeight, 3);
                ctx.fill();
                x += barWidth;
            }
        }
        draw();
    }

    function clearCanvas() {
        if (!canvas) canvas = getEl('waveform-canvas');
        if (!canvas) return;
        const c = canvas.getContext('2d');
        c.clearRect(0, 0, canvas.width, canvas.height);
    }

    // ---------------------------------------------------------------------------
    // Meeting type selection & folder helpers
    // ---------------------------------------------------------------------------
    async function loadMeetingTypes() {
        try {
            const data = await api('/api/meeting-types');
            const types = data.meeting_types || [];
            window.AppState.meetingTypes = types;
            renderTypeGrid(types);
            populateFolderSelect();
        } catch (err) {
            console.error('Failed to load meeting types', err);
        }
    }

    function showTranscriptPreview(text) {
        const el = getEl('transcript-preview');
        if (el) el.textContent = text ? (text.length > 600 ? text.slice(0, 600) + '...' : text) : '(No transcript)';
    }

    function renderTypeGrid(types) {
        const grid = getEl('meeting-type-grid');
        if (!grid) return;
        grid.innerHTML = '';
        types.forEach(type => {
            const card = document.createElement('div');
            card.className = 'meeting-type-card';
            card.innerHTML = `
        <div class="meeting-type-card-icon"><i data-lucide="${type.icon || 'file-text'}"></i></div>
        <div class="meeting-type-card-name">${type.name}</div>
        <div class="meeting-type-card-desc">${type.description || ''}</div>
      `;
            card.addEventListener('click', () => {
                grid.querySelectorAll('.meeting-type-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedMeetingTypeId = type.id;
                setTimeout(() => showState('details'), 300);
            });
            grid.appendChild(card);
        });
        if (window.lucide) lucide.createIcons();
    }

    async function populateFolderSelect() {
        const select = getEl('folder-select');
        if (!select) return;
        select.innerHTML = '<option value="">No Folder</option>';
        try {
            const data = await api('/api/folders');
            (data.folders || []).forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.id;
                opt.textContent = f.name;
                select.appendChild(opt);
            });
        } catch (e) { /* Silently skip if no folders */ }
    }

    // ---------------------------------------------------------------------------
    // Summarize
    // ---------------------------------------------------------------------------
    async function generateSummary() {
        const title = (getEl('meeting-title-input') || {}).value || '';
        const folderId = (getEl('folder-select') || {}).value || null;

        showState('summarizing');

        try {
            const data = await api('/api/recordings/summarize', {
                method: 'POST',
                body: {
                    meeting_id: currentMeetingId,
                    meeting_type_id: selectedMeetingTypeId,
                    title: title || undefined,
                    folder_id: folderId || undefined,
                },
            });

            showState('complete');

            const viewBtn = getEl('view-meeting-btn');
            if (viewBtn) {
                viewBtn.onclick = () => {
                    window.location.href = `/meeting/${currentMeetingId}`;
                };
            }

            // Reload list so card shows summary preview
            if (window.MeetingsModule && window.MeetingsModule.reload) {
                window.MeetingsModule.reload();
            }
        } catch (err) {
            showToast(
                `Summary generation failed: ${err.message}. You can retry from the meeting page.`,
                'error'
            );
            showState('details');
        }
    }

    // ---------------------------------------------------------------------------
    // Event bindings (called once on DOMContentLoaded)
    // ---------------------------------------------------------------------------
    async function generateAITitle() {
        const btn = getEl('ai-title-btn');
        const input = getEl('meeting-title-input');
        if (!btn || !input) return;
        if (!currentMeetingId) {
            showToast('No meeting to generate title for.', 'error');
            return;
        }

        const origHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Generating...';

        try {
            const response = await fetch('/api/recordings/generate-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meeting_id: currentMeetingId }),
            });

            let data;
            const text = await response.text();
            try {
                data = JSON.parse(text);
            } catch (parseErr) {
                console.error('Title response not JSON:', text.slice(0, 200));
                showToast('Failed to generate title: unexpected server response', 'error');
                btn.disabled = false;
                btn.innerHTML = origHTML;
                return;
            }

            if (response.ok && data.title) {
                input.value = data.title;
                input.focus();
                showToast('Title generated!', 'success');
            } else {
                showToast(data.error || 'Failed to generate title', 'error');
            }
        } catch (err) {
            console.error('Title generation fetch error:', err);
            showToast(`Failed to generate title: ${err.message}`, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = origHTML;
    }

    function bindEvents() {
        const stopBtn = getEl('stop-recording-btn');
        if (stopBtn) stopBtn.addEventListener('click', stopRecording);

        const closeBtn = getEl('overlay-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', closeOverlay);

        const genBtn = getEl('generate-summary-btn');
        if (genBtn) genBtn.addEventListener('click', generateSummary);

        const aiTitleBtn = getEl('ai-title-btn');
        if (aiTitleBtn) aiTitleBtn.addEventListener('click', generateAITitle);
    }

    document.addEventListener('DOMContentLoaded', bindEvents);

    // Public API
    return { openOverlay, closeOverlay };
})();
