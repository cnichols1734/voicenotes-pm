/**
 * VoiceNotes PM - Meetings module.
 * Manages meeting list rendering, search, sort, inline title editing, and detail page.
 */

window.MeetingsModule = (() => {
    let allMeetings = [];

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

        try {
            const data = await api(`/api/recordings?${params.toString()}`);
            allMeetings = data.meetings || [];

            // Update all-meetings count
            const countEl = getEl('all-meetings-count');
            if (countEl) countEl.textContent = allMeetings.length;

            renderMeetings(allMeetings);
        } catch (err) {
            console.error('Failed to load meetings:', err);
            showToast('Failed to load meetings.', 'error');
        }
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

        // Remove existing cards
        list.querySelectorAll('.meeting-card').forEach(el => el.remove());

        // Apply search
        const query = window.AppState.searchQuery.toLowerCase();
        let filtered = query
            ? meetings.filter(m => m.title.toLowerCase().includes(query))
            : meetings;

        // Apply sort
        const sort = window.AppState.sortOrder;
        filtered = [...filtered].sort((a, b) => {
            if (sort === 'oldest') return new Date(a.recorded_at) - new Date(b.recorded_at);
            if (sort === 'alpha') return a.title.localeCompare(b.title);
            return new Date(b.recorded_at) - new Date(a.recorded_at); // newest first (default)
        });

        if (filtered.length === 0) {
            if (empty) empty.style.display = 'flex';
            return;
        }
        if (empty) empty.style.display = 'none';

        const types = window.AppState.meetingTypes || [];
        filtered.forEach(meeting => {
            const card = buildMeetingCard(meeting, types);
            list.appendChild(card);
        });

        if (window.lucide) lucide.createIcons();
    }

    function buildMeetingCard(meeting, types) {
        const type = types.find(t => t.id === meeting.meeting_type_id);
        const folders = window.AppState.folders || [];
        const folder = folders.find(f => f.id === meeting.folder_id);
        const summary = meeting.summary || {};
        const preview = summary.executive_summary
            ? (summary.executive_summary.length > 120 ? summary.executive_summary.slice(0, 120) + '...' : summary.executive_summary)
            : '';

        const card = document.createElement('div');
        card.className = 'meeting-card';
        card.dataset.meetingId = meeting.id;

        const typeBadge = type ? `<span class="badge badge-type"><i data-lucide="${type.icon || 'file-text'}"></i> ${type.name}</span>` : '';
        const folderBadge = folder ? `<span class="badge badge-folder"><i data-lucide="folder"></i> ${escapeHtml(folder.name)}</span>` : '';

        card.innerHTML = `
      <div class="meeting-card-body">
        <div class="meeting-card-header">
          <div class="meeting-card-title">${escapeHtml(meeting.title)}</div>
        </div>
        <div class="meeting-card-meta">
          ${typeBadge}${folderBadge}
          <span class="badge-date">${formatDate(meeting.recorded_at)}</span>
          ${meeting.duration_seconds ? `<span class="badge-date">${formatDuration(meeting.duration_seconds)}</span>` : ''}
        </div>
        ${preview ? `<div class="meeting-card-preview">${escapeHtml(preview)}</div>` : ''}
      </div>
      <div class="meeting-card-actions">
        <button class="card-action-btn card-move-btn" title="Move to folder">
          <i data-lucide="folder-input"></i>
        </button>
      </div>
    `;

        // Click body to navigate
        const body = card.querySelector('.meeting-card-body');
        body.addEventListener('click', () => {
            window.location.href = `/meeting/${meeting.id}`;
        });

        // Move-to-folder button
        const moveBtn = card.querySelector('.card-move-btn');
        moveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openMoveModal(meeting);
        });

        return card;
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
                renderMeetings(allMeetings);
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
            const types = typesData.meeting_types || [];
            const folders = foldersData.folders || [];

            window.AppState.meetingTypes = types;
            window.AppState.folders = folders;

            renderDetailHeader(meeting, types, folders);
            renderSummary(meeting.summary);
            renderTranscript(meeting.transcript);
            populateDetailFolderSelect(folders, meeting.folder_id);
            populateResurfaceGrid(types);

            // Init chat if meeting is complete
            if (meeting.status === 'complete' && window.ChatModule) {
                window.ChatModule.init(meetingId);
            }
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
            if (summary.action_items.length === 0) {
                actionsEl.innerHTML = '<p class="text-secondary">No action items recorded.</p>';
            } else {
                actionsEl.innerHTML = summary.action_items.map(item => `
          <div class="action-item">
            <div class="action-checkbox" onclick="this.classList.toggle('checked')"></div>
            <div class="action-item-body">
              <div class="action-task">${escapeHtml(item.task)}</div>
              <div class="action-pills">
                ${item.owner ? `<span class="action-pill owner"><i data-lucide="user"></i> ${escapeHtml(item.owner)}</span>` : ''}
                ${item.deadline ? `<span class="action-pill deadline"><i data-lucide="calendar"></i> ${escapeHtml(item.deadline)}</span>` : ''}
                ${item.priority ? `<span class="priority-dot ${item.priority}" title="${item.priority} priority"></span>` : ''}
              </div>
            </div>
          </div>
        `).join('');
            }
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
            deleteBtn.addEventListener('click', async () => {
                if (!confirm('Delete this meeting? This cannot be undone.')) return;
                try {
                    await api(`/api/recordings/${window.MEETING_ID}`, { method: 'DELETE' });
                    window.location.href = '/';
                } catch (err) {
                    showToast(`Failed to delete: ${err.message}`, 'error');
                }
            });
        }

        // Copy summary
        const copySummaryBtn = getEl('copy-summary-btn');
        if (copySummaryBtn) {
            copySummaryBtn.addEventListener('click', async () => {
                const content = document.getElementById('summary-content');
                if (!content) return;
                try {
                    await navigator.clipboard.writeText(content.innerText || '');
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

    return { init, reload, initDetail };
})();
