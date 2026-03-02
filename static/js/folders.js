/**
 * VoiceNotes PM - Folders module.
 * Manages folder CRUD in the sidebar, color picker, and filtering.
 */

window.FoldersModule = (() => {
    let folders = [];
    let contextTarget = null; // { id, name, color }
    let selectedColor = '#6366f1';

    function getEl(id) { return document.getElementById(id); }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    async function init() {
        await loadFolders();
        bindEvents();
    }

    async function loadFolders() {
        try {
            const data = await api('/api/folders');
            folders = data.folders || [];
            window.AppState.folders = folders;
            renderFolders();
            updateFolderCount();
            renderTypeChips();
        } catch (err) {
            console.error('Failed to load folders:', err);
        }
    }

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------
    function renderFolders() {
        const list = getEl('folders-list');
        if (!list) return;
        list.innerHTML = '';

        if (folders.length === 0) {
            list.innerHTML = '<div class="text-small" style="padding:6px 10px;color:var(--text-tertiary);">No folders yet</div>';
            return;
        }

        folders.forEach(folder => {
            const btn = document.createElement('button');
            btn.className = 'sidebar-item';
            btn.dataset.folderId = folder.id;
            if (window.AppState.currentFolderFilter === folder.id) btn.classList.add('active');
            btn.innerHTML = `
        <span class="sidebar-item-icon" style="color:${folder.color};"><i data-lucide="${folder.icon || 'folder'}"></i></span>
        <span class="sidebar-item-name">${folder.name}</span>
      `;
            btn.addEventListener('click', () => selectFolder(folder.id));
            btn.addEventListener('contextmenu', e => { e.preventDefault(); openContextMenu(e, folder); });
            list.appendChild(btn);
        });
        if (window.lucide) lucide.createIcons();
    }

    function updateFolderCount() {
        // The total count is shown next to "All Meetings"
        // Actual count comes from meetings module
    }

    async function renderTypeChips() {
        const container = getEl('type-filter-chips');
        if (!container) return;
        container.innerHTML = '';
        try {
            const data = await api('/api/meeting-types');
            const types = data.meeting_types || [];
            window.AppState.meetingTypes = types;

            types.forEach(type => {
                const btn = document.createElement('button');
                btn.className = 'sidebar-item';
                if (window.AppState.currentTypeFilter === type.id) btn.classList.add('active');
                btn.innerHTML = `
          <span class="sidebar-item-icon"><i data-lucide="${type.icon || 'file-text'}"></i></span>
          <span class="sidebar-item-name">${type.name}</span>
        `;
                btn.addEventListener('click', () => selectTypeFilter(type.id));
                container.appendChild(btn);
            });
            if (window.lucide) lucide.createIcons();
        } catch (e) { /* skip */ }
    }

    // ---------------------------------------------------------------------------
    // Filtering
    // ---------------------------------------------------------------------------
    function selectFolder(folderId) {
        const wasActive = window.AppState.currentFolderFilter === folderId;
        window.AppState.currentFolderFilter = wasActive ? null : folderId;
        window.AppState.currentTypeFilter = null;
        updateSidebarActive();
        if (window.MeetingsModule) window.MeetingsModule.reload();
    }

    function selectTypeFilter(typeId) {
        const wasActive = window.AppState.currentTypeFilter === typeId;
        window.AppState.currentTypeFilter = wasActive ? null : typeId;
        window.AppState.currentFolderFilter = null;
        updateSidebarActive();
        if (window.MeetingsModule) window.MeetingsModule.reload();
    }

    function updateSidebarActive() {
        document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
        if (!window.AppState.currentFolderFilter && !window.AppState.currentTypeFilter) {
            const allBtn = getEl('filter-all');
            if (allBtn) allBtn.classList.add('active');
        }
        if (window.AppState.currentFolderFilter) {
            const btn = document.querySelector(`[data-folder-id="${window.AppState.currentFolderFilter}"]`);
            if (btn) btn.classList.add('active');
        }
    }

    // ---------------------------------------------------------------------------
    // Create folder
    // ---------------------------------------------------------------------------
    async function createFolder() {
        const nameInput = getEl('new-folder-name');
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) { showToast('Please enter a folder name.', 'error'); return; }

        try {
            const data = await api('/api/folders', {
                method: 'POST',
                body: { name, color: selectedColor, icon: 'folder' },
            });
            folders.push(data.folder);
            renderFolders();
            hideCreateForm();
            showToast(`Folder "${name}" created.`, 'success');
        } catch (err) {
            showToast(`Failed to create folder: ${err.message}`, 'error');
        }
    }

    function showCreateForm() {
        const form = getEl('create-folder-form');
        if (form) form.classList.add('visible');
        const input = getEl('new-folder-name');
        if (input) { input.value = ''; input.focus(); }
        selectedColor = '#6366f1';
        document.querySelectorAll('#new-folder-colors .color-swatch').forEach(s => {
            s.classList.toggle('selected', s.dataset.color === selectedColor);
        });
    }

    function hideCreateForm() {
        const form = getEl('create-folder-form');
        if (form) form.classList.remove('visible');
    }

    // ---------------------------------------------------------------------------
    // Context menu
    // ---------------------------------------------------------------------------
    function openContextMenu(event, folder) {
        contextTarget = folder;
        const menu = getEl('folder-context-menu');
        if (!menu) return;
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;
        menu.classList.add('visible');
    }

    function closeContextMenu() {
        const menu = getEl('folder-context-menu');
        if (menu) menu.classList.remove('visible');
        contextTarget = null;
    }

    async function renameFolder() {
        if (!contextTarget) return;
        closeContextMenu();
        const newName = prompt('Rename folder:', contextTarget.name);
        if (!newName || !newName.trim()) return;
        try {
            await api(`/api/folders/${contextTarget.id}`, {
                method: 'PUT',
                body: { name: newName.trim() },
            });
            const f = folders.find(x => x.id === contextTarget.id);
            if (f) f.name = newName.trim();
            renderFolders();
            showToast('Folder renamed.', 'success');
        } catch (err) {
            showToast(`Failed to rename: ${err.message}`, 'error');
        }
    }

    async function deleteFolder() {
        if (!contextTarget) return;
        closeContextMenu();
        if (!confirm(`Delete folder "${contextTarget.name}"? Meetings in it will remain unfiled.`)) return;
        try {
            await api(`/api/folders/${contextTarget.id}`, { method: 'DELETE' });
            folders = folders.filter(f => f.id !== contextTarget.id);
            if (window.AppState.currentFolderFilter === contextTarget.id) {
                window.AppState.currentFolderFilter = null;
                if (window.MeetingsModule) window.MeetingsModule.reload();
            }
            renderFolders();
            showToast('Folder deleted.', 'success');
        } catch (err) {
            showToast(`Failed to delete folder: ${err.message}`, 'error');
        }
    }

    // ---------------------------------------------------------------------------
    // Event binding
    // ---------------------------------------------------------------------------
    function bindEvents() {
        const createBtn = getEl('create-folder-btn');
        if (createBtn) createBtn.addEventListener('click', showCreateForm);

        const confirmBtn = getEl('confirm-create-folder');
        if (confirmBtn) confirmBtn.addEventListener('click', createFolder);

        const cancelBtn = getEl('cancel-create-folder');
        if (cancelBtn) cancelBtn.addEventListener('click', hideCreateForm);

        const nameInput = getEl('new-folder-name');
        if (nameInput) {
            nameInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') createFolder();
                if (e.key === 'Escape') hideCreateForm();
            });
        }

        // Color swatches
        document.querySelectorAll('#new-folder-colors .color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                selectedColor = swatch.dataset.color;
                document.querySelectorAll('#new-folder-colors .color-swatch').forEach(s => s.classList.remove('selected'));
                swatch.classList.add('selected');
            });
        });

        // Context menu actions
        const ctxRename = getEl('ctx-rename');
        if (ctxRename) ctxRename.addEventListener('click', renameFolder);

        const ctxDelete = getEl('ctx-delete');
        if (ctxDelete) ctxDelete.addEventListener('click', deleteFolder);

        const ctxColor = getEl('ctx-change-color');
        if (ctxColor) ctxColor.addEventListener('click', async () => {
            if (!contextTarget) return;
            closeContextMenu();
            const colorOptions = ['#6366f1', '#818cf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#38bdf8', '#fb923c'];
            const picked = colorOptions.find(c => c !== contextTarget.color) || colorOptions[0];
            try {
                await api(`/api/folders/${contextTarget.id}`, { method: 'PUT', body: { color: picked } });
                const f = folders.find(x => x.id === contextTarget.id);
                if (f) f.color = picked;
                renderFolders();
                showToast('Folder color updated.', 'success');
            } catch (err) {
                showToast(`Failed: ${err.message}`, 'error');
            }
        });

        // All meetings filter
        const allBtn = getEl('filter-all');
        if (allBtn) {
            allBtn.addEventListener('click', () => {
                window.AppState.currentFolderFilter = null;
                window.AppState.currentTypeFilter = null;
                updateSidebarActive();
                if (window.MeetingsModule) window.MeetingsModule.reload();
            });
        }

        // Close context menu on outside click
        document.addEventListener('click', () => closeContextMenu());
    }

    return { init, reload: loadFolders };
})();
