/**
 * VoiceNotes PM - Main app entry point.
 * Provides global state, utilities, API wrapper, and page initialization.
 */

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
window.AppState = {
    currentFolderFilter: null,
    currentTypeFilter: null,
    searchQuery: '',
    sortOrder: 'newest',
    meetingTypes: [],
    folders: [],
};

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
window.showToast = function (message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { toast.classList.add('show'); });
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
    }, 3500);
};

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
window.formatDate = function (isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const now = new Date();
    const diff = now - d;

    if (diff < 60 * 1000) return 'Just now';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 7 * 24 * 60 * 60 * 1000) {
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

window.formatDuration = function (seconds) {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// API wrapper
// ---------------------------------------------------------------------------
window.api = async function (endpoint, options = {}) {
    const url = endpoint.startsWith('/') ? endpoint : `/api/${endpoint}`;
    const config = {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        config.body = JSON.stringify(options.body);
    }
    if (options.body instanceof FormData) {
        delete config.headers['Content-Type'];
    }

    const response = await fetch(url, config);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const msg = data.error || data.message || `Request failed (${response.status})`;
        throw new Error(msg);
    }
    return data;
};

// ---------------------------------------------------------------------------
// Custom Confirm Modal  (replaces native browser confirm/alert)
// ---------------------------------------------------------------------------
window.showConfirmModal = function ({ title, message, confirmText = 'Delete', cancelText = 'Cancel', isDanger = true, inputField = null, onConfirm }) {
    const existing = document.getElementById('_confirm_modal_root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = '_confirm_modal_root';

    // Only show the icon for confirm dialogs, not for input prompts
    const iconHtml = inputField ? '' : (() => {
        const bg = isDanger ? 'rgba(255,69,58,0.14)' : 'rgba(10,132,255,0.12)';
        const col = isDanger ? 'var(--accent-danger)' : 'var(--accent-primary)';
        const path = isDanger
            ? `<polyline points="3 6 5 6 21 6"/>
               <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
               <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>`
            : `<circle cx="12" cy="12" r="10"/>
               <line x1="12" y1="8" x2="12" y2="12"/>
               <line x1="12" y1="16" x2="12.01" y2="16"/>`;
        return `<div class="confirm-modal-icon" style="background:${bg};">
                  <svg viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round">${path}</svg>
                </div>`;
    })();

    const inputHtml = inputField
        ? `<div class="confirm-modal-input-wrap">
             <input class="confirm-modal-input" type="text" id="_confirm_modal_input"
               placeholder="${inputField.placeholder || ''}"
               value="${(inputField.defaultValue || '').replace(/"/g, '&quot;')}"
               autocomplete="off" autocorrect="off" spellcheck="false" />
           </div>`
        : '';

    root.innerHTML = `
      <div class="confirm-modal-backdrop" id="_confirm_modal_bd">
        <div class="confirm-modal" role="alertdialog" aria-modal="true">
          ${iconHtml}
          <div class="confirm-modal-title" style="${inputField ? 'padding-top:24px;' : ''}">${title}</div>
          ${message ? `<div class="confirm-modal-desc">${message}</div>` : ''}
          ${inputHtml}
          <div class="confirm-modal-actions">
            <button class="confirm-modal-btn ${isDanger ? 'btn-danger' : 'btn-primary-action'}" id="_confirm_modal_ok">${confirmText}</button>
            <button class="confirm-modal-btn btn-cancel" id="_confirm_modal_cancel">${cancelText}</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(root);

    const backdrop = root.querySelector('#_confirm_modal_bd');
    const inputEl = root.querySelector('#_confirm_modal_input');

    function close() {
        backdrop.classList.remove('visible');
        setTimeout(() => root.remove(), 350);
    }

    requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('visible')));

    if (inputEl) {
        setTimeout(() => inputEl.focus(), 400);
        inputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter') root.querySelector('#_confirm_modal_ok').click();
            if (e.key === 'Escape') close();
        });
    }

    root.querySelector('#_confirm_modal_ok').addEventListener('click', () => {
        close();
        if (onConfirm) onConfirm(inputEl ? inputEl.value.trim() : undefined);
    });

    root.querySelector('#_confirm_modal_cancel').addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
};

// ---------------------------------------------------------------------------
// Folder Action Sheet  (iOS-style bottom sheet)
// ---------------------------------------------------------------------------
window.showActionSheet = function ({ title, actions, onCancel }) {
    const existing = document.getElementById('_action_sheet_root');
    if (existing) existing.remove();

    const actionsHtml = actions.map(a => `
      <button class="action-sheet-item ${a.danger ? 'action-danger' : ''}" data-as-id="${a.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${a.icon}</svg>
        ${a.label}
      </button>`).join('');

    const root = document.createElement('div');
    root.id = '_action_sheet_root';
    root.innerHTML = `
      <div class="action-sheet-backdrop" id="_as_bd"></div>
      <div class="action-sheet" id="_as_sheet" role="dialog" aria-modal="true">
        <div class="action-sheet-group">
          ${title ? `<div class="action-sheet-header">${title}</div>` : ''}
          ${actionsHtml}
        </div>
        <div class="action-sheet-cancel-group">
          <button class="action-sheet-cancel-btn" id="_as_cancel">Cancel</button>
        </div>
      </div>`;

    document.body.appendChild(root);

    const backdrop = root.querySelector('#_as_bd');
    const sheet = root.querySelector('#_as_sheet');

    function close(cb) {
        backdrop.classList.remove('visible');
        sheet.classList.remove('visible');
        setTimeout(() => { root.remove(); if (cb) cb(); }, 320);
    }

    requestAnimationFrame(() => requestAnimationFrame(() => {
        backdrop.classList.add('visible');
        sheet.classList.add('visible');
    }));

    backdrop.addEventListener('click', () => close(onCancel));
    root.querySelector('#_as_cancel').addEventListener('click', () => close(onCancel));

    actions.forEach(action => {
        const btn = root.querySelector(`[data-as-id="${action.id}"]`);
        if (btn && action.handler) btn.addEventListener('click', () => close(action.handler));
    });
};

// ---------------------------------------------------------------------------
// Page initialization
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const page = window.PAGE || '';

    // Hamburger nav menu (all pages)
    initNavMenu();

    if (page === 'dashboard') {
        initDashboard();
    } else if (page === 'detail') {
        initDetailPage();
    } else if (page === 'meeting-types') {
        initMeetingTypesPage();
    }
});

// ---------------------------------------------------------------------------
// Mobile nav menu (hamburger)
// ---------------------------------------------------------------------------
function initNavMenu() {
    const hamburger = document.getElementById('nav-hamburger');
    const navLinks = document.getElementById('nav-links');
    const backdrop = document.getElementById('nav-menu-backdrop');

    if (!hamburger || !navLinks) return;

    function openMenu() {
        navLinks.classList.add('open');
        if (backdrop) backdrop.classList.add('visible');
    }
    function closeMenu() {
        navLinks.classList.remove('open');
        if (backdrop) backdrop.classList.remove('visible');
    }

    hamburger.addEventListener('click', () => {
        if (navLinks.classList.contains('open')) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    if (backdrop) {
        backdrop.addEventListener('click', closeMenu);
    }

    // Close menu when a nav link is clicked (mobile)
    navLinks.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', closeMenu);
    });
}

function initDashboard() {
    // Load folders and meetings in parallel
    Promise.all([
        window.FoldersModule && window.FoldersModule.init(),
        window.MeetingsModule && window.MeetingsModule.init(),
    ]);

    // Record FAB
    const fab = document.getElementById('record-fab');
    if (fab) {
        fab.addEventListener('click', () => {
            window.RecorderModule && window.RecorderModule.openOverlay();
        });
    }

    // Sidebar toggle + backdrop for mobile
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const sidebarToggle = document.getElementById('sidebar-toggle');

    function openSidebar() {
        if (sidebar) sidebar.classList.add('open');
        if (backdrop) backdrop.classList.add('visible');
    }

    function closeSidebar() {
        if (sidebar) sidebar.classList.remove('open');
        if (backdrop) backdrop.classList.remove('visible');
    }

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            if (sidebar && sidebar.classList.contains('open')) {
                closeSidebar();
            } else {
                openSidebar();
            }
        });
    }

    if (backdrop) {
        backdrop.addEventListener('click', closeSidebar);
    }

    // Auto-close sidebar when a sidebar item is clicked (mobile)
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 1024) closeSidebar();
        });
    });

    // Also observe dynamically-added sidebar items via event delegation
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl) {
        sidebarEl.addEventListener('click', (e) => {
            const item = e.target.closest('.sidebar-item');
            if (item && window.innerWidth <= 1024) {
                closeSidebar();
            }
        });
    }

    // Expose closeSidebar globally so folders.js can use it if needed
    window._closeSidebar = closeSidebar;
}

function initDetailPage() {
    window.MeetingsModule && window.MeetingsModule.initDetail();
}

function initMeetingTypesPage() {
    window.PromptEditorModule && window.PromptEditorModule.init();
}
