/**
 * VoiceNotes PM - Meetings module.
 * Manages meeting list rendering, search, sort, inline title editing, and detail page.
 */

window.MeetingsModule = (() => {
    let allMeetings = [];
    let currentMeeting = null;
    let openSwipeRow = null;
    let fetchGeneration = 0;
    let searchDebounceTimer = null;
    const SEARCH_DEBOUNCE_MS = 320;

    // Presence & live-update polling state
    let presenceInterval = null;
    let lastKnownUpdatedAt = null;
    const HEARTBEAT_INTERVAL_MS = 5000;
    const MAX_PRESENCE_BUBBLES = 4;

    // Comments polling state
    let commentsInterval = null;
    let lastKnownCommentId = null;
    let currentUserId = null;
    const COMMENTS_POLL_MS = 5000;

    function getEl(id) { return document.getElementById(id); }

    // ---------------------------------------------------------------------------
    // Dashboard: init + reload
    // ---------------------------------------------------------------------------
    async function init() {
        bindDashboardEvents();
        await reload();
    }

    async function reload() {
        const state = window.AppState;
        const params = new URLSearchParams();
        if (state.currentFolderFilter) params.set('folder_id', state.currentFolderFilter);
        if (state.currentTypeFilter) params.set('meeting_type_id', state.currentTypeFilter);
        const q = (state.searchQuery || '').trim();
        if (q) params.set('q', q);

        const gen = ++fetchGeneration;
        try {
            const data = await api(`/api/recordings?${params.toString()}`);
            if (gen !== fetchGeneration) return;

            allMeetings = data.meetings || [];

            // Sidebar total should not shrink while searching (list is filtered server-side)
            const countEl = getEl('all-meetings-count');
            if (countEl && !q) countEl.textContent = allMeetings.length;

            renderMeetings(allMeetings);
        } catch (err) {
            if (gen !== fetchGeneration) return;
            console.error('Failed to load meetings:', err);
            showToast('Failed to load meetings.', 'error');
        }
    }

    function scheduleReloadForSearch() {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            searchDebounceTimer = null;
            reload();
        }, SEARCH_DEBOUNCE_MS);
    }

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------
    function renderMeetings(meetings) {
        const list = getEl('meetings-list');
        const loading = getEl('meetings-loading');
        const empty = getEl('meetings-empty');
        if (!list) return;

        if (loading) loading.style.display = 'none';

        // Reset any open swipe row tracker
        openSwipeRow = null;

        // Remove existing cards
        list.querySelectorAll('.swipe-row').forEach(el => el.remove());

        // Search is server-side (title + transcript); this list is already filtered.
        const sort = window.AppState.sortOrder;
        const sorted = [...meetings].sort((a, b) => {
            if (sort === 'oldest') return new Date(a.recorded_at) - new Date(b.recorded_at);
            if (sort === 'alpha') return a.title.localeCompare(b.title);
            return new Date(b.recorded_at) - new Date(a.recorded_at); // newest first (default)
        });

        if (sorted.length === 0) {
            if (empty) {
                const q = (window.AppState.searchQuery || '').trim();
                const titleEl = empty.querySelector('.empty-state-title');
                const descEl = empty.querySelector('.empty-state-desc');
                if (q && titleEl && descEl) {
                    titleEl.textContent = 'No matches';
                    descEl.textContent = 'Try different words or clear the search box.';
                } else if (titleEl && descEl) {
                    titleEl.textContent = 'No meetings yet';
                    descEl.textContent = 'Hit the record button to capture your first meeting.';
                }
                empty.style.display = 'flex';
            }
            return;
        }
        if (empty) empty.style.display = 'none';

        const types = window.AppState.meetingTypes || [];
        sorted.forEach(meeting => {
            const row = buildMeetingCard(meeting, types);
            list.appendChild(row);
        });

        if (window.lucide) lucide.createIcons();
    }

    function buildMeetingCard(meeting, types) {
        const type = types.find(t => t.id === meeting.meeting_type_id);
        const folders = window.AppState.folders || [];
        const folder = folders.find(f => f.id === meeting.folder_id);
        const summary = meeting.summary || {};
        const q = (window.AppState.searchQuery || '').trim();

        // Title: highlight matches when searching
        const titleHtml = q ? highlightText(meeting.title, q) : escapeHtml(meeting.title);

        // Preview: prefer transcript snippet (transcript-only match) over exec summary
        let previewHtml = '';
        if (meeting.search_snippet) {
            // Transcript hit — show excerpt with ellipsis and a subtle label
            previewHtml = `
              <div class="meeting-card-preview meeting-card-preview--snippet">
                <span class="snippet-label">transcript</span>…${highlightText(meeting.search_snippet, q)}…
              </div>`;
        } else {
            const exec = summary.executive_summary
                ? (summary.executive_summary.length > 120
                    ? summary.executive_summary.slice(0, 120) + '…'
                    : summary.executive_summary)
                : '';
            if (exec) {
                previewHtml = `<div class="meeting-card-preview">${q ? highlightText(exec, q) : escapeHtml(exec)}</div>`;
            }
        }

        // ── Swipe wrapper ────────────────────────────────────────────────────
        const wrapper = document.createElement('div');
        wrapper.className = 'swipe-row';

        // Red delete background (revealed by swiping left)
        const deleteBg = document.createElement('div');
        deleteBg.className = 'swipe-delete-bg';
        deleteBg.innerHTML = `
          <button class="swipe-delete-reveal-btn" aria-label="Delete meeting">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                 stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
            Delete
          </button>`;

        // ── The card itself ──────────────────────────────────────────────────
        const card = document.createElement('div');
        card.className = 'meeting-card';
        card.dataset.meetingId = meeting.id;

        const typeBadge = type ? `<span class="badge badge-type"><i data-lucide="${type.icon || 'file-text'}"></i> ${type.name}</span>` : '';
        const folderBadge = folder ? `<span class="badge badge-folder"><i data-lucide="folder"></i> ${escapeHtml(folder.name)}</span>` : '';

        card.innerHTML = `
          <div class="meeting-card-body">
            <div class="meeting-card-header">
              <div class="meeting-card-title">${titleHtml}</div>
            </div>
            <div class="meeting-card-meta">
              ${typeBadge}${folderBadge}
              <span class="badge-date">${formatDate(meeting.recorded_at)}</span>
              ${meeting.duration_seconds ? `<span class="badge-date">${formatDuration(meeting.duration_seconds)}</span>` : ''}
            </div>
            ${previewHtml}
          </div>
          <div class="meeting-card-actions">
            <button class="card-action-btn card-move-btn" title="Move to folder">
              <i data-lucide="folder-input"></i>
            </button>
            <button class="card-action-btn card-delete-btn" title="Delete meeting">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>`;

        // Navigate to detail — unified touch + mouse handler
        const body = card.querySelector('.meeting-card-body');
        addTapHandler(body, wrapper, card, `/meeting/${meeting.id}`);

        // Move-to-folder button
        card.querySelector('.card-move-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openMoveModal(meeting);
        });

        // Desktop / tablet delete button
        card.querySelector('.card-delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            confirmDeleteMeeting(meeting.id, wrapper);
        });

        // Swipe reveal delete button
        deleteBg.querySelector('.swipe-delete-reveal-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            confirmDeleteMeeting(meeting.id, wrapper);
        });

        // ── Touch swipe handler ──────────────────────────────────────────────
        addSwipeHandler(wrapper, card, meeting.id);

        wrapper.appendChild(deleteBg);
        wrapper.appendChild(card);
        return wrapper;
    }

    // ── Tap handler (bypasses iOS sticky-hover / double-tap issue) ─────────
    function addTapHandler(el, wrapper, card, href) {
        let tapStartX = 0, tapStartY = 0, tapStartTime = 0;

        el.addEventListener('touchstart', (e) => {
            tapStartX = e.touches[0].clientX;
            tapStartY = e.touches[0].clientY;
            tapStartTime = Date.now();
        }, { passive: true });

        el.addEventListener('touchend', (e) => {
            const dx = e.changedTouches[0].clientX - tapStartX;
            const dy = e.changedTouches[0].clientY - tapStartY;
            const elapsed = Date.now() - tapStartTime;

            // Only count as a tap: <300ms, <10px movement
            if (elapsed > 300 || Math.abs(dx) > 10 || Math.abs(dy) > 10) return;

            e.preventDefault(); // prevent the synthetic click / iOS hover dance

            if (wrapper.classList.contains('swipe-open')) {
                snapSwipeClose(wrapper, card);
                return;
            }
            if (openSwipeRow) {
                snapSwipeClose(openSwipeRow, openSwipeRow.querySelector('.meeting-card'));
            }
            window.location.href = href;
        });

        // Keep mouse click for desktop
        el.addEventListener('click', (e) => {
            if (wrapper.classList.contains('swipe-open')) {
                snapSwipeClose(wrapper, card);
                e.preventDefault();
                return;
            }
            if (openSwipeRow) {
                snapSwipeClose(openSwipeRow, openSwipeRow.querySelector('.meeting-card'));
            }
            window.location.href = href;
        });
    }

    // ── Swipe-to-delete helpers ──────────────────────────────────────────────
    const SWIPE_REVEAL = 84;     // px to reveal the delete button
    const SWIPE_COMMIT = 160;    // px to auto-trigger delete without confirmation

    function addSwipeHandler(wrapper, card, meetingId) {
        let startX = 0, startY = 0, currentDx = 0;
        let didSwipe = false;   // true only once horizontal movement exceeds dead zone
        let decided = false;    // true once we know if gesture is horizontal or vertical

        card.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentDx = 0;
            didSwipe = false;
            decided = false;
        }, { passive: true });

        card.addEventListener('touchmove', (e) => {
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;

            // Wait until finger moves enough to decide direction
            if (!decided) {
                if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
                decided = true;
                if (Math.abs(dy) >= Math.abs(dx)) return; // vertical scroll — bail out
                // Horizontal: close any other open row and start tracking
                if (openSwipeRow && openSwipeRow !== wrapper) {
                    snapSwipeClose(openSwipeRow, openSwipeRow.querySelector('.meeting-card'));
                }
                didSwipe = true;
                wrapper.classList.add('is-swiping');
            }

            if (!didSwipe) return;

            e.preventDefault();
            currentDx = Math.min(0, dx);
            card.style.transform = `translateX(${currentDx}px)`;

            if (Math.abs(currentDx) >= SWIPE_REVEAL) {
                wrapper.classList.add('swipe-open');
                openSwipeRow = wrapper;
            } else {
                wrapper.classList.remove('swipe-open');
            }
        }, { passive: false });

        card.addEventListener('touchend', () => {
            wrapper.classList.remove('is-swiping');

            // Pure tap (no horizontal swipe) — do nothing, let click handler navigate
            if (!didSwipe) return;

            if (Math.abs(currentDx) >= SWIPE_COMMIT) {
                card.style.transform = `translateX(-${SWIPE_REVEAL}px)`;
                wrapper.classList.add('swipe-open');
                openSwipeRow = wrapper;
                confirmDeleteMeeting(meetingId, wrapper);
            } else if (Math.abs(currentDx) >= SWIPE_REVEAL) {
                card.style.transform = `translateX(-${SWIPE_REVEAL}px)`;
                wrapper.classList.add('swipe-open');
                openSwipeRow = wrapper;
            } else {
                snapSwipeClose(wrapper, card);
            }
        }, { passive: true });
    }

    function snapSwipeClose(wrapper, card) {
        if (!wrapper || !card) return;
        card.style.transform = '';
        wrapper.classList.remove('swipe-open', 'swipe-committing');
        if (openSwipeRow === wrapper) openSwipeRow = null;
    }

    function confirmDeleteMeeting(meetingId, wrapper) {
        // Close swipe if open so the modal appears cleanly
        if (wrapper) snapSwipeClose(wrapper, wrapper.querySelector('.meeting-card'));

        window.showConfirmModal({
            title: 'Delete Meeting?',
            message: 'This meeting and its summary will be permanently removed.',
            confirmText: 'Delete',
            isDanger: true,
            onConfirm: () => executeDeleteMeeting(meetingId, wrapper),
        });
    }

    async function executeDeleteMeeting(meetingId, wrapper) {
        if (wrapper) {
            // Measure height before adding transitions
            const h = wrapper.offsetHeight;
            const card = wrapper.querySelector('.meeting-card');

            // Slide card out to the left
            if (card) card.style.transform = `translateX(-110%)`;

            // Short delay then collapse the row height
            setTimeout(() => {
                wrapper.classList.add('swipe-committing');
                wrapper.style.maxHeight = h + 'px';
                // Double rAF ensures start value is painted before end value is set
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    wrapper.style.maxHeight = '0';
                    wrapper.style.opacity = '0';
                    wrapper.style.marginBottom = '0';
                }));
            }, 80);
        }

        try {
            await api(`/api/recordings/${meetingId}`, { method: 'DELETE' });
            showToast('Meeting deleted.', 'success');
            allMeetings = allMeetings.filter(m => m.id !== meetingId);
            setTimeout(() => {
                if (wrapper) wrapper.remove();
                // Show empty state if no more meetings
                const list = getEl('meetings-list');
                const empty = getEl('meetings-empty');
                if (list && !list.querySelectorAll('.swipe-row').length && empty) {
                    empty.style.display = 'flex';
                }
            }, 430);
        } catch (err) {
            showToast(`Failed to delete: ${err.message}`, 'error');
            // Revert the animation
            if (wrapper) {
                wrapper.style.maxHeight = '';
                wrapper.style.opacity = '';
                wrapper.style.marginBottom = '';
                wrapper.classList.remove('swipe-committing');
                const card = wrapper.querySelector('.meeting-card');
                if (card) card.style.transform = '';
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Move-to-folder modal (dashboard)
    // ---------------------------------------------------------------------------
    function openMoveModal(meeting) {
        let modal = document.getElementById('move-folder-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'move-folder-modal';
            modal.className = 'modal-backdrop';
            modal.innerHTML = `
              <div class="modal" style="max-width:400px;">
                <div class="modal-header">
                  <h3 class="modal-title">Move to Folder</h3>
                  <button class="modal-close" id="move-modal-close">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <div class="modal-body">
                  <div class="move-folder-list" id="move-folder-list"></div>
                </div>
              </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('#move-modal-close').addEventListener('click', () => {
                modal.classList.remove('visible');
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.remove('visible');
            });
        }

        const list = modal.querySelector('#move-folder-list');
        const folders = window.AppState.folders || [];
        list.innerHTML = '';

        // "No Folder" option
        const noFolderBtn = document.createElement('button');
        noFolderBtn.className = `move-folder-option ${!meeting.folder_id ? 'active' : ''}`;
        noFolderBtn.innerHTML = `<i data-lucide="inbox"></i><span>No Folder</span>`;
        noFolderBtn.addEventListener('click', () => moveMeetingToFolder(meeting.id, null, modal));
        list.appendChild(noFolderBtn);

        folders.forEach(f => {
            const btn = document.createElement('button');
            btn.className = `move-folder-option ${meeting.folder_id === f.id ? 'active' : ''}`;
            btn.innerHTML = `<span class="move-folder-dot" style="background:${f.color};"></span><span>${escapeHtml(f.name)}</span>`;
            btn.addEventListener('click', () => moveMeetingToFolder(meeting.id, f.id, modal));
            list.appendChild(btn);
        });

        modal.classList.add('visible');
        if (window.lucide) lucide.createIcons();
    }

    async function moveMeetingToFolder(meetingId, folderId, modal) {
        try {
            await api(`/api/recordings/${meetingId}`, {
                method: 'PUT',
                body: { folder_id: folderId },
            });
            modal.classList.remove('visible');
            showToast('Moved to folder.', 'success');
            await reload();
        } catch (err) {
            showToast(`Failed: ${err.message}`, 'error');
        }
    }

    // ---------------------------------------------------------------------------
    // Dashboard event binding
    // ---------------------------------------------------------------------------
    function bindDashboardEvents() {
        const searchInput = getEl('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                window.AppState.searchQuery = searchInput.value;
                scheduleReloadForSearch();
            });
        }

        const sortSelect = getEl('sort-select');
        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                window.AppState.sortOrder = sortSelect.value;
                renderMeetings(allMeetings);
            });
        }
    }

    // ---------------------------------------------------------------------------
    // Detail page
    // ---------------------------------------------------------------------------
    async function initDetail() {
        const meetingId = window.MEETING_ID;
        if (!meetingId) return;

        try {
            const [meetingData, typesData, foldersData] = await Promise.all([
                api(`/api/recordings/${meetingId}`),
                api('/api/meeting-types'),
                api('/api/folders'),
            ]);

            const meeting = meetingData.meeting;
            currentMeeting = meeting;
            currentUserId = meeting.user_id;
            lastKnownUpdatedAt = meeting.updated_at;
            const types = typesData.meeting_types || [];
            const folders = foldersData.folders || [];

            window.AppState.meetingTypes = types;
            window.AppState.folders = folders;

            renderDetailHeader(meeting, types, folders);
            renderSummary(meeting.summary);
            renderTranscript(meeting.transcript);
            populateDetailFolderSelect(folders, meeting.folder_id);
            populateResurfaceGrid(types);

            if (meeting.status === 'complete' && window.ChatModule) {
                window.ChatModule.init(meetingId);
            }

            startPresencePolling(meetingId);
            initComments(meetingId);
            alignCommentsPanel();
        } catch (err) {
            showToast(`Failed to load meeting: ${err.message}`, 'error');
        }

        bindDetailEvents();
    }

    function renderDetailHeader(meeting, types, folders) {
        const titleEl = getEl('meeting-title');
        const breadcrumb = getEl('breadcrumb-title');
        const metaEl = getEl('meeting-meta');

        if (titleEl) titleEl.textContent = meeting.title;
        if (breadcrumb) breadcrumb.textContent = meeting.title.length > 30 ? meeting.title.slice(0, 30) + '...' : meeting.title;

        if (metaEl) {
            const type = types.find(t => t.id === meeting.meeting_type_id);
            const folder = folders.find(f => f.id === meeting.folder_id);

            const typeBadge = type ? `<span class="badge badge-type"><i data-lucide="${type.icon || 'file-text'}"></i> ${type.name}</span>` : '';
            const folderBadge = folder ? `<span class="badge badge-folder"><i data-lucide="folder"></i> ${folder.name}</span>` : '';
            const dateBadge = `<span class="badge-date">${formatDate(meeting.recorded_at)}</span>`;
            const durBadge = meeting.duration_seconds ? `<span class="badge-date">${formatDuration(meeting.duration_seconds)}</span>` : '';

            metaEl.innerHTML = `${typeBadge}${folderBadge}${dateBadge}${durBadge}`;
            if (window.lucide) lucide.createIcons();
        }
    }

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
                .map(p => `<p>${escapeHtml(p)}</p>`).join('');
        }

        // Action items
        const actionsEl = getEl('action-items-list');
        if (actionsEl && summary.action_items) {
            renderActionItems(actionsEl, summary);
        }

        // Decisions
        const decisionsEl = getEl('decisions-list');
        if (decisionsEl && summary.decisions_made) {
            if (summary.decisions_made.length === 0) {
                decisionsEl.innerHTML = '<p class="text-secondary">No explicit decisions logged.</p>';
            } else {
                decisionsEl.innerHTML = summary.decisions_made.map(d => `
          <div class="decision-card">
            <div class="decision-text">${escapeHtml(d.decision)}</div>
            ${d.context ? `<div class="decision-context">${escapeHtml(d.context)}</div>` : ''}
            ${d.decided_by ? `<div class="decision-by">Decided by: ${escapeHtml(d.decided_by)}</div>` : ''}
          </div>
        `).join('');
            }
        }

        // Discussion points
        const discEl = getEl('discussion-list');
        if (discEl && summary.key_discussion_points) {
            discEl.innerHTML = (summary.key_discussion_points || [])
                .map(p => `<li>${escapeHtml(p)}</li>`).join('') || '<li class="text-secondary">None recorded.</li>';
        }

        // Follow-ups
        const fuEl = getEl('followups-list');
        if (fuEl && summary.follow_ups) {
            fuEl.innerHTML = (summary.follow_ups || [])
                .map(p => `<li>${escapeHtml(p)}</li>`).join('') || '<li class="text-secondary">None recorded.</li>';
        }

        if (window.lucide) lucide.createIcons();
    }

    // ---------------------------------------------------------------------------
    // Action items: rendering, inline editing, add, history
    // ---------------------------------------------------------------------------
    function formatDeadlineDisplay(raw) {
        if (!raw || raw === 'TBD') return 'Set date';
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            const [y, m, d] = raw.split('-').map(Number);
            const dt = new Date(y, m - 1, d);
            return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        return raw;
    }

    const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'];

    function renderActionItems(actionsEl, summary) {
        if (!summary.action_items || summary.action_items.length === 0) {
            actionsEl.innerHTML = '<p class="text-secondary">No action items recorded.</p>';
            actionsEl.appendChild(buildAddActionItemBtn());
            updateActionItemsCount(summary.action_items || []);
            return;
        }

        actionsEl.innerHTML = summary.action_items.map((item, idx) => {
            const checked = item.completed ? ' checked' : '';
            const completedClass = item.completed ? ' completed' : '';
            const prio = item.priority || 'medium';
            const priorityLabel = prio.charAt(0).toUpperCase() + prio.slice(1);
            const priorityClass = ` priority-${prio}`;
            const itemId = item.id || idx;
            return `
          <div class="action-item${completedClass}" data-item-id="${escapeHtml(String(itemId))}" data-index="${idx}">
            <div class="action-checkbox${checked}" data-index="${idx}"></div>
            <div class="action-item-body">
              <div class="action-task">${escapeHtml(item.task)}</div>
              <div class="action-pills">
                <span class="action-pill owner"><i data-lucide="user"></i> <span class="owner-text">${item.owner ? escapeHtml(item.owner) : 'Unassigned'}</span></span>
                <span class="action-pill deadline"><i data-lucide="calendar"></i> <span class="deadline-text">${formatDeadlineDisplay(item.deadline)}</span></span>
                <span class="action-pill priority-pill${priorityClass}"><span class="priority-text">${priorityLabel}</span></span>
              </div>
            </div>
            <span class="action-item-hint">tap to edit &middot; hold to reorder</span>
          </div>`;
        }).join('');

        actionsEl.querySelectorAll('.action-checkbox').forEach(cb => {
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(cb.dataset.index);
                const item = summary.action_items[idx];
                const newVal = !item.completed;
                item.completed = newVal;
                cb.classList.toggle('checked');
                cb.closest('.action-item').classList.toggle('completed');
                updateActionItemsCount(summary.action_items);
                patchActionItem(item.id, { completed: newVal });
            });
        });

        initActionItemInteractions(actionsEl, summary);

        actionsEl.appendChild(buildAddActionItemBtn());
        buildHistoryToggle(actionsEl);
        updateActionItemsCount(summary.action_items);
        if (window.lucide) lucide.createIcons();
    }

    // -----------------------------------------------------------------------
    // Long-press to drag, tap to edit (pointer events: desktop + mobile)
    // -----------------------------------------------------------------------
    const LONG_PRESS_MS = 400;
    let _dndCleanup = null;

    function initActionItemInteractions(container, summary) {
        if (_dndCleanup) { _dndCleanup(); _dndCleanup = null; }

        let pressState = null;
        let dragState = null;

        function getActionItems() {
            return Array.from(container.querySelectorAll('.action-item'));
        }

        function getPointerY(e) {
            return e.clientY ?? 0;
        }

        function getPointerX(e) {
            return e.clientX ?? 0;
        }

        function createGhost(sourceEl, x, y) {
            const ghost = document.createElement('div');
            ghost.className = 'action-item-ghost';
            const task = sourceEl.querySelector('.action-task');
            if (task) ghost.textContent = task.textContent;
            const rect = sourceEl.getBoundingClientRect();
            ghost.style.width = rect.width + 'px';
            ghost.style.left = (x - rect.width / 2) + 'px';
            ghost.style.top = (y - 20) + 'px';
            document.body.appendChild(ghost);
            return ghost;
        }

        function createDropIndicator() {
            const ind = document.createElement('div');
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
            const items = getActionItems();
            const fromIndex = items.indexOf(item);
            if (fromIndex === -1) return;

            const rects = items.map(el => el.getBoundingClientRect());

            dragState = {
                sourceEl: item,
                fromIndex,
                toIndex: fromIndex,
                ghost: createGhost(item, x, y),
                indicator: createDropIndicator(),
                rects,
                items,
                active: true,
            };

            item.classList.remove('drag-ready');
            item.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.webkitUserSelect = 'none';
        }

        function onPointerDown(e) {
            if (dragState) return;
            const item = e.target.closest('.action-item');
            if (!item || item.classList.contains('editing')) return;
            if (e.target.closest('.action-checkbox')) return;

            const x = getPointerX(e);
            const y = getPointerY(e);

            pressState = {
                item,
                startX: x,
                startY: y,
                moved: false,
                timer: setTimeout(() => {
                    if (!pressState || pressState.moved) return;
                    item.classList.add('drag-ready');
                    if (navigator.vibrate) navigator.vibrate(30);
                    setTimeout(() => {
                        if (!pressState) return;
                        startDrag(item, pressState.startX, pressState.startY);
                        pressState = null;
                    }, 100);
                }, LONG_PRESS_MS),
            };
        }

        function onPointerMove(e) {
            if (pressState && !pressState.moved) {
                const dx = getPointerX(e) - pressState.startX;
                const dy = getPointerY(e) - pressState.startY;
                if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                    pressState.moved = true;
                    cancelPress();
                }
            }

            if (!dragState || !dragState.active) return;
            e.preventDefault();

            const y = getPointerY(e);
            const x = getPointerX(e);

            dragState.ghost.style.left = (x - parseInt(dragState.ghost.style.width) / 2) + 'px';
            dragState.ghost.style.top = (y - 20) + 'px';

            let newIndex = dragState.fromIndex;
            const items = dragState.items;
            for (let i = 0; i < items.length; i++) {
                const rect = dragState.rects[i];
                const mid = rect.top + rect.height / 2;
                if (y < mid) { newIndex = i; break; }
                newIndex = i + 1;
            }
            newIndex = Math.max(0, Math.min(newIndex, items.length));

            if (newIndex !== dragState.toIndex) {
                dragState.toIndex = newIndex;
                if (dragState.indicator.parentNode) dragState.indicator.remove();
                if (newIndex >= items.length) {
                    const lastItem = items[items.length - 1];
                    lastItem.parentNode.insertBefore(dragState.indicator, lastItem.nextSibling);
                } else {
                    items[newIndex].parentNode.insertBefore(dragState.indicator, items[newIndex]);
                }
            }

            items.forEach((el, i) => {
                if (el === dragState.sourceEl) return;
                el.classList.remove('drag-over-above', 'drag-over-below');
                if (dragState.fromIndex < newIndex) {
                    if (i > dragState.fromIndex && i < newIndex) el.classList.add('drag-over-above');
                } else if (dragState.fromIndex > newIndex) {
                    if (i >= newIndex && i < dragState.fromIndex) el.classList.add('drag-over-below');
                }
            });
        }

        async function onPointerUp(e) {
            const wasDragging = dragState && dragState.active;
            const wasPressed = pressState && !pressState.moved;

            if (dragState && dragState.active) {
                dragState.active = false;
                const { sourceEl, fromIndex, toIndex, ghost, indicator, items } = dragState;

                items.forEach(el => el.classList.remove('drag-over-above', 'drag-over-below'));
                sourceEl.classList.remove('dragging');
                ghost.remove();
                if (indicator.parentNode) indicator.remove();
                document.body.style.userSelect = '';
                document.body.style.webkitUserSelect = '';

                const finalTo = toIndex > fromIndex ? toIndex - 1 : toIndex;
                if (finalTo !== fromIndex && summary.action_items.length > 1) {
                    const [moved] = summary.action_items.splice(fromIndex, 1);
                    summary.action_items.splice(finalTo, 0, moved);
                    renderActionItems(container, summary);
                    await saveActionItemOrder(summary);
                }
                dragState = null;
            }

            if (wasPressed && !wasDragging) {
                const item = pressState.item;
                cancelPress();
                if (item && !item.classList.contains('editing')) {
                    const idx = parseInt(item.dataset.index);
                    if (!isNaN(idx)) openActionItemEditMode(container, summary, idx);
                }
            } else {
                cancelPress();
            }
        }

        function onPointerCancel() {
            cancelPress();
            if (dragState && dragState.active) {
                dragState.active = false;
                dragState.items.forEach(el => el.classList.remove('drag-over-above', 'drag-over-below'));
                dragState.sourceEl.classList.remove('dragging', 'drag-ready');
                dragState.ghost.remove();
                if (dragState.indicator.parentNode) dragState.indicator.remove();
                document.body.style.userSelect = '';
                document.body.style.webkitUserSelect = '';
                dragState = null;
            }
        }

        const touchStartHandler = (e) => {
            if (e.target.closest('.action-item') && !e.target.closest('.action-checkbox') && !e.target.closest('.action-edit-form')) {
                // Don't prevent default immediately -- let the long-press timer decide
            }
        };

        const touchMoveHandler = (e) => {
            if (dragState && dragState.active) e.preventDefault();
        };

        container.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerCancel);
        container.addEventListener('touchmove', touchMoveHandler, { passive: false });

        _dndCleanup = () => {
            container.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerCancel);
            container.removeEventListener('touchmove', touchMoveHandler);
        };
    }

    async function saveActionItemOrder(summary) {
        if (!currentMeeting) return;
        const orderedIds = summary.action_items.map(item => item.id).filter(Boolean);
        if (orderedIds.length === 0) return;
        try {
            await api(`/api/recordings/${currentMeeting.id}/action-items/reorder`, {
                method: 'PUT',
                body: { ordered_ids: orderedIds },
            });
        } catch (err) {
            console.error('Failed to save action item order:', err);
            showToast('Failed to save order.', 'error');
        }
    }

    function openActionItemEditMode(actionsEl, summary, idx) {
        const item = summary.action_items[idx];
        const row = actionsEl.querySelector(`.action-item[data-index="${idx}"]`);
        if (!row || row.classList.contains('editing')) return;

        row.classList.add('editing');
        const editBtn = row.querySelector('.action-edit-btn');
        if (editBtn) editBtn.style.display = 'none';

        const body = row.querySelector('.action-item-body');
        const origHtml = body.innerHTML;

        const prio = item.priority || 'medium';
        const deadlineVal = (item.deadline && item.deadline !== 'TBD' && /^\d{4}-\d{2}-\d{2}$/.test(item.deadline)) ? item.deadline : '';

        body.innerHTML = `
          <div class="action-edit-form">
            <div class="action-edit-field">
              <label class="action-edit-label">Task</label>
              <textarea class="action-edit-textarea" rows="2">${escapeHtml(item.task)}</textarea>
            </div>
            <div class="action-edit-row">
              <div class="action-edit-field action-edit-field-half">
                <label class="action-edit-label">Owner</label>
                <input type="text" class="action-edit-input" value="${escapeHtml(item.owner || '')}" placeholder="Assign owner" data-field="owner" />
              </div>
              <div class="action-edit-field action-edit-field-half">
                <label class="action-edit-label">Deadline</label>
                <div class="action-edit-date-wrap action-edit-input">
                  <span class="action-edit-date-display">${deadlineVal ? formatDeadlineDisplay(deadlineVal) : 'Set date'}</span>
                  <input type="date" class="action-edit-date-native" value="${deadlineVal}" data-field="deadline" />
                </div>
              </div>
            </div>
            <div class="action-edit-field">
              <label class="action-edit-label">Priority</label>
              <div class="action-edit-priority-row">
                ${PRIORITY_OPTIONS.map(opt => `<button type="button" class="action-edit-priority-opt priority-${opt}${opt === prio ? ' active' : ''}" data-value="${opt}">${opt.charAt(0).toUpperCase() + opt.slice(1)}</button>`).join('')}
              </div>
            </div>
            <div class="action-edit-btns">
              <button class="action-edit-cancel">Cancel</button>
              <button class="action-edit-save"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Save</button>
            </div>
          </div>`;

        const textarea = body.querySelector('.action-edit-textarea');
        const autoGrow = () => { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; };
        textarea.addEventListener('input', autoGrow);
        setTimeout(autoGrow, 0);

        const dateNative = body.querySelector('.action-edit-date-native');
        const dateDisplay = body.querySelector('.action-edit-date-display');
        if (dateNative && dateDisplay) {
            dateNative.addEventListener('change', () => {
                dateDisplay.textContent = dateNative.value ? formatDeadlineDisplay(dateNative.value) : 'Set date';
            });
        }

        let selectedPriority = prio;
        body.querySelectorAll('.action-edit-priority-opt').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                body.querySelectorAll('.action-edit-priority-opt').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedPriority = btn.dataset.value;
            });
        });

        const closeEdit = () => {
            row.classList.remove('editing');
            body.innerHTML = origHtml;
            if (editBtn) editBtn.style.display = '';
            if (window.lucide) lucide.createIcons();
        };

        body.querySelector('.action-edit-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            closeEdit();
        });

        body.querySelector('.action-edit-save').addEventListener('click', async (e) => {
            e.stopPropagation();
            const newTask = textarea.value.trim();
            const newOwner = body.querySelector('[data-field="owner"]').value.trim();
            const newDeadline = body.querySelector('[data-field="deadline"]').value;

            const updates = {};
            if (newTask && newTask !== item.task) { updates.task = newTask; item.task = newTask; }
            if (newOwner !== (item.owner || '')) { updates.owner = newOwner; item.owner = newOwner; }
            if (newDeadline !== (item.deadline || '')) { updates.deadline = newDeadline || ''; item.deadline = newDeadline || ''; }
            if (selectedPriority !== (item.priority || 'medium')) { updates.priority = selectedPriority; item.priority = selectedPriority; }

            if (Object.keys(updates).length > 0) {
                for (const [field, value] of Object.entries(updates)) {
                    await patchActionItem(item.id, { [field]: value });
                }
                renderActionItems(actionsEl, summary);
                showToast('Action item saved.', 'success');
            } else {
                closeEdit();
            }
        });

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); closeEdit(); }
        });
    }

    function buildAddActionItemBtn() {
        const btn = document.createElement('button');
        btn.className = 'add-action-item-btn';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add action item';
        btn.addEventListener('click', async () => {
            if (!currentMeeting) return;
            try {
                const data = await api(`/api/recordings/${currentMeeting.id}/action-items`, {
                    method: 'POST',
                    body: { task: 'New action item', owner: '', deadline: '', priority: 'medium' },
                });
                currentMeeting.summary = data.summary;
                const actionsEl = getEl('action-items-list');
                if (actionsEl) renderActionItems(actionsEl, currentMeeting.summary);
                showToast('Action item added.', 'success');
            } catch (err) {
                showToast('Failed to add action item.', 'error');
            }
        });
        return btn;
    }

    async function patchActionItem(itemId, updates) {
        if (!currentMeeting || !itemId) return;
        try {
            await api(`/api/recordings/${currentMeeting.id}/action-items/${itemId}`, {
                method: 'PATCH',
                body: updates,
            });
        } catch (err) {
            console.error('Failed to save action item:', err);
            showToast('Failed to save changes.', 'error');
        }
    }

    function buildHistoryToggle(container) {
        const toggle = document.createElement('button');
        toggle.className = 'action-history-toggle';
        toggle.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> View changes';
        let historyEl = null;
        let loaded = false;

        toggle.addEventListener('click', async () => {
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
                    const data = await api(`/api/recordings/${currentMeeting.id}/action-items/history`);
                    renderHistory(historyEl, data.history || []);
                    loaded = true;
                } catch (err) {
                    historyEl.innerHTML = '<div class="action-history-empty">Failed to load history.</div>';
                }
            }
        });
        container.appendChild(toggle);
    }

    function renderHistory(el, entries) {
        if (!entries.length) {
            el.innerHTML = '<div class="action-history-empty">No changes yet.</div>';
            return;
        }
        el.innerHTML = entries.map(e => {
            const isUser = e.changed_by_type === 'user';
            const dotClass = isUser ? 'history-dot-user' : 'history-dot-shared';
            const name = e.changed_by_name || (isUser ? 'User' : 'Shared link user');
            const time = new Date(e.created_at).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
            });
            let desc = '';
            if (e.field_changed === 'created') {
                desc = `added "<span class="history-value">${escapeHtml(e.new_value || '')}</span>"`;
            } else if (e.field_changed === 'completed') {
                desc = e.new_value === 'True' ? 'marked as done' : 'marked as not done';
            } else {
                desc = `changed ${e.field_changed}`;
                if (e.old_value) desc += ` from "<span class="history-value">${escapeHtml(e.old_value)}</span>"`;
                desc += ` to "<span class="history-value">${escapeHtml(e.new_value || '')}</span>"`;
            }
            return `<div class="action-history-entry">
                <span class="history-dot ${dotClass}"></span>
                <span class="history-name">${escapeHtml(name)}</span>
                <span class="history-desc">${desc}</span>
                <span class="history-time">${time}</span>
            </div>`;
        }).join('');
    }

    function updateActionItemsCount(actionItems) {
        const countEl = getEl('action-items-count');
        if (!countEl || !actionItems) return;
        const done = actionItems.filter(i => i.completed).length;
        const total = actionItems.length;
        if (total > 0) {
            countEl.textContent = `${done}/${total} done`;
            countEl.style.display = 'inline-block';
        } else {
            countEl.style.display = 'none';
        }
    }

    function renderTranscript(transcript) {
        const contentEl = getEl('transcript-content');
        const emptyEl = getEl('transcript-empty');
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

    function populateDetailFolderSelect(folders, currentFolderId) {
        const select = getEl('move-folder-select');
        if (!select) return;
        select.innerHTML = '<option value="">Move to folder...</option>';
        folders.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.name;
            if (currentFolderId === f.id) opt.selected = true;
            select.appendChild(opt);
        });
    }

    function populateResurfaceGrid(types) {
        const grid = getEl('resurface-type-grid');
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
            card.addEventListener('click', () => resurfaceWith(type.id));
            grid.appendChild(card);
        });

        if (window.lucide) lucide.createIcons();
    }

    async function resurfaceWith(typeId) {
        const meetingId = window.MEETING_ID;
        closeResurfaceModal();
        showSummarizingSpinner();
        try {
            const data = await api('/api/recordings/summarize', {
                method: 'POST',
                body: { meeting_id: meetingId, meeting_type_id: typeId },
            });
            hideSummarizingSpinner();
            currentMeeting = data.meeting;
            renderSummary(data.meeting.summary);
            showToast('Summary updated!', 'success');
        } catch (err) {
            hideSummarizingSpinner();
            showToast(`Re-summarize failed: ${err.message}`, 'error');
        }
    }

    function showSummarizingSpinner() {
        let overlay = getEl('summarizing-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'summarizing-overlay';
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:9999',
                'background:rgba(10,10,20,0.85)', 'backdrop-filter:blur(6px)',
                'display:flex', 'flex-direction:column',
                'align-items:center', 'justify-content:center', 'gap:24px',
            ].join(';');
            overlay.innerHTML = `
                <div class="spinner" style="width:52px;height:52px;border-width:4px;"></div>
                <div style="text-align:center;">
                    <div style="font-size:20px;font-weight:700;color:#f1f5f9;margin-bottom:6px;">Generating summary...</div>
                    <div style="font-size:14px;color:#94a3b8;">The AI is analyzing your meeting. This may take a moment.</div>
                </div>
            `;
            document.body.appendChild(overlay);
        }
        overlay.style.display = 'flex';
    }

    function hideSummarizingSpinner() {
        const overlay = getEl('summarizing-overlay');
        if (overlay) overlay.style.display = 'none';
    }



    function openResurfaceModal() {
        const modal = getEl('resurface-modal');
        if (modal) modal.classList.add('visible');
    }

    function closeResurfaceModal() {
        const modal = getEl('resurface-modal');
        if (modal) modal.classList.remove('visible');
    }

    function bindDetailEvents() {
        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                const panel = getEl(`tab-${btn.dataset.tab}`);
                if (panel) panel.classList.add('active');

                // Auto-scroll so the chat input is visible on mobile
                if (btn.dataset.tab === 'chat') {
                    const chatInput = getEl('chat-input');
                    if (chatInput) {
                        setTimeout(() => {
                            chatInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }, 100);
                    }
                }
            });
        });

        // Inline title editing
        const titleEl = getEl('meeting-title');
        if (titleEl) {
            titleEl.addEventListener('blur', async () => {
                const newTitle = titleEl.textContent.trim();
                if (!newTitle) return;
                try {
                    await api(`/api/recordings/${window.MEETING_ID}`, {
                        method: 'PUT',
                        body: { title: newTitle },
                    });
                    document.title = `${newTitle} - VoiceNotes PM`;
                    showToast('Title saved.', 'success');
                } catch (err) {
                    showToast(`Failed to save title: ${err.message}`, 'error');
                }
            });
            titleEl.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
            });
        }

        // Move folder
        const folderSelect = getEl('move-folder-select');
        if (folderSelect) {
            folderSelect.addEventListener('change', async () => {
                const folderId = folderSelect.value || null;
                try {
                    await api(`/api/recordings/${window.MEETING_ID}`, {
                        method: 'PUT',
                        body: { folder_id: folderId },
                    });
                    showToast('Moved to folder.', 'success');
                } catch (err) {
                    showToast(`Failed: ${err.message}`, 'error');
                }
            });
        }

        // Re-summarize
        const resurfaceBtn = getEl('resurface-btn');
        if (resurfaceBtn) resurfaceBtn.addEventListener('click', openResurfaceModal);

        const resurfaceCancel = getEl('resurface-cancel-btn');
        if (resurfaceCancel) resurfaceCancel.addEventListener('click', closeResurfaceModal);

        const resurfaceModalClose = getEl('resurface-modal-close');
        if (resurfaceModalClose) resurfaceModalClose.addEventListener('click', closeResurfaceModal);

        // Delete
        const deleteBtn = getEl('delete-meeting-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                window.showConfirmModal({
                    title: 'Delete Meeting?',
                    message: 'This meeting and its summary will be permanently removed.',
                    confirmText: 'Delete',
                    isDanger: true,
                    onConfirm: async () => {
                        try {
                            await api(`/api/recordings/${window.MEETING_ID}`, { method: 'DELETE' });
                            window.location.href = '/';
                        } catch (err) {
                            showToast(`Failed to delete: ${err.message}`, 'error');
                        }
                    },
                });
            });
        }

        // Copy summary as Markdown
        const copySummaryBtn = getEl('copy-summary-btn');
        if (copySummaryBtn) {
            copySummaryBtn.addEventListener('click', async () => {
                if (!currentMeeting || !currentMeeting.summary) return;
                const md = buildSummaryMarkdown(currentMeeting);
                try {
                    await navigator.clipboard.writeText(md);
                    showToast('Summary copied to clipboard.', 'success');
                } catch (e) {
                    showToast('Could not copy. Please select and copy manually.', 'error');
                }
            });
        }

        // Copy transcript
        const copyTransBtn = getEl('copy-transcript-btn');
        if (copyTransBtn) {
            copyTransBtn.addEventListener('click', async () => {
                const el = getEl('transcript-content');
                try {
                    await navigator.clipboard.writeText(el ? el.textContent : '');
                    showToast('Transcript copied.', 'success');
                } catch (e) {
                    showToast('Could not copy.', 'error');
                }
            });
        }

        // Share button
        initShareButton();
    }

    // ---------------------------------------------------------------------------
    // Share link management
    // ---------------------------------------------------------------------------
    function initShareButton() {
        const shareBtn = getEl('share-btn');
        const popover = getEl('share-popover');
        const wrapper = getEl('share-btn-wrapper');
        const linkInput = getEl('share-link-input');
        const copyLinkBtn = getEl('copy-share-link-btn');
        const revokeBtn = getEl('revoke-share-btn');

        if (!shareBtn || !popover) return;

        let shareId = null;
        let popoverOpen = false;

        // Check existing share status on load
        loadShareStatus();

        async function loadShareStatus() {
            try {
                const data = await api(`/api/recordings/${window.MEETING_ID}/share`);
                if (data.share_id && data.is_active) {
                    shareId = data.share_id;
                    shareBtn.classList.add('share-active');
                }
            } catch (_) { /* ignore */ }
        }

        function togglePopover() {
            popoverOpen = !popoverOpen;
            if (popoverOpen) {
                openPopover();
            } else {
                popover.classList.remove('visible');
            }
        }

        async function openPopover() {
            if (!shareId) {
                try {
                    const data = await api(`/api/recordings/${window.MEETING_ID}/share`, { method: 'POST' });
                    shareId = data.share_id;
                    shareBtn.classList.add('share-active');
                } catch (err) {
                    showToast(`Failed to create share link: ${err.message}`, 'error');
                    return;
                }
            }
            linkInput.value = window.location.origin + '/share/' + shareId;
            popover.classList.add('visible');
            revokeBtn.style.display = '';
        }

        shareBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePopover();
        });

        if (copyLinkBtn) {
            copyLinkBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await navigator.clipboard.writeText(linkInput.value);
                    copyLinkBtn.textContent = 'Copied!';
                    setTimeout(() => { copyLinkBtn.textContent = 'Copy'; }, 2000);
                } catch (_) {
                    linkInput.select();
                    showToast('Press Ctrl+C to copy.', 'info');
                }
            });
        }

        if (revokeBtn) {
            revokeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await api(`/api/recordings/${window.MEETING_ID}/share`, { method: 'DELETE' });
                    shareId = null;
                    shareBtn.classList.remove('share-active');
                    popover.classList.remove('visible');
                    popoverOpen = false;
                    showToast('Share link revoked.', 'success');
                } catch (err) {
                    showToast(`Failed to revoke: ${err.message}`, 'error');
                }
            });
        }

        // Close popover on outside click
        document.addEventListener('click', (e) => {
            if (popoverOpen && wrapper && !wrapper.contains(e.target)) {
                popover.classList.remove('visible');
                popoverOpen = false;
            }
        });
    }

    // ---------------------------------------------------------------------------
    // Markdown copy
    // ---------------------------------------------------------------------------
    function buildSummaryMarkdown(meeting) {
        const s = meeting.summary || {};
        const lines = [];

        lines.push(`# ${meeting.title}`);
        lines.push('');

        const meta = [];
        if (meeting.recorded_at) meta.push(`**Date:** ${formatDate(meeting.recorded_at)}`);
        if (meeting.duration_seconds) meta.push(`**Duration:** ${formatDuration(meeting.duration_seconds)}`);
        const types = window.AppState.meetingTypes || [];
        const type = types.find(t => t.id === meeting.meeting_type_id);
        if (type) meta.push(`**Type:** ${type.name}`);
        if (meta.length) {
            lines.push(meta.join('  ·  '));
            lines.push('');
        }

        lines.push('---');
        lines.push('');

        if (s.executive_summary) {
            lines.push('## Executive Summary');
            lines.push('');
            lines.push(s.executive_summary.trim());
            lines.push('');
        }

        if (s.action_items && s.action_items.length) {
            lines.push('## Action Items');
            lines.push('');
            s.action_items.forEach(item => {
                const check = item.completed ? 'x' : ' ';
                let line = `- [${check}] ${item.task}`;
                const tags = [];
                if (item.owner) tags.push(`@${item.owner}`);
                if (item.deadline) tags.push(`📅 ${item.deadline}`);
                if (item.priority) tags.push(`🔺 ${item.priority}`);
                if (tags.length) line += `  —  ${tags.join('  ·  ')}`;
                lines.push(line);
            });
            lines.push('');
        }

        if (s.decisions_made && s.decisions_made.length) {
            lines.push('## Decisions Made');
            lines.push('');
            s.decisions_made.forEach(d => {
                lines.push(`- **${d.decision}**`);
                if (d.context) lines.push(`  ${d.context}`);
                if (d.decided_by) lines.push(`  *Decided by: ${d.decided_by}*`);
            });
            lines.push('');
        }

        if (s.key_discussion_points && s.key_discussion_points.length) {
            lines.push('## Key Discussion Points');
            lines.push('');
            s.key_discussion_points.forEach(p => lines.push(`- ${p}`));
            lines.push('');
        }

        if (s.follow_ups && s.follow_ups.length) {
            lines.push('## Follow-ups');
            lines.push('');
            s.follow_ups.forEach(f => lines.push(`- ${f}`));
            lines.push('');
        }

        return lines.join('\n');
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

    window.escapeHtml = escapeHtml;

    /**
     * Escape HTML then wrap every case-insensitive occurrence of `query`
     * in <mark class="search-highlight">…</mark>.
     * Safe to inject as innerHTML.
     */
    function highlightText(rawText, rawQuery) {
        const safe = escapeHtml(rawText || '');
        if (!rawQuery) return safe;
        // Escape the query for both HTML entities and regex special chars
        const safeQuery = escapeHtml(rawQuery).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
            return safe.replace(
                new RegExp(`(${safeQuery})`, 'gi'),
                '<mark class="search-highlight">$1</mark>'
            );
        } catch (_) {
            return safe;
        }
    }

    // ---------------------------------------------------------------------------
    // Presence polling & live updates
    // ---------------------------------------------------------------------------
    function startPresencePolling(meetingId) {
        if (presenceInterval) clearInterval(presenceInterval);

        sendHeartbeat(meetingId);
        presenceInterval = setInterval(() => sendHeartbeat(meetingId), HEARTBEAT_INTERVAL_MS);

        window.addEventListener('beforeunload', () => {
            clearInterval(presenceInterval);
            const url = `/api/presence/${meetingId}/leave`;
            if (navigator.sendBeacon) {
                navigator.sendBeacon(url, '{}');
            } else {
                fetch(url, { method: 'POST', keepalive: true });
            }
        });
    }

    async function sendHeartbeat(meetingId) {
        try {
            const data = await api(`/api/presence/${meetingId}/heartbeat`, { method: 'POST' });
            renderPresenceBubbles(data.viewers || []);

            if (lastKnownUpdatedAt && data.meeting_updated_at && data.meeting_updated_at !== lastKnownUpdatedAt) {
                lastKnownUpdatedAt = data.meeting_updated_at;
                await refreshMeetingData(meetingId);
            }
        } catch (_) {
            // Heartbeat failures are non-critical
        }
    }

    async function refreshMeetingData(meetingId) {
        try {
            const meetingData = await api(`/api/recordings/${meetingId}`);
            const meeting = meetingData.meeting;
            currentMeeting = meeting;
            lastKnownUpdatedAt = meeting.updated_at;

            renderSummary(meeting.summary);
            renderTranscript(meeting.transcript);

            const titleEl = getEl('meeting-title');
            if (titleEl && !titleEl.matches(':focus') && titleEl.textContent !== meeting.title) {
                titleEl.textContent = meeting.title;
            }

            showUpdateFlash();
        } catch (_) {
            // Non-critical
        }
    }

    function showUpdateFlash() {
        const container = getEl('presence-bubbles');
        if (!container) return;
        const existing = container.querySelector('.presence-update-dot');
        if (existing) existing.remove();
        const dot = document.createElement('div');
        dot.className = 'presence-update-dot';
        container.appendChild(dot);
        dot.addEventListener('animationend', () => dot.remove());
    }

    function renderPresenceBubbles(viewers) {
        const container = getEl('presence-bubbles');
        if (!container) return;

        const shown = viewers.slice(0, MAX_PRESENCE_BUBBLES);
        const overflow = viewers.length - shown.length;

        const currentIds = new Set(shown.map(v => v.viewer_id));
        container.querySelectorAll('.presence-bubble').forEach(el => {
            if (!currentIds.has(el.dataset.viewerId)) el.remove();
        });
        const overflowEl = container.querySelector('.presence-viewer-count');
        if (overflowEl && overflow <= 0) overflowEl.remove();

        shown.forEach(viewer => {
            let bubble = container.querySelector(`.presence-bubble[data-viewer-id="${viewer.viewer_id}"]`);
            if (!bubble) {
                bubble = document.createElement('div');
                bubble.className = 'presence-bubble';
                bubble.dataset.viewerId = viewer.viewer_id;
                const tooltip = document.createElement('span');
                tooltip.className = 'presence-tooltip';
                bubble.appendChild(tooltip);
                const updateDot = container.querySelector('.presence-update-dot');
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
            let countEl = container.querySelector('.presence-viewer-count');
            if (!countEl) {
                countEl = document.createElement('div');
                countEl.className = 'presence-viewer-count';
                const updateDot = container.querySelector('.presence-update-dot');
                if (updateDot) {
                    container.insertBefore(countEl, updateDot);
                } else {
                    container.appendChild(countEl);
                }
            }
            countEl.textContent = `+${overflow}`;
        }
    }

    // ---------------------------------------------------------------------------
    // Comments
    // ---------------------------------------------------------------------------

    const COMMENT_COLORS = [
        '#4A90D9', '#E85D75', '#50C878', '#F5A623', '#9B59B6',
        '#1ABC9C', '#E74C3C', '#3498DB', '#2ECC71', '#E67E22',
        '#8E44AD', '#16A085', '#D35400', '#2980B9', '#27AE60',
    ];

    function commentColorFor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = ((hash << 5) - hash) + name.charCodeAt(i);
            hash |= 0;
        }
        return COMMENT_COLORS[Math.abs(hash) % COMMENT_COLORS.length];
    }

    function commentInitials(name) {
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        return name.slice(0, 2).toUpperCase();
    }

    function commentTimeAgo(dateStr) {
        const now = Date.now();
        const then = new Date(dateStr).getTime();
        const diff = Math.max(0, now - then);
        const secs = Math.floor(diff / 1000);
        if (secs < 10) return 'just now';
        if (secs < 60) return secs + 's ago';
        const mins = Math.floor(secs / 60);
        if (mins < 60) return mins + 'm ago';
        const hours = Math.floor(mins / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.floor(hours / 24);
        return days + 'd ago';
    }

    function renderCommentItem(c) {
        const div = document.createElement('div');
        div.className = 'comment-item';
        div.dataset.commentId = c.id;
        const color = commentColorFor(c.commenter_name);
        const initials = commentInitials(c.commenter_name);

        const isOwn = c.user_id && c.user_id === currentUserId;

        let actionsHtml = '';
        if (isOwn) {
            actionsHtml =
                '<div class="comment-actions">' +
                    '<button class="comment-edit-btn" title="Edit">' +
                        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
                    '</button>' +
                    '<button class="comment-delete-btn" title="Delete">' +
                        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                    '</button>' +
                '</div>';
        } else {
            actionsHtml =
                '<div class="comment-actions">' +
                    '<button class="comment-delete-btn" title="Delete">' +
                        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                    '</button>' +
                '</div>';
        }

        div.innerHTML =
            '<div class="comment-header">' +
                '<span class="comment-avatar" style="background:' + color + '">' + initials + '</span>' +
                '<span class="comment-author">' + escapeHtml(c.commenter_name) + '</span>' +
                '<span class="comment-time">' + commentTimeAgo(c.created_at) + '</span>' +
                actionsHtml +
            '</div>' +
            '<div class="comment-body">' + c.content + '</div>';
        return div;
    }

    function renderCommentsList(comments) {
        const listEl = getEl('comments-list');
        const emptyEl = getEl('comments-empty');
        const countEl = getEl('comments-count');
        if (!listEl) return;

        if (countEl) countEl.textContent = comments.length;

        if (comments.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            listEl.querySelectorAll('.comment-item').forEach(el => el.remove());
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        const existingIds = new Set();
        listEl.querySelectorAll('.comment-item').forEach(el => existingIds.add(el.dataset.commentId));

        // Remove deleted comments
        const newIds = new Set(comments.map(c => c.id));
        listEl.querySelectorAll('.comment-item').forEach(el => {
            if (!newIds.has(el.dataset.commentId)) el.remove();
        });

        let shouldScroll = false;
        comments.forEach(c => {
            const existing = listEl.querySelector(`.comment-item[data-comment-id="${c.id}"]`);
            if (existing) {
                // Skip items being edited
                if (existing.querySelector('.comment-edit-editor')) return;
                // Update content and timestamp in place
                const bodyEl = existing.querySelector('.comment-body');
                if (bodyEl && bodyEl.innerHTML !== c.content) bodyEl.innerHTML = c.content;
                const timeEl = existing.querySelector('.comment-time');
                if (timeEl) timeEl.textContent = commentTimeAgo(c.created_at);
            } else {
                const item = renderCommentItem(c);
                item.classList.add('comment-new');
                listEl.appendChild(item);
                shouldScroll = true;
            }
        });

        if (shouldScroll) {
            listEl.scrollTop = listEl.scrollHeight;
        }
    }

    function initComments(meetingId) {
        const editor = getEl('comments-editor');
        const sendBtn = getEl('comments-send-btn');
        const toolbar = getEl('comments-toolbar');
        const listEl = getEl('comments-list');
        if (!editor || !sendBtn) return;

        // Toolbar commands
        if (toolbar) {
            toolbar.addEventListener('click', function (e) {
                const btn = e.target.closest('button[data-cmd]');
                if (!btn) return;
                e.preventDefault();
                document.execCommand(btn.dataset.cmd, false, null);
                editor.focus();
                updateToolbarState();
            });
        }

        function updateToolbarState() {
            if (!toolbar) return;
            toolbar.querySelectorAll('button[data-cmd]').forEach(btn => {
                const cmd = btn.dataset.cmd;
                btn.classList.toggle('active', document.queryCommandState(cmd));
            });
        }

        function checkEditorContent() {
            const hasContent = editor.textContent.trim().length > 0;
            sendBtn.disabled = !hasContent;
        }

        editor.addEventListener('input', checkEditorContent);
        editor.addEventListener('keyup', updateToolbarState);
        editor.addEventListener('mouseup', updateToolbarState);

        editor.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!sendBtn.disabled) postComment(meetingId);
            }
        });

        sendBtn.addEventListener('click', function () {
            postComment(meetingId);
        });

        // Edit / delete delegation
        if (listEl) {
            listEl.addEventListener('click', function (e) {
                const editBtn = e.target.closest('.comment-edit-btn');
                const deleteBtn = e.target.closest('.comment-delete-btn');
                const saveBtn = e.target.closest('.comment-edit-save');
                const cancelBtn = e.target.closest('.comment-edit-cancel');

                if (editBtn) {
                    const item = editBtn.closest('.comment-item');
                    if (item) startEditComment(item);
                } else if (deleteBtn) {
                    const item = deleteBtn.closest('.comment-item');
                    if (item) deleteComment(meetingId, item.dataset.commentId);
                } else if (saveBtn) {
                    const item = saveBtn.closest('.comment-item');
                    if (item) saveEditComment(meetingId, item);
                } else if (cancelBtn) {
                    const item = cancelBtn.closest('.comment-item');
                    if (item) cancelEditComment(item);
                }
            });
        }

        fetchComments(meetingId);

        if (commentsInterval) clearInterval(commentsInterval);
        commentsInterval = setInterval(() => fetchComments(meetingId), COMMENTS_POLL_MS);
    }

    function commentsFingerprint(comments) {
        return comments.map(c => c.id + ':' + (c.content || '').length).join(',');
    }

    async function fetchComments(meetingId) {
        try {
            const data = await api(`/api/recordings/${meetingId}/comments`);
            const comments = data.comments || [];
            const fp = commentsFingerprint(comments);
            if (fp !== lastKnownCommentId) {
                lastKnownCommentId = fp;
                renderCommentsList(comments);
            }
        } catch (_) {
            // Non-critical
        }
    }

    async function postComment(meetingId) {
        const editor = getEl('comments-editor');
        const sendBtn = getEl('comments-send-btn');
        if (!editor) return;

        const content = editor.innerHTML.trim();
        if (!content || content === '<br>') return;

        sendBtn.disabled = true;
        try {
            await api(`/api/recordings/${meetingId}/comments`, {
                method: 'POST',
                body: JSON.stringify({ content: content }),
            });
            editor.innerHTML = '';
            sendBtn.disabled = true;
            await fetchComments(meetingId);
        } catch (err) {
            showToast('Failed to post comment: ' + err.message, 'error');
            sendBtn.disabled = false;
        }
    }

    function alignCommentsPanel() {
        const panel = getEl('comments-panel');
        const anchor = document.querySelector('.meeting-main .summary-section') ||
                       document.querySelector('.meeting-main .tab-panel.active');
        const layout = document.querySelector('.meeting-layout');
        if (!panel || !anchor || !layout) return;
        if (window.innerWidth <= 960) { panel.style.marginTop = ''; return; }
        const layoutTop = layout.getBoundingClientRect().top + window.scrollY;
        const anchorTop = anchor.getBoundingClientRect().top + window.scrollY;
        panel.style.marginTop = (anchorTop - layoutTop) + 'px';
    }

    // ---------------------------------------------------------------------------
    // Comment edit / delete
    // ---------------------------------------------------------------------------

    function startEditComment(item) {
        const bodyEl = item.querySelector('.comment-body');
        if (!bodyEl || item.querySelector('.comment-edit-editor')) return;

        const originalHtml = bodyEl.innerHTML;
        item.dataset.originalContent = originalHtml;
        bodyEl.style.display = 'none';

        const editEditor = document.createElement('div');
        editEditor.className = 'comment-edit-editor';
        editEditor.contentEditable = 'true';
        editEditor.innerHTML = originalHtml;

        const editActions = document.createElement('div');
        editActions.className = 'comment-edit-actions';
        editActions.innerHTML =
            '<button class="comment-edit-cancel">Cancel</button>' +
            '<button class="comment-edit-save">Save</button>';

        bodyEl.parentNode.insertBefore(editEditor, bodyEl.nextSibling);
        bodyEl.parentNode.insertBefore(editActions, editEditor.nextSibling);

        editEditor.focus();

        const actionsEl = item.querySelector('.comment-actions');
        if (actionsEl) actionsEl.style.display = 'none';
    }

    function cancelEditComment(item) {
        const bodyEl = item.querySelector('.comment-body');
        const editEditor = item.querySelector('.comment-edit-editor');
        const editActions = item.querySelector('.comment-edit-actions');

        if (editEditor) editEditor.remove();
        if (editActions) editActions.remove();
        if (bodyEl) bodyEl.style.display = '';

        const actionsEl = item.querySelector('.comment-actions');
        if (actionsEl) actionsEl.style.display = '';
    }

    async function saveEditComment(meetingId, item) {
        const editEditor = item.querySelector('.comment-edit-editor');
        if (!editEditor) return;

        const content = editEditor.innerHTML.trim();
        if (!content || content === '<br>') return;

        const commentId = item.dataset.commentId;
        const saveBtn = item.querySelector('.comment-edit-save');
        if (saveBtn) saveBtn.disabled = true;

        try {
            await api(`/api/recordings/${meetingId}/comments/${commentId}`, {
                method: 'PATCH',
                body: JSON.stringify({ content: content }),
            });
            cancelEditComment(item);
            lastKnownCommentId = null;
            await fetchComments(meetingId);
        } catch (err) {
            showToast('Failed to update comment: ' + err.message, 'error');
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async function deleteComment(meetingId, commentId) {
        try {
            await api(`/api/recordings/${meetingId}/comments/${commentId}`, {
                method: 'DELETE',
            });
            lastKnownCommentId = null;
            await fetchComments(meetingId);
        } catch (err) {
            showToast('Failed to delete comment: ' + err.message, 'error');
        }
    }

    return { init, reload, initDetail };
})();
