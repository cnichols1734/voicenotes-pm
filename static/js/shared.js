/**
 * VoiceNotes PM - Shared meeting page.
 * Loads meeting data via public share API and provides ephemeral AI chat.
 * No authentication required -- all calls use the share UUID.
 */

(function () {
    'use strict';

    let chatHistory = [];
    let isStreaming = false;
    let currentMeeting = null;

    // Presence & live-update polling
    let presenceInterval = null;
    let lastKnownUpdatedAt = null;
    const HEARTBEAT_INTERVAL_MS = 5000;
    const MAX_PRESENCE_BUBBLES = 4;

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

        var metaEl = getEl('meeting-meta');
        if (metaEl) {
            var html = '';
            if (meeting.meeting_type_name) {
                html += '<span class="badge badge-type">' + escapeHtml(meeting.meeting_type_name) + '</span>';
            }
            html += '<span class="badge-date">' + formatDate(meeting.recorded_at) + '</span>';
            if (meeting.duration_seconds) {
                html += '<span class="badge-date">' + formatDuration(meeting.duration_seconds) + '</span>';
            }
            metaEl.innerHTML = html;
        }

        var sharedByEl = getEl('shared-by');
        if (sharedByEl && sharedBy) {
            sharedByEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Shared by ' + escapeHtml(sharedBy);
        }

        currentMeeting = meeting;
        lastKnownUpdatedAt = meeting.updated_at || null;

        renderSummary(meeting.summary);
        renderTranscript(meeting.transcript);

        startPresencePolling();
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
        var actionsEl = getEl('action-items-list');
        if (actionsEl && summary.action_items) {
            renderSharedActionItems(actionsEl, summary);
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
    // Shared action items: checkbox, inline editing, add, history
    // ---------------------------------------------------------------------------
    var PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'];

    function formatDeadlineDisplay(raw) {
        if (!raw || raw === 'TBD') return 'Set date';
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            var parts = raw.split('-');
            var dt = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        return raw;
    }

    function renderSharedActionItems(actionsEl, summary) {
        if (!summary.action_items || summary.action_items.length === 0) {
            actionsEl.innerHTML = '<p class="text-secondary">No action items recorded.</p>';
            actionsEl.appendChild(buildSharedAddBtn());
            updateSharedCount(summary.action_items || []);
            return;
        }

        actionsEl.innerHTML = summary.action_items.map(function (item, idx) {
            var checked = item.completed ? ' checked' : '';
            var completedClass = item.completed ? ' completed' : '';
            var prio = item.priority || 'medium';
            var priorityLabel = prio.charAt(0).toUpperCase() + prio.slice(1);
            var priorityClass = ' priority-' + prio;
            return '<div class="action-item' + completedClass + '" data-index="' + idx + '">' +
                '<div class="action-checkbox' + checked + '" data-index="' + idx + '"></div>' +
                '<div class="action-item-body">' +
                '<div class="action-task">' + escapeHtml(item.task) + '</div>' +
                '<div class="action-pills">' +
                '<span class="action-pill owner">' +
                    '<span class="owner-text">' + (item.owner ? escapeHtml(item.owner) : 'Unassigned') + '</span></span>' +
                '<span class="action-pill deadline">' +
                    '<span class="deadline-text">' + formatDeadlineDisplay(item.deadline) + '</span></span>' +
                '<span class="action-pill priority-pill' + priorityClass + '">' +
                    '<span class="priority-text">' + priorityLabel + '</span></span>' +
                '</div></div>' +
                '<span class="action-item-hint">tap to edit &middot; hold to reorder</span>' +
                '</div>';
        }).join('');

        actionsEl.querySelectorAll('.action-checkbox').forEach(function (cb) {
            cb.addEventListener('click', function (e) {
                e.stopPropagation();
                var idx = parseInt(cb.dataset.index);
                var item = summary.action_items[idx];
                var newVal = !item.completed;
                item.completed = newVal;
                cb.classList.toggle('checked');
                cb.closest('.action-item').classList.toggle('completed');
                updateSharedCount(summary.action_items);
                patchSharedItem(item.id, { completed: newVal });
            });
        });

        initSharedInteractions(actionsEl, summary);

        actionsEl.appendChild(buildSharedAddBtn());
        buildSharedHistoryToggle(actionsEl);
        updateSharedCount(summary.action_items);
    }

    // -----------------------------------------------------------------------
    // Long-press to drag, tap to edit (shared view)
    // -----------------------------------------------------------------------
    var LONG_PRESS_MS = 400;
    var _sharedDndCleanup = null;

    function initSharedInteractions(container, summary) {
        if (_sharedDndCleanup) { _sharedDndCleanup(); _sharedDndCleanup = null; }

        var pressState = null;
        var dragState = null;

        function getActionItems() {
            return Array.from(container.querySelectorAll('.action-item'));
        }

        function getPointerY(e) {
            return e.clientY != null ? e.clientY : 0;
        }

        function getPointerX(e) {
            return e.clientX != null ? e.clientX : 0;
        }

        function createGhost(sourceEl, x, y) {
            var ghost = document.createElement('div');
            ghost.className = 'action-item-ghost';
            var task = sourceEl.querySelector('.action-task');
            if (task) ghost.textContent = task.textContent;
            var rect = sourceEl.getBoundingClientRect();
            ghost.style.width = rect.width + 'px';
            ghost.style.left = (x - rect.width / 2) + 'px';
            ghost.style.top = (y - 20) + 'px';
            document.body.appendChild(ghost);
            return ghost;
        }

        function createDropIndicator() {
            var ind = document.createElement('div');
            ind.className = 'action-items-drop-indicator';
            return ind;
        }

        function cancelPress() {
            if (pressState) {
                clearTimeout(pressState.timer);
                if (pressState.item) pressState.item.classList.remove('drag-ready');
                pressState = null;
            }
        }

        function startDrag(item, x, y) {
            var items = getActionItems();
            var fromIndex = items.indexOf(item);
            if (fromIndex === -1) return;

            var rects = items.map(function (el) { return el.getBoundingClientRect(); });

            dragState = {
                sourceEl: item,
                fromIndex: fromIndex,
                toIndex: fromIndex,
                ghost: createGhost(item, x, y),
                indicator: createDropIndicator(),
                rects: rects,
                items: items,
                active: true,
            };

            item.classList.remove('drag-ready');
            item.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.webkitUserSelect = 'none';
        }

        function onPointerDown(e) {
            if (dragState) return;
            var item = e.target.closest('.action-item');
            if (!item || item.classList.contains('editing')) return;
            if (e.target.closest('.action-checkbox')) return;

            var x = getPointerX(e);
            var y = getPointerY(e);

            pressState = {
                item: item,
                startX: x,
                startY: y,
                moved: false,
                timer: setTimeout(function () {
                    if (!pressState || pressState.moved) return;
                    item.classList.add('drag-ready');
                    if (navigator.vibrate) navigator.vibrate(30);
                    setTimeout(function () {
                        if (!pressState) return;
                        startDrag(item, pressState.startX, pressState.startY);
                        pressState = null;
                    }, 100);
                }, LONG_PRESS_MS),
            };
        }

        function onPointerMove(e) {
            if (pressState && !pressState.moved) {
                var dx = getPointerX(e) - pressState.startX;
                var dy = getPointerY(e) - pressState.startY;
                if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                    pressState.moved = true;
                    cancelPress();
                }
            }

            if (!dragState || !dragState.active) return;
            e.preventDefault();

            var y = getPointerY(e);
            var x = getPointerX(e);

            dragState.ghost.style.left = (x - parseInt(dragState.ghost.style.width) / 2) + 'px';
            dragState.ghost.style.top = (y - 20) + 'px';

            var newIndex = dragState.fromIndex;
            var items = dragState.items;
            for (var i = 0; i < items.length; i++) {
                var rect = dragState.rects[i];
                var mid = rect.top + rect.height / 2;
                if (y < mid) { newIndex = i; break; }
                newIndex = i + 1;
            }
            newIndex = Math.max(0, Math.min(newIndex, items.length));

            if (newIndex !== dragState.toIndex) {
                dragState.toIndex = newIndex;
                if (dragState.indicator.parentNode) dragState.indicator.remove();
                if (newIndex >= items.length) {
                    var lastItem = items[items.length - 1];
                    lastItem.parentNode.insertBefore(dragState.indicator, lastItem.nextSibling);
                } else {
                    items[newIndex].parentNode.insertBefore(dragState.indicator, items[newIndex]);
                }
            }

            items.forEach(function (el, i) {
                if (el === dragState.sourceEl) return;
                el.classList.remove('drag-over-above', 'drag-over-below');
                if (dragState.fromIndex < newIndex) {
                    if (i > dragState.fromIndex && i < newIndex) el.classList.add('drag-over-above');
                } else if (dragState.fromIndex > newIndex) {
                    if (i >= newIndex && i < dragState.fromIndex) el.classList.add('drag-over-below');
                }
            });
        }

        function onPointerUp() {
            var wasDragging = dragState && dragState.active;
            var wasPressed = pressState && !pressState.moved;

            if (dragState && dragState.active) {
                dragState.active = false;
                var sourceEl = dragState.sourceEl;
                var fromIndex = dragState.fromIndex;
                var toIndex = dragState.toIndex;
                var ghost = dragState.ghost;
                var indicator = dragState.indicator;
                var items = dragState.items;

                items.forEach(function (el) { el.classList.remove('drag-over-above', 'drag-over-below'); });
                sourceEl.classList.remove('dragging');
                ghost.remove();
                if (indicator.parentNode) indicator.remove();
                document.body.style.userSelect = '';
                document.body.style.webkitUserSelect = '';

                var finalTo = toIndex > fromIndex ? toIndex - 1 : toIndex;
                if (finalTo !== fromIndex && summary.action_items.length > 1) {
                    var moved = summary.action_items.splice(fromIndex, 1)[0];
                    summary.action_items.splice(finalTo, 0, moved);
                    renderSharedActionItems(container, summary);
                    saveSharedActionItemOrder(summary);
                }
                dragState = null;
            }

            if (wasPressed && !wasDragging) {
                var item = pressState.item;
                cancelPress();
                if (item && !item.classList.contains('editing')) {
                    var idx = parseInt(item.dataset.index);
                    if (!isNaN(idx)) openSharedEditMode(container, summary, idx);
                }
            } else {
                cancelPress();
            }
        }

        function onPointerCancel() {
            cancelPress();
            if (dragState && dragState.active) {
                dragState.active = false;
                dragState.items.forEach(function (el) { el.classList.remove('drag-over-above', 'drag-over-below'); });
                dragState.sourceEl.classList.remove('dragging', 'drag-ready');
                dragState.ghost.remove();
                if (dragState.indicator.parentNode) dragState.indicator.remove();
                document.body.style.userSelect = '';
                document.body.style.webkitUserSelect = '';
                dragState = null;
            }
        }

        var touchMoveHandler = function (e) {
            if (dragState && dragState.active) e.preventDefault();
        };

        container.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerCancel);
        container.addEventListener('touchmove', touchMoveHandler, { passive: false });

        _sharedDndCleanup = function () {
            container.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerCancel);
            container.removeEventListener('touchmove', touchMoveHandler);
        };
    }

    async function saveSharedActionItemOrder(summary) {
        var orderedIds = summary.action_items.map(function (item) { return item.id; }).filter(Boolean);
        if (orderedIds.length === 0) return;
        try {
            var resp = await fetch('/api/share/' + window.SHARE_ID + '/action-items/reorder', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ordered_ids: orderedIds }),
            });
            if (!resp.ok) throw new Error('Reorder failed');
        } catch (err) {
            console.error('Failed to save action item order:', err);
            showToast('Failed to save order.', 'error');
        }
    }

    function openSharedEditMode(actionsEl, summary, idx) {
        var item = summary.action_items[idx];
        var row = actionsEl.querySelector('.action-item[data-index="' + idx + '"]');
        if (!row || row.classList.contains('editing')) return;

        row.classList.add('editing');
        var editBtn = row.querySelector('.action-edit-btn');
        if (editBtn) editBtn.style.display = 'none';

        var body = row.querySelector('.action-item-body');
        var origHtml = body.innerHTML;

        var prio = item.priority || 'medium';
        var deadlineVal = (item.deadline && item.deadline !== 'TBD' && /^\d{4}-\d{2}-\d{2}$/.test(item.deadline)) ? item.deadline : '';

        body.innerHTML =
          '<div class="action-edit-form">' +
            '<div class="action-edit-field">' +
              '<label class="action-edit-label">Task</label>' +
              '<textarea class="action-edit-textarea" rows="2">' + escapeHtml(item.task) + '</textarea>' +
            '</div>' +
            '<div class="action-edit-row">' +
              '<div class="action-edit-field action-edit-field-half">' +
                '<label class="action-edit-label">Owner</label>' +
                '<input type="text" class="action-edit-input" value="' + escapeHtml(item.owner || '') + '" placeholder="Assign owner" data-field="owner" />' +
              '</div>' +
              '<div class="action-edit-field action-edit-field-half">' +
                '<label class="action-edit-label">Deadline</label>' +
                '<input type="date" class="action-edit-input action-edit-date" value="' + deadlineVal + '" data-field="deadline" />' +
              '</div>' +
            '</div>' +
            '<div class="action-edit-field">' +
              '<label class="action-edit-label">Priority</label>' +
              '<div class="action-edit-priority-row">' +
                PRIORITY_OPTIONS.map(function (opt) {
                    return '<button type="button" class="action-edit-priority-opt priority-' + opt + (opt === prio ? ' active' : '') + '" data-value="' + opt + '">' + opt.charAt(0).toUpperCase() + opt.slice(1) + '</button>';
                }).join('') +
              '</div>' +
            '</div>' +
            '<div class="action-edit-btns">' +
              '<button class="action-edit-cancel">Cancel</button>' +
              '<button class="action-edit-save"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Save</button>' +
            '</div>' +
          '</div>';

        var textarea = body.querySelector('.action-edit-textarea');
        function autoGrow() { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; }
        textarea.addEventListener('input', autoGrow);
        setTimeout(autoGrow, 0);

        var selectedPriority = prio;
        body.querySelectorAll('.action-edit-priority-opt').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                body.querySelectorAll('.action-edit-priority-opt').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                selectedPriority = btn.dataset.value;
            });
        });

        function closeEdit() {
            row.classList.remove('editing');
            body.innerHTML = origHtml;
            if (editBtn) editBtn.style.display = '';
        }

        body.querySelector('.action-edit-cancel').addEventListener('click', function (e) {
            e.stopPropagation();
            closeEdit();
        });

        body.querySelector('.action-edit-save').addEventListener('click', async function (e) {
            e.stopPropagation();
            var newTask = textarea.value.trim();
            var newOwner = body.querySelector('[data-field="owner"]').value.trim();
            var newDeadline = body.querySelector('[data-field="deadline"]').value;

            var updates = {};
            if (newTask && newTask !== item.task) { updates.task = newTask; item.task = newTask; }
            if (newOwner !== (item.owner || '')) { updates.owner = newOwner; item.owner = newOwner; }
            if (newDeadline !== (item.deadline || '')) { updates.deadline = newDeadline || ''; item.deadline = newDeadline || ''; }
            if (selectedPriority !== (item.priority || 'medium')) { updates.priority = selectedPriority; item.priority = selectedPriority; }

            var fields = Object.keys(updates);
            if (fields.length > 0) {
                for (var i = 0; i < fields.length; i++) {
                    var obj = {};
                    obj[fields[i]] = updates[fields[i]];
                    await patchSharedItem(item.id, obj);
                }
                renderSharedActionItems(actionsEl, summary);
                showToast('Action item saved.', 'success');
            } else {
                closeEdit();
            }
        });

        textarea.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); closeEdit(); }
        });
    }

    function buildSharedAddBtn() {
        var btn = document.createElement('button');
        btn.className = 'add-action-item-btn';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add action item';
        btn.addEventListener('click', async function () {
            if (!currentMeeting) return;
            try {
                var resp = await fetch('/api/share/' + window.SHARE_ID + '/action-items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ task: 'New action item', owner: '', deadline: '', priority: 'medium' }),
                });
                if (!resp.ok) throw new Error('Failed');
                var data = await resp.json();
                currentMeeting.summary = data.summary;
                var actionsEl = getEl('action-items-list');
                if (actionsEl) renderSharedActionItems(actionsEl, currentMeeting.summary);
                showToast('Action item added.', 'success');
            } catch (err) {
                showToast('Failed to add action item.', 'error');
            }
        });
        return btn;
    }

    async function patchSharedItem(itemId, updates) {
        if (!itemId) return;
        try {
            var resp = await fetch('/api/share/' + window.SHARE_ID + '/action-items/' + itemId, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            if (!resp.ok) throw new Error('Save failed');
        } catch (err) {
            console.error('Failed to save action item:', err);
            showToast('Failed to save changes.', 'error');
        }
    }

    function buildSharedHistoryToggle(container) {
        var toggle = document.createElement('button');
        toggle.className = 'action-history-toggle';
        toggle.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> View changes';
        var historyEl = null;
        var loaded = false;

        toggle.addEventListener('click', async function () {
            if (historyEl && historyEl.style.display !== 'none') {
                historyEl.style.display = 'none';
                toggle.classList.remove('active');
                return;
            }
            if (!historyEl) {
                historyEl = document.createElement('div');
                historyEl.className = 'action-history-list';
                container.appendChild(historyEl);
            }
            historyEl.style.display = 'block';
            toggle.classList.add('active');

            if (!loaded) {
                historyEl.innerHTML = '<div class="action-history-loading">Loading...</div>';
                try {
                    var resp = await fetch('/api/share/' + window.SHARE_ID + '/action-items/history');
                    if (!resp.ok) throw new Error('Failed');
                    var data = await resp.json();
                    renderSharedHistory(historyEl, data.history || []);
                    loaded = true;
                } catch (err) {
                    historyEl.innerHTML = '<div class="action-history-empty">Failed to load history.</div>';
                }
            }
        });
        container.appendChild(toggle);
    }

    function renderSharedHistory(el, entries) {
        if (!entries.length) {
            el.innerHTML = '<div class="action-history-empty">No changes yet.</div>';
            return;
        }
        el.innerHTML = entries.map(function (e) {
            var isUser = e.changed_by_type === 'user';
            var dotClass = isUser ? 'history-dot-user' : 'history-dot-shared';
            var name = e.changed_by_name || (isUser ? 'User' : 'Shared link user');
            var time = new Date(e.created_at).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
            });
            var desc = '';
            if (e.field_changed === 'created') {
                desc = 'added "' + escapeHtml(e.new_value || '') + '"';
            } else if (e.field_changed === 'completed') {
                desc = e.new_value === 'True' ? 'marked as done' : 'marked as not done';
            } else {
                desc = 'changed ' + e.field_changed;
                if (e.old_value) desc += ' from "' + escapeHtml(e.old_value) + '"';
                desc += ' to "' + escapeHtml(e.new_value || '') + '"';
            }
            return '<div class="action-history-entry">' +
                '<span class="history-dot ' + dotClass + '"></span>' +
                '<span class="history-name">' + escapeHtml(name) + '</span>' +
                '<span class="history-desc">' + desc + '</span>' +
                '<span class="history-time">' + time + '</span>' +
                '</div>';
        }).join('');
    }

    function updateSharedCount(actionItems) {
        var countEl = getEl('action-items-count');
        if (!countEl || !actionItems) return;
        var done = actionItems.filter(function (i) { return i.completed; }).length;
        var total = actionItems.length;
        if (total > 0) {
            countEl.textContent = done + '/' + total + ' done';
            countEl.style.display = 'inline-block';
        } else {
            countEl.style.display = 'none';
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
    // Presence polling & live updates
    // ---------------------------------------------------------------------------
    function getSharedViewerId() {
        var key = 'voicenotes_viewer_id';
        var id = sessionStorage.getItem(key);
        if (!id) {
            id = 'sv_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            sessionStorage.setItem(key, id);
        }
        return id;
    }

    function startPresencePolling() {
        if (presenceInterval) clearInterval(presenceInterval);
        sendSharedHeartbeat();
        presenceInterval = setInterval(sendSharedHeartbeat, HEARTBEAT_INTERVAL_MS);

        window.addEventListener('beforeunload', function () {
            clearInterval(presenceInterval);
            var shareId = window.SHARE_ID;
            var viewerId = getSharedViewerId();
            var url = '/api/share/' + shareId + '/presence/leave';
            var body = JSON.stringify({ viewer_id: viewerId });
            if (navigator.sendBeacon) {
                navigator.sendBeacon(url, body);
            } else {
                fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
            }
        });
    }

    async function sendSharedHeartbeat() {
        var shareId = window.SHARE_ID;
        if (!shareId) return;
        var viewerId = getSharedViewerId();
        try {
            var resp = await fetch('/api/share/' + shareId + '/presence/heartbeat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ viewer_id: viewerId, display_name: 'Guest' }),
            });
            if (!resp.ok) return;
            var data = await resp.json();
            renderPresenceBubbles(data.viewers || []);

            if (lastKnownUpdatedAt && data.meeting_updated_at && data.meeting_updated_at !== lastKnownUpdatedAt) {
                lastKnownUpdatedAt = data.meeting_updated_at;
                await refreshSharedMeetingData();
            }
        } catch (_) {
            // Non-critical
        }
    }

    async function refreshSharedMeetingData() {
        var shareId = window.SHARE_ID;
        if (!shareId) return;
        try {
            var resp = await fetch('/api/share/' + shareId);
            if (!resp.ok) return;
            var data = await resp.json();
            var meeting = data.meeting;
            currentMeeting = meeting;
            lastKnownUpdatedAt = meeting.updated_at || null;

            var titleEl = getEl('meeting-title');
            if (titleEl && titleEl.textContent !== meeting.title) {
                titleEl.textContent = meeting.title;
            }

            renderSummary(meeting.summary);
            renderTranscript(meeting.transcript);

            showUpdateFlash();
        } catch (_) {
            // Non-critical
        }
    }

    function showUpdateFlash() {
        var container = getEl('presence-bubbles');
        if (!container) return;
        var existing = container.querySelector('.presence-update-dot');
        if (existing) existing.remove();
        var dot = document.createElement('div');
        dot.className = 'presence-update-dot';
        container.appendChild(dot);
        dot.addEventListener('animationend', function () { dot.remove(); });
    }

    function renderPresenceBubbles(viewers) {
        var container = getEl('presence-bubbles');
        if (!container) return;

        var shown = viewers.slice(0, MAX_PRESENCE_BUBBLES);
        var overflow = viewers.length - shown.length;

        var currentIds = {};
        shown.forEach(function (v) { currentIds[v.viewer_id] = true; });
        container.querySelectorAll('.presence-bubble').forEach(function (el) {
            if (!currentIds[el.dataset.viewerId]) el.remove();
        });
        var overflowEl = container.querySelector('.presence-viewer-count');
        if (overflowEl && overflow <= 0) overflowEl.remove();

        shown.forEach(function (viewer) {
            var bubble = container.querySelector('.presence-bubble[data-viewer-id="' + viewer.viewer_id + '"]');
            if (!bubble) {
                bubble = document.createElement('div');
                bubble.className = 'presence-bubble';
                bubble.dataset.viewerId = viewer.viewer_id;
                var tooltip = document.createElement('span');
                tooltip.className = 'presence-tooltip';
                bubble.appendChild(tooltip);
                var updateDot = container.querySelector('.presence-update-dot');
                if (updateDot) {
                    container.insertBefore(bubble, updateDot);
                } else {
                    container.appendChild(bubble);
                }
            }
            bubble.style.backgroundColor = viewer.color;
            bubble.childNodes[0].textContent = viewer.initials;
            bubble.querySelector('.presence-tooltip').textContent = viewer.display_name;
        });

        if (overflow > 0) {
            var countEl = container.querySelector('.presence-viewer-count');
            if (!countEl) {
                countEl = document.createElement('div');
                countEl.className = 'presence-viewer-count';
                var updateDot = container.querySelector('.presence-update-dot');
                if (updateDot) {
                    container.insertBefore(countEl, updateDot);
                } else {
                    container.appendChild(countEl);
                }
            }
            countEl.textContent = '+' + overflow;
        }
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
