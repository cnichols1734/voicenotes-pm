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

            // Desktop: right-click context menu
            btn.addEventListener('contextmenu', e => { e.preventDefault(); openContextMenu(e, folder); });

            // Mobile: long-press action sheet
            addLongPressHandler(btn, folder);

            list.appendChild(btn);
        });
        if (window.lucide) lucide.createIcons();
    }

    // Long-press detection (500 ms hold → action sheet)
    function addLongPressHandler(btn, folder) {
        let timer = null;
        let justLongPressed = false;

        btn.addEventListener('touchstart', () => {
            justLongPressed = false;
            timer = setTimeout(() => {
                justLongPressed = true;
                btn.classList.remove('long-press-active');
                openFolderActionSheet(folder);
            }, 500);
            btn.classList.add('long-press-active');
        }, { passive: true });

        function cancelPress() {
            clearTimeout(timer);
            btn.classList.remove('long-press-active');
        }

        btn.addEventListener('touchend', cancelPress, { passive: true });
        btn.addEventListener('touchmove', cancelPress, { passive: true });
        btn.addEventListener('touchcancel', cancelPress, { passive: true });

        // Capture-phase interceptor: suppress the synthetic click that fires after a long-press
        btn.addEventListener('click', (e) => {
            if (justLongPressed) {
                e.stopImmediatePropagation();
                justLongPressed = false;
            }
        }, true);
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
    // Context menu  (desktop right-click)
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

    // ---------------------------------------------------------------------------
    // Action sheet  (mobile long-press)
    // ---------------------------------------------------------------------------
    function openFolderActionSheet(folder) {
        contextTarget = folder;
        window.showActionSheet({
            title: folder.name,
            actions: [
                {
                    id: 'rename',
                    label: 'Rename',
                    icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
                    handler: () => {
                        contextTarget = folder; // re-set after sheet closes
                        renameFolder();
                    },
                },
                {
                    id: 'color',
                    label: 'Change Color',
                    icon: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>',
                    handler: () => {
                        contextTarget = folder;
                        changeColorFromSheet(folder);
                    },
                },
                {
                    id: 'delete',
                    label: 'Delete Folder',
                    icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>',
                    danger: true,
                    handler: () => {
                        contextTarget = folder;
                        deleteFolderWithConfirm(folder);
                    },
                },
            ],
        });
    }

    function changeColorFromSheet(folder) {
        const colorOptions = ['#6366f1', '#818cf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#38bdf8', '#fb923c'];
        // Cycle to the next color
        const currentIdx = colorOptions.indexOf(folder.color);
        const nextColor = colorOptions[(currentIdx + 1) % colorOptions.length];
        api(`/api/folders/${folder.id}`, { method: 'PUT', body: { color: nextColor } })
            .then(() => {
                const f = folders.find(x => x.id === folder.id);
                if (f) f.color = nextColor;
                renderFolders();
                showToast('Folder color updated.', 'success');
            })
            .catch(err => showToast(`Failed: ${err.message}`, 'error'));
    }

    // ---------------------------------------------------------------------------
    // Rename folder  (shared by context menu & action sheet)
    // ---------------------------------------------------------------------------
    function renameFolder() {
        if (!contextTarget) return;
        const target = contextTarget;
        closeContextMenu();

        window.showConfirmModal({
            title: 'Rename Folder',
            message: null,
            confirmText: 'Save',
            cancelText: 'Cancel',
            isDanger: false,
            inputField: { placeholder: 'Folder name', defaultValue: target.name },
            onConfirm: async (newName) => {
                if (!newName) return;
                try {
                    await api(`/api/folders/${target.id}`, {
                        method: 'PUT',
                        body: { name: newName },
                    });
                    const f = folders.find(x => x.id === target.id);
                    if (f) f.name = newName;
                    renderFolders();
                    showToast('Folder renamed.', 'success');
                } catch (err) {
                    showToast(`Failed to rename: ${err.message}`, 'error');
                }
            },
        });
    }

    // ---------------------------------------------------------------------------
    // Delete folder  (shared by context menu & action sheet)
    // ---------------------------------------------------------------------------
    function deleteFolderWithConfirm(folder) {
        window.showConfirmModal({
            title: 'Delete Folder?',
            message: `"${folder.name}" will be removed. Meetings inside will move to No Folder.`,
            confirmText: 'Delete Folder',
            isDanger: true,
            onConfirm: () => executeFolderDelete(folder.id),
        });
    }

    async function executeFolderDelete(folderId) {
        try {
            await api(`/api/folders/${folderId}`, { method: 'DELETE' });
            folders = folders.filter(f => f.id !== folderId);
            if (window.AppState.currentFolderFilter === folderId) {
                window.AppState.currentFolderFilter = null;
                if (window.MeetingsModule) window.MeetingsModule.reload();
            }
            renderFolders();
            showToast('Folder deleted.', 'success');
        } catch (err) {
            showToast(`Failed to delete folder: ${err.message}`, 'error');
        }
    }

    // Keep old deleteFolder name for context-menu binding
    function deleteFolder() {
        if (!contextTarget) return;
        const target = contextTarget;
        closeContextMenu();
        deleteFolderWithConfirm(target);
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
