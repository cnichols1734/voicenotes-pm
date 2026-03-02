/**
 * VoiceNotes PM - Prompt editor module.
 * Manages meeting type card grid, create/edit modal, and reset functionality.
 */

window.PromptEditorModule = (() => {
    const ICONS = ['file-text', 'rocket', 'search', 'briefcase', 'bar-chart', 'target', 'lightbulb', 'pen-tool', 'users', 'zap', 'wrench', 'graduation-cap', 'trending-up', 'map', 'microscope', 'globe', 'mic', 'pin', 'key', 'message-square'];
    let selectedIcon = 'file-text';
    let isEditing = false;
    let editingId = null;

    function getEl(id) { return document.getElementById(id); }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    async function init() {
        buildIconPicker();
        bindModalEvents();
        await loadAndRender();
    }

    async function loadAndRender() {
        try {
            const data = await api('/api/meeting-types');
            renderGrid(data.meeting_types || []);
        } catch (err) {
            showToast(`Failed to load meeting types: ${err.message}`, 'error');
        }
    }

    // ---------------------------------------------------------------------------
    // Grid rendering
    // ---------------------------------------------------------------------------
    function renderGrid(types) {
        const grid = getEl('meeting-types-grid');
        if (!grid) return;
        grid.innerHTML = '';

        types.forEach(type => {
            const card = document.createElement('div');
            card.className = 'type-card';
            card.innerHTML = `
        <div class="type-card-header">
          <div class="type-card-icon"><i data-lucide="${type.icon || 'file-text'}"></i></div>
          <div class="type-card-info">
            <div class="type-card-name">${escapeHtml(type.name)}</div>
            <div class="type-card-desc">${escapeHtml(type.description || '')}</div>
          </div>
        </div>
        <div class="type-card-footer">
          <div>
            ${type.is_default ? '<span class="badge badge-type" style="font-size:10px;">Default</span>' : ''}
          </div>
          <button class="btn btn-secondary btn-sm edit-type-btn" data-id="${type.id}">Edit</button>
        </div>
      `;

            card.querySelector('.edit-type-btn').addEventListener('click', () => openEditModal(type));
            grid.appendChild(card);
        });

        // "Add New" card
        const addCard = document.createElement('div');
        addCard.className = 'type-card type-card-add';
        addCard.innerHTML = `
      <div class="type-card-add-icon"><i data-lucide="plus"></i></div>
      <div class="type-card-add-label">Add Meeting Type</div>
    `;
        addCard.addEventListener('click', () => openCreateModal());
        grid.appendChild(addCard);

        if (window.lucide) lucide.createIcons();
    }

    // ---------------------------------------------------------------------------
    // Modal
    // ---------------------------------------------------------------------------
    function openEditModal(type) {
        isEditing = true;
        editingId = type.id;

        getEl('type-modal-title').textContent = 'Edit Meeting Type';
        getEl('edit-type-id').value = type.id;
        getEl('edit-type-name').value = type.name;
        getEl('edit-type-desc').value = type.description || '';
        getEl('edit-type-prompt').value = type.prompt_template;
        updateCharCount();

        selectedIcon = type.icon || 'file-text';
        updateIconSelection();

        const saveBtn = getEl('save-type-btn');
        if (saveBtn) saveBtn.textContent = 'Save Changes';

        const deleteBtn = getEl('delete-type-btn');
        const resetBtn = getEl('reset-type-btn');

        if (deleteBtn) deleteBtn.classList.toggle('hidden', !!type.is_default);
        if (resetBtn) resetBtn.classList.toggle('hidden', !type.is_default);

        getEl('type-modal').classList.add('visible');
    }

    function openCreateModal() {
        isEditing = false;
        editingId = null;

        getEl('type-modal-title').textContent = 'Add Meeting Type';
        getEl('edit-type-id').value = '';
        getEl('edit-type-name').value = '';
        getEl('edit-type-desc').value = '';
        getEl('edit-type-prompt').value = '';
        updateCharCount();

        selectedIcon = 'file-text';
        updateIconSelection();

        const saveBtn = getEl('save-type-btn');
        if (saveBtn) saveBtn.textContent = 'Create';

        getEl('delete-type-btn').classList.add('hidden');
        getEl('reset-type-btn').classList.add('hidden');

        getEl('type-modal').classList.add('visible');
    }

    function closeModal() {
        getEl('type-modal').classList.remove('visible');
        isEditing = false;
        editingId = null;
    }

    // ---------------------------------------------------------------------------
    // Save / Create / Delete / Reset
    // ---------------------------------------------------------------------------
    async function saveType() {
        const name = getEl('edit-type-name').value.trim();
        const desc = getEl('edit-type-desc').value.trim();
        const prompt = getEl('edit-type-prompt').value.trim();

        if (!name) { showToast('Name is required.', 'error'); return; }
        if (!prompt) { showToast('Prompt template is required.', 'error'); return; }
        if (!prompt.includes('{transcript}')) {
            showToast('Prompt must include {transcript} placeholder.', 'error');
            return;
        }

        const payload = { name, description: desc, prompt_template: prompt, icon: selectedIcon };

        try {
            if (isEditing && editingId) {
                await api(`/api/meeting-types/${editingId}`, { method: 'PUT', body: payload });
                showToast('Meeting type updated.', 'success');
            } else {
                await api('/api/meeting-types', { method: 'POST', body: payload });
                showToast('Meeting type created.', 'success');
            }
            closeModal();
            await loadAndRender();
        } catch (err) {
            showToast(`Failed to save: ${err.message}`, 'error');
        }
    }

    async function deleteType() {
        if (!editingId) return;
        if (!confirm('Delete this meeting type? Meetings using it will keep their summaries but lose the type link.')) return;
        try {
            await api(`/api/meeting-types/${editingId}`, { method: 'DELETE' });
            showToast('Meeting type deleted.', 'success');
            closeModal();
            await loadAndRender();
        } catch (err) {
            showToast(`Failed to delete: ${err.message}`, 'error');
        }
    }

    async function resetType() {
        if (!editingId) return;
        if (!confirm('Reset this prompt to its original default? All your edits will be lost.')) return;
        try {
            const data = await api(`/api/meeting-types/${editingId}/reset`, { method: 'POST' });
            getEl('edit-type-prompt').value = data.meeting_type.prompt_template;
            updateCharCount();
            showToast('Prompt reset to default.', 'success');
        } catch (err) {
            showToast(`Failed to reset: ${err.message}`, 'error');
        }
    }

    // ---------------------------------------------------------------------------
    // Icon picker
    // ---------------------------------------------------------------------------
    function buildIconPicker() {
        const picker = getEl('icon-picker-grid');
        if (!picker) return;
        picker.innerHTML = '';
        ICONS.forEach(icon => {
            const btn = document.createElement('div');
            btn.className = 'icon-option';
            btn.innerHTML = `<i data-lucide="${icon}"></i>`;
            btn.title = icon;
            btn.dataset.icon = icon;
            btn.addEventListener('click', () => {
                selectedIcon = icon;
                getEl('edit-type-icon').value = icon;
                updateIconSelection();
            });
            picker.appendChild(btn);
        });
    }

    function updateIconSelection() {
        document.querySelectorAll('.icon-option').forEach(el => {
            el.classList.toggle('selected', el.dataset.icon === selectedIcon);
        });
    }

    // ---------------------------------------------------------------------------
    // Textarea character count + auto-resize
    // ---------------------------------------------------------------------------
    function updateCharCount() {
        const ta = getEl('edit-type-prompt');
        const cc = getEl('char-count');
        if (ta && cc) cc.textContent = `${ta.value.length.toLocaleString()} characters`;
    }

    // ---------------------------------------------------------------------------
    // Event binding
    // ---------------------------------------------------------------------------
    function bindModalEvents() {
        const closeBtn = getEl('type-modal-close');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);

        const cancelBtn = getEl('type-modal-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

        const saveBtn = getEl('save-type-btn');
        if (saveBtn) saveBtn.addEventListener('click', saveType);

        const deleteBtn = getEl('delete-type-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', deleteType);

        const resetBtn = getEl('reset-type-btn');
        if (resetBtn) resetBtn.addEventListener('click', resetType);

        const promptTa = getEl('edit-type-prompt');
        if (promptTa) {
            promptTa.addEventListener('input', () => {
                updateCharCount();
                // Auto-resize
                promptTa.style.height = 'auto';
                promptTa.style.height = `${Math.max(400, promptTa.scrollHeight)}px`;
            });
        }

        // Close on backdrop click
        const backdrop = getEl('type-modal');
        if (backdrop) {
            backdrop.addEventListener('click', e => {
                if (e.target === backdrop) closeModal();
            });
        }
    }

    function escapeHtml(str) {
        return window.escapeHtml ? window.escapeHtml(str) : (str || '');
    }

    return { init };
})();
