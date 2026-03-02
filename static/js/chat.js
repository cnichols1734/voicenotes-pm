/**
 * VoiceNotes PM - Chat module.
 * Provides streaming AI chat about a meeting's transcript and summary.
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

        if (input) {
            input.addEventListener('input', () => {
                autoGrow(input);
                sendBtn.disabled = !input.value.trim() || isStreaming;
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!sendBtn.disabled) sendMessage();
                }
            });
        }

        if (sendBtn) {
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
    // Send message (with SSE streaming)
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
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to send message');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';
            let buffer = '';

            contentEl.innerHTML = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Process complete SSE lines from buffer
                const lines = buffer.split('\n');
                // Keep the last potentially incomplete line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);

                    if (data === '[DONE]') continue;

                    fullText += data;
                    contentEl.innerHTML = formatMarkdown(fullText);
                    scrollToBottom();
                }
            }

            // Process any remaining buffer
            if (buffer.startsWith('data: ') && buffer.slice(6) !== '[DONE]') {
                fullText += buffer.slice(6);
                contentEl.innerHTML = formatMarkdown(fullText);
            }

            if (!fullText) {
                contentEl.innerHTML = '<span class="chat-error">No response received.</span>';
            }
        } catch (err) {
            console.error('Chat stream error:', err);
            contentEl.innerHTML = `<span class="chat-error">Error: ${escapeHtml(err.message)}</span>`;
        }

        isStreaming = false;
        if (sendBtn && input) sendBtn.disabled = !input.value.trim();
        scrollToBottom();
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
            showToast(`Failed to clear chat: ${err.message}`, 'error');
        }
    }

    // ---------------------------------------------------------------------------
    // UI helpers
    // ---------------------------------------------------------------------------
    function appendBubble(role, content) {
        const messagesEl = getEl('chat-messages');
        if (!messagesEl) return null;

        const row = document.createElement('div');
        row.className = `chat-bubble-row chat-bubble-row-${role}`;

        const bubble = document.createElement('div');
        bubble.className = `chat-bubble chat-bubble-${role}`;

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
        const maxHeight = 120; // ~4 lines
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }

    function hideEmpty() {
        const el = getEl('chat-empty');
        if (el) el.style.display = 'none';
    }

    function showEmpty() {
        const el = getEl('chat-empty');
        if (el) el.style.display = 'flex';
    }

    // ---------------------------------------------------------------------------
    // Simple markdown formatting
    // ---------------------------------------------------------------------------
    function formatMarkdown(text) {
        if (!text) return '';
        let html = escapeHtml(text);

        // Bold: **text**
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // Italic: *text*
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

        // Inline code: `text`
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Line breaks
        html = html.replace(/\n/g, '<br>');

        // Bullet lists: lines starting with - or *
        html = html.replace(/((?:^|<br>)(?:\s*[-*]\s+.+?)(?:<br>|$))+/g, (match) => {
            const items = match
                .split('<br>')
                .filter(line => line.trim().match(/^[-*]\s+/))
                .map(line => `<li>${line.trim().replace(/^[-*]\s+/, '')}</li>`)
                .join('');
            return items ? `<ul>${items}</ul>` : match;
        });

        return html;
    }

    return { init };
})();
