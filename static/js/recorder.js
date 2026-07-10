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
 *   - Drafts are persisted to IndexedDB so failed uploads can be retried.
 *   - On final stop, the last segment is transcribed, then the meeting record
 *     is created with the full audio blob + accumulated timed segments.
 */

window.RecorderModule = (() => {
    // ---- Config ----
    const CHUNK_INTERVAL_MS = 60_000;
    const DRAFT_SAVE_INTERVAL_MS = 15_000;
    const MAX_CHUNK_CONCURRENCY = 1;

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
    let chunkQueue = [];
    let activeChunkJobs = 0;

    // Audio + segment accumulators for final upload
    let allRecordedBlobs = [];     // all audio blobs across rotations (concatenated WebM — remuxed server-side)
    let timedSegments = [];        // [{start, end, text}, ...] with offsets applied
    let chunkStartTime = 0;        // elapsed seconds when current chunk started
    let draftSaveInterval = null;
    let hasRecoverableDraft = false;
    let lastUploadError = null;

    // Overlay state machine
    const STATES = ['recording', 'processing', 'type-select', 'details', 'summarizing', 'complete'];
    let currentMeetingId = null;
    let currentTranscript = null;
    let selectedMeetingTypeId = null;
    let titlePromise = null;        // in-flight AI title generation

    // DOM refs (set on openOverlay)
    let overlay, timerEl, canvas, ctx;

    function getEl(id) { return document.getElementById(id); }

    function draftsAvailable() {
        return !!(window.RecordingDrafts && window.indexedDB);
    }

    function formatDraftMeta(draft) {
        const mins = Math.max(1, Math.round((draft.durationSeconds || 0) / 60));
        const when = draft.updatedAt
            ? new Date(draft.updatedAt).toLocaleString()
            : 'recently';
        const sizeMb = draft.audioBlob
            ? (draft.audioBlob.size / (1024 * 1024)).toFixed(1)
            : '?';
        return `${mins} min · ${sizeMb} MB · last saved ${when}`;
    }

    async function persistDraft(extra = {}) {
        if (!draftsAvailable() || allRecordedBlobs.length === 0) return null;
        try {
            const mimeType = getMimeType();
            const audioBlob = new Blob(allRecordedBlobs, { type: mimeType });
            if (audioBlob.size < 500) return null;
            return await window.RecordingDrafts.saveActive({
                status: extra.status || (isRecording ? 'recording' : 'pending_upload'),
                mimeType,
                audioBlob,
                transcript: transcriptSegments.join('\n\n'),
                transcriptSegments: transcriptSegments.slice(),
                timedSegments: timedSegments.slice(),
                durationSeconds: elapsedSeconds,
                meetingId: currentMeetingId,
                lastError: lastUploadError,
                ...extra,
            });
        } catch (err) {
            console.error('Failed to persist recording draft:', err);
            return null;
        }
    }

    async function clearDraft() {
        hasRecoverableDraft = false;
        hideDraftBanner();
        if (!draftsAvailable()) return;
        try {
            await window.RecordingDrafts.deleteDraft();
        } catch (err) {
            console.error('Failed to clear recording draft:', err);
        }
    }

    function hideDraftBanner() {
        const banner = getEl('pending-draft-banner');
        if (banner) banner.style.display = 'none';
    }

    function showDraftBanner(draft) {
        const banner = getEl('pending-draft-banner');
        const meta = getEl('pending-draft-meta');
        if (!banner) return;
        if (meta) meta.textContent = formatDraftMeta(draft);
        banner.style.display = 'flex';
        hasRecoverableDraft = true;
    }

    async function checkPendingDraft() {
        if (!draftsAvailable()) return;
        try {
            const draft = await window.RecordingDrafts.getDraft();
            if (!draft || !draft.audioBlob || draft.audioBlob.size < 1000) {
                hideDraftBanner();
                return;
            }
            // Successful uploads clear the draft; anything left is recoverable.
            if (draft.status === 'uploaded' && draft.meetingId) {
                await clearDraft();
                return;
            }
            showDraftBanner(draft);
        } catch (err) {
            console.error('Failed to check recording drafts:', err);
        }
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `voicenotes-recording-${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function setProcessingUi({ failed = false, message = '', detail = '' } = {}) {
        const spinner = getEl('processing-spinner');
        const title = getEl('processing-title');
        const progressText = getEl('upload-progress-text');
        const failActions = getEl('upload-fail-actions');
        const failDetail = getEl('upload-fail-detail');
        const progressBar = getEl('upload-progress');

        if (spinner) spinner.style.display = failed ? 'none' : '';
        if (title) title.textContent = failed ? 'Upload failed — recording saved' : 'Finalizing transcript...';
        if (progressText) {
            progressText.style.display = failed ? 'none' : '';
            if (!failed) progressText.textContent = message || 'Saving your meeting. Almost done!';
        }
        if (progressBar && failed) progressBar.style.display = 'none';
        if (failActions) failActions.style.display = failed ? 'flex' : 'none';
        if (failDetail) failDetail.textContent = detail || '';
    }

    // ---------------------------------------------------------------------------
    // Overlay management
    // ---------------------------------------------------------------------------
    async function openOverlay({ resumeDraft = false } = {}) {
        overlay = overlay || getEl('recording-overlay');
        if (!overlay) return;
        if (resumeDraft) {
            overlay.classList.add('visible');
            return;
        }

        if (draftsAvailable()) {
            try {
                const draft = await window.RecordingDrafts.getDraft();
                if (draft && draft.audioBlob && draft.audioBlob.size >= 1000
                    && draft.status !== 'uploaded') {
                    const proceed = confirm(
                        'You have a saved recording that has not been uploaded yet.\n\n'
                        + 'OK = discard it and start a new recording\n'
                        + 'Cancel = keep it (use Retry Upload on the dashboard)'
                    );
                    if (!proceed) {
                        showDraftBanner(draft);
                        return;
                    }
                    await clearDraft();
                }
            } catch (err) {
                console.error('Draft check before record failed:', err);
            }
        }

        overlay.classList.add('visible');
        resetOverlayState({ keepDraft: true });
        startRecording();
    }

    function closeOverlay({ force = false } = {}) {
        if (!overlay) return;
        if (isRecording) {
            if (!confirm('Recording is in progress. Close anyway? The recording will be kept on this device if possible.')) return;
            persistDraft({ status: 'abandoned' });
        } else if (hasRecoverableDraft && !force) {
            // Keep draft; just hide overlay
        }
        stopEverything();
        overlay.classList.remove('visible');
        resetOverlayState({ keepDraft: true });
        checkPendingDraft();
    }

    function showState(stateName) {
        STATES.forEach(s => {
            const el = getEl(`state-${s}`);
            if (el) el.classList.remove('active');
        });
        const target = getEl(`state-${stateName}`);
        if (target) target.classList.add('active');
    }

    function resetOverlayState({ keepDraft = false } = {}) {
        stopEverything();
        audioChunks = [];
        allRecordedBlobs = [];
        transcriptSegments = [];
        timedSegments = [];
        chunkStartTime = 0;
        pendingTranscriptions = 0;
        chunkQueue = [];
        activeChunkJobs = 0;
        elapsedSeconds = 0;
        currentMeetingId = null;
        currentTranscript = null;
        selectedMeetingTypeId = null;
        titlePromise = null;
        lastUploadError = null;
        isRecording = false;
        if (getEl('recording-timer')) getEl('recording-timer').textContent = '00:00';
        if (getEl('live-transcript')) getEl('live-transcript').style.display = 'none';
        if (getEl('live-transcript-text')) getEl('live-transcript-text').textContent = '';
        if (getEl('transcription-status')) getEl('transcription-status').textContent = '';
        const progressBar = getEl('upload-progress');
        if (progressBar) { progressBar.style.display = 'none'; progressBar.value = 0; }
        setProcessingUi({ failed: false });
        STATES.forEach(s => {
            const el = getEl(`state-${s}`);
            if (el) el.classList.remove('active');
        });
        clearCanvas();
        if (!keepDraft) {
            // no-op: drafts cleared explicitly elsewhere
        }
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
            closeOverlay({ force: true });
            return;
        }

        // Web Audio visualization
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 128;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyserNode);
        drawWaveform();

        isRecording = true;
        chunkStartTime = 0;
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
        setProcessingUi({ failed: false });

        // Periodic chunk rotation for streaming transcription
        chunkRotateInterval = setInterval(() => {
            if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') {
                rotateRecorderSegment();
            }
        }, CHUNK_INTERVAL_MS);

        // Persist draft periodically so a crash mid-meeting isn't total loss
        draftSaveInterval = setInterval(() => {
            if (isRecording) persistDraft({ status: 'recording' });
        }, DRAFT_SAVE_INTERVAL_MS);

        window.addEventListener('beforeunload', beforeUnloadHandler);
        hideDraftBanner();
    }

    function getMimeType() {
        return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
    }

    function startRecorderSegment() {
        audioChunks = [];
        const mimeType = getMimeType();
        mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) {
                audioChunks.push(e.data);
                allRecordedBlobs.push(e.data);
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
            enqueueChunkTranscription(blob, offsetAtChunkStart);

            if (isRecording && stream) {
                startRecorderSegment();
            }
        };
        mediaRecorder.stop();
    }

    function enqueueChunkTranscription(blob, offsetSeconds) {
        if (blob.size < 500) return;
        chunkQueue.push({ blob, offsetSeconds });
        drainChunkQueue();
    }

    async function drainChunkQueue() {
        while (activeChunkJobs < MAX_CHUNK_CONCURRENCY && chunkQueue.length > 0) {
            const job = chunkQueue.shift();
            activeChunkJobs++;
            pendingTranscriptions++;
            updateTranscriptionStatus();
            // Intentionally not awaiting the whole queue — process with concurrency limit
            sendChunkForTranscription(job.blob, job.offsetSeconds)
                .catch(() => {})
                .finally(() => {
                    activeChunkJobs--;
                    pendingTranscriptions--;
                    updateTranscriptionStatus();
                    drainChunkQueue();
                });
        }
    }

    async function sendChunkForTranscription(blob, offsetSeconds) {
        const formData = new FormData();
        formData.append('audio', blob, 'chunk.webm');
        formData.append('format', 'webm');

        try {
            const data = await api('/api/recordings/transcribe-chunk', {
                method: 'POST',
                body: formData,
            });

            if (data.segments && data.segments.length) {
                for (const seg of data.segments) {
                    timedSegments.push({
                        start: seg.start + (offsetSeconds || 0),
                        end: seg.end + (offsetSeconds || 0),
                        text: seg.text,
                    });
                }
            }

            if (data.text && data.text.trim()) {
                transcriptSegments.push(data.text.trim());
                updateLiveTranscript();
            }
        } catch (err) {
            console.error('Chunk transcription failed:', err);
        }
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
        if (isRecording || hasRecoverableDraft) {
            // Best-effort sync persist is not possible for IndexedDB; warn user.
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
        clearInterval(draftSaveInterval);
        draftSaveInterval = null;
        cancelAnimationFrame(animFrameId);
        animFrameId = null;

        window.removeEventListener('beforeunload', beforeUnloadHandler);

        showState('processing');
        setProcessingUi({ failed: false, message: 'Finishing transcription...' });

        if (mediaRecorder && mediaRecorder.state === 'recording') {
            const finalChunks = audioChunks;
            audioChunks = [];
            const finalOffset = chunkStartTime;

            mediaRecorder.onstop = async () => {
                const mimeType = getMimeType();
                const blob = new Blob(finalChunks, { type: mimeType });

                if (blob.size >= 500) {
                    enqueueChunkTranscription(blob, finalOffset);
                }

                while (pendingTranscriptions > 0 || chunkQueue.length > 0 || activeChunkJobs > 0) {
                    await new Promise(r => setTimeout(r, 200));
                }

                if (audioContext) { audioContext.close(); audioContext = null; }

                await persistDraft({ status: 'pending_upload' });
                await createMeetingWithTranscript();
            };
            mediaRecorder.stop();
        } else {
            if (audioContext) { audioContext.close(); audioContext = null; }
            persistDraft({ status: 'pending_upload' }).then(() => createMeetingWithTranscript());
        }
    }

    // ---------------------------------------------------------------------------
    // Upload with progress tracking
    // ---------------------------------------------------------------------------
    function uploadWithProgress(formData, url = '/api/recordings/upload') {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            // Long recordings can take a while to transfer; don't abort early.
            xhr.timeout = 10 * 60 * 1000;

            const progressBar = getEl('upload-progress');
            const progressText = getEl('upload-progress-text');
            if (progressBar) {
                progressBar.style.display = 'block';
                progressBar.value = 0;
            }

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

            xhr.ontimeout = () => {
                if (progressBar) progressBar.style.display = 'none';
                if (progressText) progressText.textContent = '';
                reject(new Error('Upload timed out — your recording is still saved on this device'));
            };

            xhr.send(formData);
        });
    }

    function buildUploadFormData() {
        const mimeType = getMimeType();
        const audioBlob = new Blob(allRecordedBlobs, { type: mimeType });
        const fullTranscript = transcriptSegments.join('\n\n');

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
        return { formData, audioBlob, fullTranscript, mimeType };
    }

    async function createMeetingWithTranscript() {
        const fullTranscript = transcriptSegments.join('\n\n');
        const hasAudio = allRecordedBlobs.length > 0
            && new Blob(allRecordedBlobs).size >= 1000;

        if (!fullTranscript.trim() && !hasAudio) {
            showToast('No speech was detected and no audio was captured. Please try again.', 'error');
            setProcessingUi({
                failed: true,
                detail: 'Nothing was captured. You can close and record again.',
            });
            showState('processing');
            return;
        }

        if (!fullTranscript.trim() && hasAudio) {
            // Avoid server-side full-file Whisper on long recordings (timeout risk).
            // Keep the audio draft so the user can download / retry later.
            lastUploadError = 'Live transcription did not produce text. Your audio is saved on this device.';
            hasRecoverableDraft = true;
            await persistDraft({ status: 'upload_failed', lastError: lastUploadError });
            showToast(lastUploadError, 'error');
            setProcessingUi({ failed: true, detail: lastUploadError });
            showState('processing');
            return;
        }

        try {
            setProcessingUi({ failed: false, message: 'Uploading recording...' });
            const { formData } = buildUploadFormData();

            await persistDraft({ status: 'uploading' });
            const data = await uploadWithProgress(formData);

            currentMeetingId = data.meeting_id;
            currentTranscript = data.transcript || fullTranscript;
            lastUploadError = null;
            hasRecoverableDraft = false;
            await clearDraft();

            if (getEl('meeting-title-input')) getEl('meeting-title-input').value = '';

            const titleInput = getEl('meeting-title-input');
            const spinner = getEl('title-spinner');
            if (spinner) spinner.style.display = 'inline-flex';

            titlePromise = fetch('/api/recordings/generate-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meeting_id: currentMeetingId }),
            })
                .then(r => r.json())
                .then(result => {
                    if (result.title && titleInput && !titleInput.value.trim()) {
                        titleInput.value = result.title;
                    }
                    if (spinner) spinner.style.display = 'none';
                    return result.title || null;
                })
                .catch(err => {
                    console.error('AI title generation failed:', err);
                    if (spinner) spinner.style.display = 'none';
                    return null;
                });

            if (window.MeetingsModule && window.MeetingsModule.reload) {
                window.MeetingsModule.reload();
            }

            await loadMeetingTypes();
            showTranscriptPreview(currentTranscript);
            showState('type-select');
        } catch (err) {
            lastUploadError = err.message || 'Upload failed';
            hasRecoverableDraft = true;
            await persistDraft({ status: 'upload_failed', lastError: lastUploadError });
            showToast(`Failed to save meeting: ${err.message}`, 'error');
            setProcessingUi({
                failed: true,
                detail: err.message || 'Upload failed',
            });
            showState('processing');
        }
    }

    async function retryUpload() {
        setProcessingUi({ failed: false, message: 'Retrying upload...' });
        showState('processing');
        await createMeetingWithTranscript();
    }

    async function resumePendingDraft() {
        if (!draftsAvailable()) return;
        const draft = await window.RecordingDrafts.getDraft();
        if (!draft || !draft.audioBlob) {
            showToast('No saved recording found.', 'error');
            return;
        }

        overlay = overlay || getEl('recording-overlay');
        if (!overlay) return;

        resetOverlayState({ keepDraft: true });
        allRecordedBlobs = [draft.audioBlob];
        transcriptSegments = Array.isArray(draft.transcriptSegments)
            ? draft.transcriptSegments.slice()
            : (draft.transcript ? [draft.transcript] : []);
        timedSegments = Array.isArray(draft.timedSegments) ? draft.timedSegments.slice() : [];
        elapsedSeconds = draft.durationSeconds || 0;
        currentMeetingId = draft.meetingId || null;
        hasRecoverableDraft = true;
        lastUploadError = draft.lastError || null;

        overlay.classList.add('visible');
        hideDraftBanner();
        showState('processing');
        setProcessingUi({ failed: false, message: 'Retrying upload of saved recording...' });
        await createMeetingWithTranscript();
    }

    async function downloadCurrentOrDraft() {
        let blob = null;
        let mime = 'audio/webm';
        if (allRecordedBlobs.length) {
            mime = getMimeType();
            blob = new Blob(allRecordedBlobs, { type: mime });
        } else if (draftsAvailable()) {
            const draft = await window.RecordingDrafts.getDraft();
            if (draft && draft.audioBlob) {
                blob = draft.audioBlob;
                mime = draft.mimeType || mime;
            }
        }
        if (!blob || blob.size < 500) {
            showToast('No recording available to download.', 'error');
            return;
        }
        const ext = mime.includes('webm') ? 'webm' : 'audio';
        downloadBlob(blob, `voicenotes-recording-${Date.now()}.${ext}`);
        showToast('Recording downloaded to your device.', 'success');
    }

    async function discardPendingDraft() {
        if (!confirm('Discard the saved recording? This cannot be undone.')) return;
        await clearDraft();
        showToast('Saved recording discarded.', 'info');
    }

    function stopEverything() {
        isRecording = false;
        clearInterval(chunkRotateInterval);
        chunkRotateInterval = null;
        clearInterval(draftSaveInterval);
        draftSaveInterval = null;
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
        const titleInput = getEl('meeting-title-input');
        let userTitle = (titleInput || {}).value || '';
        const folderId = (getEl('folder-select') || {}).value || null;

        showState('summarizing');

        try {
            if (!userTitle && titlePromise) {
                const aiTitle = await titlePromise;
                if (aiTitle && titleInput && !titleInput.value.trim()) {
                    titleInput.value = aiTitle;
                }
                userTitle = (titleInput || {}).value || '';
            }

            await api('/api/recordings/summarize', {
                method: 'POST',
                body: {
                    meeting_id: currentMeetingId,
                    meeting_type_id: selectedMeetingTypeId,
                    title: userTitle || undefined,
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
    function bindEvents() {
        const stopBtn = getEl('stop-recording-btn');
        if (stopBtn) stopBtn.addEventListener('click', stopRecording);

        const closeBtn = getEl('overlay-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', () => closeOverlay());

        const genBtn = getEl('generate-summary-btn');
        if (genBtn) genBtn.addEventListener('click', generateSummary);

        const retryBtn = getEl('retry-upload-btn');
        if (retryBtn) retryBtn.addEventListener('click', retryUpload);

        const downloadBtn = getEl('download-recording-btn');
        if (downloadBtn) downloadBtn.addEventListener('click', downloadCurrentOrDraft);

        const dismissBtn = getEl('dismiss-failed-upload-btn');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', async () => {
                await persistDraft({ status: 'upload_failed', lastError: lastUploadError });
                hasRecoverableDraft = true;
                closeOverlay({ force: true });
                showToast('Recording kept on this device. Use the banner on the dashboard to retry.', 'info');
                checkPendingDraft();
            });
        }

        const resumeBtn = getEl('resume-draft-btn');
        if (resumeBtn) resumeBtn.addEventListener('click', resumePendingDraft);

        const downloadDraftBtn = getEl('download-draft-btn');
        if (downloadDraftBtn) downloadDraftBtn.addEventListener('click', downloadCurrentOrDraft);

        const discardBtn = getEl('discard-draft-btn');
        if (discardBtn) discardBtn.addEventListener('click', discardPendingDraft);

        checkPendingDraft();
    }

    document.addEventListener('DOMContentLoaded', bindEvents);

    // Public API
    return {
        openOverlay,
        closeOverlay,
        resumePendingDraft,
        checkPendingDraft,
    };
})();
