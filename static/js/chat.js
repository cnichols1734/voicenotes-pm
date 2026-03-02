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
            function updateSendState() {
                if (sendBtn) sendBtn.disabled = !input.value.trim() || isStreaming;
            }

            input.addEventListener('input', () => {
                autoGrow(input);
                updateSendState();
            });
            // iOS doesn't always fire 'input' reliably — cover all bases
            input.addEventListener('keyup', updateSendState);
            input.addEventListener('change', updateSendState);
            input.addEventListener('focus', updateSendState);

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

                    // Chunks are JSON-encoded to preserve UTF-8
                    try {
                        fullText += JSON.parse(data);
                    } catch (e) {
                        fullText += data;
                    }
                    contentEl.innerHTML = formatMarkdown(fullText);
                    scrollToBottom();
                }
            }

            // Process any remaining buffer
            if (buffer.startsWith('data: ') && buffer.slice(6) !== '[DONE]') {
                const remaining = buffer.slice(6);
                try {
                    fullText += JSON.parse(remaining);
                } catch (e) {
                    fullText += remaining;
                }
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
    // Markdown formatting (line-by-line for reliable list handling)
    // ---------------------------------------------------------------------------
    function formatMarkdown(text) {
        if (!text) return '';

        const lines = text.split('\n');
        let html = '';
        let inList = false;

        for (let i = 0; i < lines.length; i++) {
            let line = escapeHtml(lines[i]);

            // Inline formatting
            line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
            line = line.replace(/`([^`]+)`/g, '<code>$1</code>');

            const isBullet = line.trim().match(/^[-*]\s+(.*)/);

            if (isBullet) {
                if (!inList) {
                    html += '<ul>';
                    inList = true;
                }
                html += `<li>${isBullet[1]}</li>`;
            } else {
                if (inList) {
                    html += '</ul>';
                    inList = false;
                }

                // Empty line = paragraph break
                if (line.trim() === '') {
                    html += '<br><br>';
                } else {
                    // Add line break between consecutive non-empty lines
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
