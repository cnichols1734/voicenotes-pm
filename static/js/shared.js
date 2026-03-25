/**
 * VoiceNotes PM - Shared meeting page.
 * Loads meeting data via public share API and provides ephemeral AI chat.
 * No authentication required -- all calls use the share UUID.
 */

(function () {
    'use strict';

    let chatHistory = [];
    let isStreaming = false;

    function getEl(id) { return document.getElementById(id); }

    // ---------------------------------------------------------------------------
    // Toast (self-contained for standalone page)
    // ---------------------------------------------------------------------------
    function showToast(message, type) {
        const container = getEl('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast ' + (type || 'info');
        toast.textContent = message;
        container.appendChild(toast);
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 350);
        }, 3500);
    }

    // ---------------------------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------------------------
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatDate(isoString) {
        if (!isoString) return '';
        const d = new Date(isoString);
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    function formatDuration(seconds) {
        if (!seconds) return '';
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return m + ':' + String(s).padStart(2, '0');
    }

    // ---------------------------------------------------------------------------
    // Load meeting data
    // ---------------------------------------------------------------------------
    async function loadMeeting() {
        const shareId = window.SHARE_ID;
        if (!shareId) return;

        try {
            const resp = await fetch('/api/share/' + shareId);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to load');
            }
            const data = await resp.json();
            renderMeeting(data.meeting, data.shared_by);
        } catch (err) {
            const loading = getEl('summary-loading');
            if (loading) loading.style.display = 'none';
            const empty = getEl('summary-empty');
            if (empty) {
                empty.style.display = 'flex';
                const title = empty.querySelector('.empty-state-title');
                if (title) title.textContent = 'Unable to load meeting';
            }
            console.error('Failed to load shared meeting:', err);
        }
    }

    function renderMeeting(meeting, sharedBy) {
        document.title = meeting.title + ' - VoiceNotez';

        const titleEl = getEl('meeting-title');
        if (titleEl) titleEl.textContent = meeting.title;

        // Meta badges
        const metaEl = getEl('meeting-meta');
        if (metaEl) {
            let html = '';
            if (meeting.meeting_type_name) {
                html += '<span class="badge badge-type">' + escapeHtml(meeting.meeting_type_name) + '</span>';
            }
            html += '<span class="badge-date">' + formatDate(meeting.recorded_at) + '</span>';
            if (meeting.duration_seconds) {
                html += '<span class="badge-date">' + formatDuration(meeting.duration_seconds) + '</span>';
            }
            metaEl.innerHTML = html;
        }

        // Shared by
        const sharedByEl = getEl('shared-by');
        if (sharedByEl && sharedBy) {
            sharedByEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Shared by ' + escapeHtml(sharedBy);
        }

        renderSummary(meeting.summary);
        renderTranscript(meeting.transcript);
    }

    // ---------------------------------------------------------------------------
    // Summary rendering
    // ---------------------------------------------------------------------------
    function renderSummary(summary) {
        const loadingEl = getEl('summary-loading');
        const contentEl = getEl('summary-content');
        const emptyEl = getEl('summary-empty');

        if (loadingEl) loadingEl.style.display = 'none';

        if (!summary) {
            if (emptyEl) emptyEl.style.display = 'flex';
            return;
        }
        if (contentEl) contentEl.style.display = 'block';

        // Executive summary
        const execEl = getEl('executive-summary-text');
        if (execEl && summary.executive_summary) {
            execEl.innerHTML = summary.executive_summary
                .split('\n').filter(Boolean)
                .map(function (p) { return '<p>' + escapeHtml(p) + '</p>'; }).join('');
        }

        // Action items
        const actionsEl = getEl('action-items-list');
        if (actionsEl && summary.action_items) {
            if (summary.action_items.length === 0) {
                actionsEl.innerHTML = '<p class="text-secondary">No action items recorded.</p>';
            } else {
                actionsEl.innerHTML = summary.action_items.map(function (item) {
                    var priorityLabel = item.priority ? item.priority.charAt(0).toUpperCase() + item.priority.slice(1) : '';
                    var priorityClass = item.priority ? ' priority-' + item.priority : '';
                    return '<div class="action-item">' +
                        '<div class="action-item-body">' +
                        '<div class="action-task">' + escapeHtml(item.task) + '</div>' +
                        '<div class="action-pills">' +
                        (item.owner ? '<span class="action-pill owner">@' + escapeHtml(item.owner) + '</span>' : '') +
                        (item.deadline ? '<span class="action-pill deadline">' + escapeHtml(item.deadline) + '</span>' : '') +
                        (item.priority ? '<span class="action-pill priority-pill' + priorityClass + '">' + priorityLabel + '</span>' : '') +
                        '</div></div></div>';
                }).join('');

                var countEl = getEl('action-items-count');
                if (countEl) {
                    countEl.textContent = summary.action_items.length + ' item' + (summary.action_items.length !== 1 ? 's' : '');
                    countEl.style.display = 'inline-block';
                }
            }
        }

        // Decisions
        var decisionsEl = getEl('decisions-list');
        if (decisionsEl && summary.decisions_made) {
            if (summary.decisions_made.length === 0) {
                decisionsEl.innerHTML = '<p class="text-secondary">No explicit decisions logged.</p>';
            } else {
                decisionsEl.innerHTML = summary.decisions_made.map(function (d) {
                    return '<div class="decision-card">' +
                        '<div class="decision-text">' + escapeHtml(d.decision) + '</div>' +
                        (d.context ? '<div class="decision-context">' + escapeHtml(d.context) + '</div>' : '') +
                        (d.decided_by ? '<div class="decision-by">Decided by: ' + escapeHtml(d.decided_by) + '</div>' : '') +
                        '</div>';
                }).join('');
            }
        }

        // Discussion points
        var discEl = getEl('discussion-list');
        if (discEl && summary.key_discussion_points) {
            discEl.innerHTML = (summary.key_discussion_points || [])
                .map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('')
                || '<li class="text-secondary">None recorded.</li>';
        }

        // Follow-ups
        var fuEl = getEl('followups-list');
        if (fuEl && summary.follow_ups) {
            fuEl.innerHTML = (summary.follow_ups || [])
                .map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('')
                || '<li class="text-secondary">None recorded.</li>';
        }
    }

    // ---------------------------------------------------------------------------
    // Transcript
    // ---------------------------------------------------------------------------
    function renderTranscript(transcript) {
        var contentEl = getEl('transcript-content');
        var emptyEl = getEl('transcript-empty');
        if (transcript) {
            if (contentEl) {
                contentEl.textContent = transcript;
                contentEl.style.display = 'block';
            }
            if (emptyEl) emptyEl.style.display = 'none';
        } else {
            if (contentEl) contentEl.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'flex';
        }
    }

    // ---------------------------------------------------------------------------
    // Tabs
    // ---------------------------------------------------------------------------
    function bindTabs() {
        document.querySelectorAll('.tab-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
                document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
                btn.classList.add('active');
                var panel = getEl('tab-' + btn.dataset.tab);
                if (panel) panel.classList.add('active');

                if (btn.dataset.tab === 'chat') {
                    var input = getEl('chat-input');
                    if (input) setTimeout(function () { input.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
                }
            });
        });
    }

    // ---------------------------------------------------------------------------
    // Ephemeral chat
    // ---------------------------------------------------------------------------
    function bindChat() {
        var input = getEl('chat-input');
        var sendBtn = getEl('chat-send-btn');

        if (!input || !sendBtn) return;

        function updateSendState() {
            sendBtn.disabled = !input.value.trim() || isStreaming;
        }

        input.addEventListener('input', function () {
            autoGrow(input);
            updateSendState();
        });
        input.addEventListener('keyup', updateSendState);
        input.addEventListener('focus', updateSendState);

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!sendBtn.disabled) sendMessage();
            }
        });

        sendBtn.addEventListener('click', function () { sendMessage(); });

        // Suggestion buttons
        document.querySelectorAll('.chat-suggestion-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var suggestion = btn.dataset.suggestion;
                if (input) {
                    input.value = suggestion;
                    autoGrow(input);
                }
                sendMessage(suggestion);
            });
        });
    }

    async function sendMessage(text) {
        var input = getEl('chat-input');
        var sendBtn = getEl('chat-send-btn');

        var message = text || (input ? input.value.trim() : '');
        if (!message || isStreaming) return;

        if (input) { input.value = ''; autoGrow(input); }
        if (sendBtn) sendBtn.disabled = true;

        isStreaming = true;
        hideEmpty();

        appendBubble('user', message);
        scrollToBottom();

        chatHistory.push({ role: 'user', content: message });

        var assistantBubble = appendBubble('assistant', '');
        var contentEl = assistantBubble.querySelector('.chat-bubble-content');
        contentEl.innerHTML = '<div class="chat-typing"><span></span><span></span><span></span></div>';
        scrollToBottom();

        try {
            var response = await fetch('/api/share/' + window.SHARE_ID + '/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message, history: chatHistory.slice(0, -1) }),
            });

            if (!response.ok) {
                var errData = await response.json().catch(function () { return {}; });
                throw new Error(errData.error || 'Failed to send message');
            }

            var fullText = '';

            if (response.body && typeof response.body.getReader === 'function') {
                fullText = await readStream(response, contentEl);
            }

            if (!fullText) {
                try {
                    var rawText = await response.text();
                    fullText = parseSSELines(rawText);
                } catch (e) { /* response may already be consumed */ }
            }

            if (fullText) {
                contentEl.innerHTML = formatMarkdown(fullText);
                chatHistory.push({ role: 'assistant', content: fullText });
            } else {
                contentEl.innerHTML = '<span class="chat-error">No response received.</span>';
            }
        } catch (err) {
            console.error('Chat error:', err);
            contentEl.innerHTML = '<span class="chat-error">Error: ' + escapeHtml(err.message) + '</span>';
        }

        isStreaming = false;
        if (sendBtn && input) sendBtn.disabled = !input.value.trim();
        scrollToBottom();
    }

    async function readStream(response, contentEl) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var buffer = '';

        contentEl.innerHTML = '';

        while (true) {
            var result = await reader.read();
            if (result.done) break;

            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.startsWith('data: ')) continue;
                var data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    fullText += JSON.parse(data);
                } catch (e) {
                    fullText += data;
                }
                contentEl.innerHTML = formatMarkdown(fullText);
                scrollToBottom();
            }
        }

        if (buffer.startsWith('data: ') && buffer.slice(6) !== '[DONE]') {
            var remaining = buffer.slice(6);
            try { fullText += JSON.parse(remaining); } catch (e) { fullText += remaining; }
            contentEl.innerHTML = formatMarkdown(fullText);
        }

        return fullText;
    }

    function parseSSELines(text) {
        var result = '';
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('data: ')) continue;
            var data = lines[i].slice(6);
            if (data === '[DONE]') continue;
            try { result += JSON.parse(data); } catch (e) { result += data; }
        }
        return result;
    }

    // ---------------------------------------------------------------------------
    // Markdown formatting (Safari-safe)
    // ---------------------------------------------------------------------------
    function formatMarkdown(text) {
        if (!text) return '';
        var lines = text.split('\n');
        var html = '';
        var inList = false;

        for (var i = 0; i < lines.length; i++) {
            var line = escapeHtml(lines[i]);
            line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            line = line.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
            line = line.replace(/`([^`]+)`/g, '<code>$1</code>');

            var bulletMatch = line.trim().match(/^[-]\s+(.*)/);
            if (!bulletMatch) {
                var rawTrimmed = escapeHtml(lines[i]).trim();
                if (rawTrimmed.match(/^\*\s+/)) {
                    bulletMatch = rawTrimmed.match(/^\*\s+(.*)/);
                    if (bulletMatch) {
                        var content = bulletMatch[1];
                        content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                        content = content.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
                        content = content.replace(/`([^`]+)`/g, '<code>$1</code>');
                        bulletMatch = [null, content];
                    }
                }
            }

            if (bulletMatch) {
                if (!inList) { html += '<ul>'; inList = true; }
                html += '<li>' + bulletMatch[1] + '</li>';
            } else {
                if (inList) { html += '</ul>'; inList = false; }
                if (line.trim() === '') {
                    html += '<br><br>';
                } else {
                    if (i > 0 && lines[i - 1].trim() !== '' && !lines[i - 1].trim().match(/^[-*]\s+/)) {
                        html += '<br>';
                    }
                    html += line;
                }
            }
        }
        if (inList) html += '</ul>';
        return html;
    }

    // ---------------------------------------------------------------------------
    // Chat UI helpers
    // ---------------------------------------------------------------------------
    function appendBubble(role, content) {
        var messagesEl = getEl('chat-messages');
        if (!messagesEl) return null;

        var row = document.createElement('div');
        row.className = 'chat-bubble-row chat-bubble-row-' + role;

        var bubble = document.createElement('div');
        bubble.className = 'chat-bubble chat-bubble-' + role;

        var contentDiv = document.createElement('div');
        contentDiv.className = 'chat-bubble-content';
        contentDiv.innerHTML = content ? formatMarkdown(content) : '';

        bubble.appendChild(contentDiv);
        row.appendChild(bubble);
        messagesEl.appendChild(row);
        return bubble;
    }

    function scrollToBottom() {
        var messagesEl = getEl('chat-messages');
        if (messagesEl) {
            requestAnimationFrame(function () { messagesEl.scrollTop = messagesEl.scrollHeight; });
        }
    }

    function autoGrow(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    function hideEmpty() {
        var el = getEl('chat-empty');
        if (el) el.style.display = 'none';
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', function () {
        bindTabs();
        bindChat();
        loadMeeting();
    });
})();
