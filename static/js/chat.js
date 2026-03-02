/**
 * VoiceNotes PM - Chat module.
 * Provides streaming AI chat about a meeting's transcript and summary.
 * Compatible with Safari iOS (no lookbehind regex, ReadableStream fallback).
 */

window.ChatModule = (() => {
    let meetingId = null;
    let isStreaming = false;

    function getEl(id) { return document.getElementById(id); }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    async function init(id) {
        meetingId = id;

        // Show the chat tab button
        const tabBtn = getEl('chat-tab-btn');
        if (tabBtn) tabBtn.style.display = '';

        bindEvents();
        await loadHistory();
    }

    function bindEvents() {
        const input = getEl('chat-input');
        const sendBtn = getEl('chat-send-btn');
        const clearBtn = getEl('chat-clear-btn');

        if (input && sendBtn) {
            function updateSendState() {
                sendBtn.disabled = !input.value.trim() || isStreaming;
            }

            input.addEventListener('input', () => {
                autoGrow(input);
                updateSendState();
            });
            // iOS doesn't always fire 'input' reliably
            input.addEventListener('keyup', updateSendState);
            input.addEventListener('change', updateSendState);
            input.addEventListener('focus', updateSendState);
            // Also poll briefly after focus for iOS keyboard quirks
            input.addEventListener('focus', () => {
                setTimeout(updateSendState, 100);
                setTimeout(updateSendState, 500);
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!sendBtn.disabled) sendMessage();
                }
            });

            sendBtn.addEventListener('click', sendMessage);
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', clearChat);
        }

        // Suggestion buttons
        document.querySelectorAll('.chat-suggestion-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const suggestion = btn.dataset.suggestion;
                if (input) {
                    input.value = suggestion;
                    autoGrow(input);
                }
                sendMessage(suggestion);
            });
        });
    }

    // ---------------------------------------------------------------------------
    // Load history
    // ---------------------------------------------------------------------------
    async function loadHistory() {
        try {
            const data = await api(`/api/meetings/${meetingId}/chat`);
            const messages = data.messages || [];

            if (messages.length > 0) {
                hideEmpty();
                messages.forEach(msg => appendBubble(msg.role, msg.content));
                scrollToBottom();
            }
        } catch (err) {
            console.error('Failed to load chat history:', err);
        }
    }

    // ---------------------------------------------------------------------------
    // Parse SSE text into content chunks
    // ---------------------------------------------------------------------------
    function parseSSELines(text) {
        let result = '';
        const lines = text.split('\n');
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
                result += JSON.parse(data);
            } catch (e) {
                result += data;
            }
        }
        return result;
    }

    // ---------------------------------------------------------------------------
    // Send message (with SSE streaming + Safari fallback)
    // ---------------------------------------------------------------------------
    async function sendMessage(text) {
        const input = getEl('chat-input');
        const sendBtn = getEl('chat-send-btn');

        const message = text || (input ? input.value.trim() : '');
        if (!message || isStreaming) return;

        // Clear input
        if (input) {
            input.value = '';
            autoGrow(input);
        }
        if (sendBtn) sendBtn.disabled = true;

        isStreaming = true;
        hideEmpty();

        // Append user bubble
        appendBubble('user', message);
        scrollToBottom();

        // Create assistant bubble with typing indicator
        const assistantBubble = appendBubble('assistant', '');
        const contentEl = assistantBubble.querySelector('.chat-bubble-content');
        contentEl.innerHTML = '<div class="chat-typing"><span></span><span></span><span></span></div>';
        scrollToBottom();

        try {
            const response = await fetch(`/api/meetings/${meetingId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            });

            if (!response.ok) {
                let errMsg = 'Failed to send message';
                try {
                    const errData = await response.json();
                    errMsg = errData.error || errMsg;
                } catch (e) { /* ignore parse error */ }
                throw new Error(errMsg);
            }

            // Try streaming with ReadableStream (Chrome, Firefox, modern Safari)
            // Fall back to reading full response for older Safari
            let fullText = '';

            if (response.body && typeof response.body.getReader === 'function') {
                try {
                    fullText = await readStream(response, contentEl);
                } catch (streamErr) {
                    console.warn('Stream reading failed, trying fallback:', streamErr);
                    // Stream failed — fullText may be partial, try text fallback
                    if (!fullText) {
                        fullText = '';
                    }
                }
            }

            // Fallback: if streaming produced nothing, read as text
            if (!fullText) {
                try {
                    const text = await response.text();
                    fullText = parseSSELines(text);
                } catch (e) {
                    // response might already be consumed, that's ok if fullText has content
                }
            }

            if (fullText) {
                contentEl.innerHTML = formatMarkdown(fullText);
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
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        contentEl.innerHTML = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
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

        // Process remaining buffer
        if (buffer.startsWith('data: ') && buffer.slice(6) !== '[DONE]') {
            const remaining = buffer.slice(6);
            try {
                fullText += JSON.parse(remaining);
            } catch (e) {
                fullText += remaining;
            }
            contentEl.innerHTML = formatMarkdown(fullText);
        }

        return fullText;
    }

    // ---------------------------------------------------------------------------
    // Clear chat
    // ---------------------------------------------------------------------------
    async function clearChat() {
        if (!confirm('Clear chat history for this meeting?')) return;

        try {
            await api(`/api/meetings/${meetingId}/chat`, { method: 'DELETE' });
            const messagesEl = getEl('chat-messages');
            if (messagesEl) {
                messagesEl.querySelectorAll('.chat-bubble-row').forEach(el => el.remove());
            }
            showEmpty();
            showToast('Chat cleared.', 'success');
        } catch (err) {
            showToast('Failed to clear chat: ' + err.message, 'error');
        }
    }

    // ---------------------------------------------------------------------------
    // UI helpers
    // ---------------------------------------------------------------------------
    function appendBubble(role, content) {
        const messagesEl = getEl('chat-messages');
        if (!messagesEl) return null;

        const row = document.createElement('div');
        row.className = 'chat-bubble-row chat-bubble-row-' + role;

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble chat-bubble-' + role;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'chat-bubble-content';
        contentDiv.innerHTML = content ? formatMarkdown(content) : '';

        bubble.appendChild(contentDiv);
        row.appendChild(bubble);
        messagesEl.appendChild(row);

        return bubble;
    }

    function scrollToBottom() {
        const messagesEl = getEl('chat-messages');
        if (messagesEl) {
            requestAnimationFrame(() => {
                messagesEl.scrollTop = messagesEl.scrollHeight;
            });
        }
    }

    function autoGrow(textarea) {
        textarea.style.height = 'auto';
        var maxHeight = 120;
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }

    function hideEmpty() {
        var el = getEl('chat-empty');
        if (el) el.style.display = 'none';
    }

    function showEmpty() {
        var el = getEl('chat-empty');
        if (el) el.style.display = 'flex';
    }

    // ---------------------------------------------------------------------------
    // Markdown formatting (Safari-safe — no lookbehind regex)
    // ---------------------------------------------------------------------------
    function formatMarkdown(text) {
        if (!text) return '';

        var lines = text.split('\n');
        var html = '';
        var inList = false;

        for (var i = 0; i < lines.length; i++) {
            var line = escapeHtml(lines[i]);

            // Bold: **text** (process first so italic doesn't consume **)
            line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

            // Italic: *text* (simple — just single * pairs, after bold is already replaced)
            line = line.replace(/\*([^\*]+)\*/g, '<em>$1</em>');

            // Inline code: `text`
            line = line.replace(/`([^`]+)`/g, '<code>$1</code>');

            var bulletMatch = line.trim().match(/^[-]\s+(.*)/);
            if (!bulletMatch) {
                // Also check for * bullets (but not after bold/italic replacement)
                // Only match raw lines starting with "* " from the original text
                var rawTrimmed = escapeHtml(lines[i]).trim();
                if (rawTrimmed.match(/^\*\s+/)) {
                    bulletMatch = rawTrimmed.match(/^\*\s+(.*)/);
                    if (bulletMatch) {
                        // Re-apply formatting to the bullet content
                        var content = bulletMatch[1];
                        content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                        content = content.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
                        content = content.replace(/`([^`]+)`/g, '<code>$1</code>');
                        bulletMatch = [null, content];
                    }
                }
            }

            if (bulletMatch) {
                if (!inList) {
                    html += '<ul>';
                    inList = true;
                }
                html += '<li>' + bulletMatch[1] + '</li>';
            } else {
                if (inList) {
                    html += '</ul>';
                    inList = false;
                }

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

    return { init };
})();
