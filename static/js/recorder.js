/**
 * VoiceNotes PM - Audio recorder module.
 * Handles MediaRecorder, waveform visualization, streaming transcription,
 * and overlay state machine.
 *
 * Streaming strategy:
 *   - Every CHUNK_INTERVAL_MS (60s), the recorder is stopped and immediately
 *     restarted. The completed segment is sent to /api/recordings/transcribe-chunk
 *     for Whisper transcription (verbose_json with segment timestamps).
 *   - Transcript text and timed segments accumulate in real time during recording.
 *   - All audio blobs are kept in allRecordedBlobs[] for final assembly.
 *   - On final stop, the last segment is transcribed, then the meeting record
 *     is created with the full audio blob + accumulated timed segments.
 */

window.RecorderModule = (() => {
    // ---- Config ----
    const CHUNK_INTERVAL_MS = 60_000;

    // ---- State ----
    let stream = null;
    window.addEventListener('beforeunload', () => {
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    });
    let mediaRecorder = null;
    let audioChunks = [];          // chunks for current segment (reset per rotation)
    let timerInterval = null;
    let elapsedSeconds = 0;
    let audioContext = null;
    let analyserNode = null;
    let animFrameId = null;

    // Streaming transcription state
    let transcriptSegments = [];   // array of transcript strings (for live preview)
    let pendingTranscriptions = 0;
    let chunkRotateInterval = null;
    let isRecording = false;

    // Audio + segment accumulators for final upload
    let continuousRecorder = null; // single uninterrupted recorder for the final audio file
    let allRecordedBlobs = [];     // blobs from continuousRecorder (one valid WebM stream)
    let timedSegments = [];        // [{start, end, text}, ...] with offsets applied
    let chunkStartTime = 0;        // elapsed seconds when current chunk started

    // Overlay state machine
    const STATES = ['recording', 'processing', 'type-select', 'details', 'summarizing', 'complete'];
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
        allRecordedBlobs = [];
        continuousRecorder = null;
        transcriptSegments = [];
        timedSegments = [];
        chunkStartTime = 0;
        pendingTranscriptions = 0;
        elapsedSeconds = 0;
        currentMeetingId = null;
        currentTranscript = null;
        selectedMeetingTypeId = null;
        isRecording = false;
        if (getEl('recording-timer')) getEl('recording-timer').textContent = '00:00';
        if (getEl('live-transcript')) getEl('live-transcript').style.display = 'none';
        if (getEl('live-transcript-text')) getEl('live-transcript-text').textContent = '';
        if (getEl('transcription-status')) getEl('transcription-status').textContent = '';
        const progressBar = getEl('upload-progress');
        if (progressBar) { progressBar.style.display = 'none'; progressBar.value = 0; }
        STATES.forEach(s => {
            const el = getEl(`state-${s}`);
            if (el) el.classList.remove('active');
        });
        clearCanvas();
    }

    // ---------------------------------------------------------------------------
    // Recording with streaming transcription
    // ---------------------------------------------------------------------------
    async function startRecording() {
        if (!getEl('waveform-canvas')) return;
        canvas = getEl('waveform-canvas');
        ctx = canvas.getContext('2d');
        timerEl = getEl('recording-timer');

        try {
            if (!stream || stream.getTracks().some(t => t.readyState === 'ended')) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
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

        // Start continuous recorder (never stopped during session — produces valid single WebM)
        isRecording = true;
        chunkStartTime = 0;
        startContinuousRecorder();

        // Start first chunked recorder segment (stopped/restarted for transcription)
        startRecorderSegment();

        // Timer
        elapsedSeconds = 0;
        timerInterval = setInterval(() => {
            elapsedSeconds++;
            const m = Math.floor(elapsedSeconds / 60);
            const s = elapsedSeconds % 60;
            if (timerEl) timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }, 1000);

        showState('recording');

        // Periodic chunk rotation for streaming transcription
        chunkRotateInterval = setInterval(() => {
            if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') {
                rotateRecorderSegment();
            }
        }, CHUNK_INTERVAL_MS);

        window.addEventListener('beforeunload', beforeUnloadHandler);
    }

    function getMimeType() {
        return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
    }

    function startContinuousRecorder() {
        const mimeType = getMimeType();
        continuousRecorder = new MediaRecorder(stream, { mimeType });
        continuousRecorder.ondataavailable = e => {
            if (e.data.size > 0) {
                allRecordedBlobs.push(e.data);
            }
        };
        continuousRecorder.start(1000);
    }

    function startRecorderSegment() {
        audioChunks = [];
        const mimeType = getMimeType();
        mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) {
                audioChunks.push(e.data);
            }
        };
        mediaRecorder.start(500);
    }

    function rotateRecorderSegment() {
        if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

        const chunksToSend = audioChunks;
        audioChunks = [];
        const offsetAtChunkStart = chunkStartTime;
        chunkStartTime = elapsedSeconds;

        mediaRecorder.onstop = () => {
            const mimeType = mediaRecorder ? mediaRecorder.mimeType : 'audio/webm';
            const blob = new Blob(chunksToSend, { type: mimeType });
            sendChunkForTranscription(blob, offsetAtChunkStart);

            if (isRecording && stream) {
                startRecorderSegment();
            }
        };
        mediaRecorder.stop();
    }

    async function sendChunkForTranscription(blob, offsetSeconds) {
        if (blob.size < 500) return;

        pendingTranscriptions++;
        updateTranscriptionStatus();

        const formData = new FormData();
        formData.append('audio', blob, 'chunk.webm');
        formData.append('format', 'webm');

        try {
            const data = await api('/api/recordings/transcribe-chunk', {
                method: 'POST',
                body: formData,
            });

            // Accumulate timed segments with offset applied
            if (data.segments && data.segments.length) {
                for (const seg of data.segments) {
                    timedSegments.push({
                        start: seg.start + (offsetSeconds || 0),
                        end: seg.end + (offsetSeconds || 0),
                        text: seg.text,
                    });
                }
            }

            // Keep text accumulation for live preview
            if (data.text && data.text.trim()) {
                transcriptSegments.push(data.text.trim());
                updateLiveTranscript();
            }
        } catch (err) {
            console.error('Chunk transcription failed:', err);
        }

        pendingTranscriptions--;
        updateTranscriptionStatus();
    }

    function updateLiveTranscript() {
        const container = getEl('live-transcript');
        const textEl = getEl('live-transcript-text');
        if (!container || !textEl) return;

        const fullText = transcriptSegments.join(' ');
        if (fullText) {
            container.style.display = 'block';
            textEl.textContent = fullText.length > 300
                ? '...' + fullText.slice(-300)
                : fullText;
            textEl.scrollTop = textEl.scrollHeight;
        }
    }

    function updateTranscriptionStatus() {
        const el = getEl('transcription-status');
        if (!el) return;
        if (pendingTranscriptions > 0) {
            el.textContent = 'Transcribing...';
            el.className = 'transcription-status active';
        } else if (transcriptSegments.length > 0) {
            el.textContent = `${transcriptSegments.length} segment${transcriptSegments.length > 1 ? 's' : ''} transcribed`;
            el.className = 'transcription-status';
        } else {
            el.textContent = '';
            el.className = 'transcription-status';
        }
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

        clearInterval(chunkRotateInterval);
        chunkRotateInterval = null;
        clearInterval(timerInterval);
        timerInterval = null;
        cancelAnimationFrame(animFrameId);
        animFrameId = null;

        window.removeEventListener('beforeunload', beforeUnloadHandler);

        showState('processing');

        // Stop the continuous recorder first so allRecordedBlobs is complete
        if (continuousRecorder && continuousRecorder.state !== 'inactive') {
            continuousRecorder.stop();
        }

        if (mediaRecorder && mediaRecorder.state === 'recording') {
            const finalChunks = audioChunks;
            audioChunks = [];
            const finalOffset = chunkStartTime;

            mediaRecorder.onstop = async () => {
                const mimeType = getMimeType();
                const blob = new Blob(finalChunks, { type: mimeType });

                if (blob.size >= 500) {
                    await sendChunkForTranscription(blob, finalOffset);
                }

                while (pendingTranscriptions > 0) {
                    await new Promise(r => setTimeout(r, 200));
                }

                if (audioContext) { audioContext.close(); audioContext = null; }

                await createMeetingWithTranscript();
            };
            mediaRecorder.stop();
        } else {
            if (audioContext) { audioContext.close(); audioContext = null; }
            createMeetingWithTranscript();
        }
    }

    // ---------------------------------------------------------------------------
    // Upload with progress tracking
    // ---------------------------------------------------------------------------
    function uploadWithProgress(formData) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/recordings/upload');

            const progressBar = getEl('upload-progress');
            const progressText = getEl('upload-progress-text');
            if (progressBar) progressBar.style.display = 'block';

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    if (progressBar) progressBar.value = pct;
                    if (progressText) progressText.textContent = `Uploading... ${pct}%`;
                }
            };

            xhr.onload = () => {
                if (progressBar) progressBar.style.display = 'none';
                if (progressText) progressText.textContent = '';
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(data.error || `Upload failed (${xhr.status})`));
                    }
                } catch (e) {
                    reject(new Error('Invalid response from server'));
                }
            };

            xhr.onerror = () => {
                if (progressBar) progressBar.style.display = 'none';
                if (progressText) progressText.textContent = '';
                reject(new Error('Upload failed — network error'));
            };

            xhr.send(formData);
        });
    }

    async function createMeetingWithTranscript() {
        const fullTranscript = transcriptSegments.join('\n\n');

        if (!fullTranscript.trim()) {
            showToast('No speech was detected. Please try again.', 'error');
            closeOverlay();
            return;
        }

        try {
            const mimeType = getMimeType();
            const audioBlob = new Blob(allRecordedBlobs, { type: mimeType });

            const formData = new FormData();
            formData.append('transcript', fullTranscript);
            formData.append('format', 'webm');
            formData.append('duration', String(elapsedSeconds));

            if (audioBlob.size >= 1000) {
                formData.append('audio', audioBlob, 'recording.webm');
            }
            if (timedSegments.length > 0) {
                formData.append('segments', JSON.stringify(timedSegments));
            }

            const data = await uploadWithProgress(formData);

            currentMeetingId = data.meeting_id;
            currentTranscript = data.transcript;
            if (getEl('meeting-title-input')) getEl('meeting-title-input').value = '';

            if (window.MeetingsModule && window.MeetingsModule.reload) {
                window.MeetingsModule.reload();
            }

            await loadMeetingTypes();
            showTranscriptPreview(currentTranscript);
            showState('type-select');
        } catch (err) {
            showToast(`Failed to save meeting: ${err.message}`, 'error');
            closeOverlay();
        }
    }

    function stopEverything() {
        isRecording = false;
        clearInterval(chunkRotateInterval);
        chunkRotateInterval = null;
        if (continuousRecorder && continuousRecorder.state !== 'inactive') {
            continuousRecorder.onstop = null;
            continuousRecorder.stop();
        }
        continuousRecorder = null;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.onstop = null;
            mediaRecorder.stop();
        }
        clearInterval(timerInterval);
        timerInterval = null;
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
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
                setTimeout(() => {
                    showState('details');
                    autoGenerateTitle();
                }, 300);
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
    async function autoGenerateTitle() {
        const input = getEl('meeting-title-input');
        const spinner = getEl('title-spinner');
        if (!input) return;
        if (!currentMeetingId) return;

        input.value = '';
        input.placeholder = 'Generating title...';
        if (spinner) spinner.style.display = 'flex';

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
                input.placeholder = 'Enter meeting title...';
                if (spinner) spinner.style.display = 'none';
                return;
            }

            if (response.ok && data.title) {
                input.value = data.title;
            }
        } catch (err) {
            console.error('Title generation failed:', err);
        }

        input.placeholder = 'Enter meeting title...';
        if (spinner) spinner.style.display = 'none';
    }

    function bindEvents() {
        const stopBtn = getEl('stop-recording-btn');
        if (stopBtn) stopBtn.addEventListener('click', stopRecording);

        const closeBtn = getEl('overlay-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', closeOverlay);

        const genBtn = getEl('generate-summary-btn');
        if (genBtn) genBtn.addEventListener('click', generateSummary);
    }

    document.addEventListener('DOMContentLoaded', bindEvents);

    // Public API
    return { openOverlay, closeOverlay };
})();
