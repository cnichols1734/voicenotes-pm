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
// Page initialization
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const page = window.PAGE || '';

    if (page === 'dashboard') {
        initDashboard();
    } else if (page === 'detail') {
        initDetailPage();
    } else if (page === 'meeting-types') {
        initMeetingTypesPage();
    }
});

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

    // Sidebar hamburger for mobile
    const backdrop = document.getElementById('sidebar-backdrop');
    const sidebar = document.getElementById('sidebar');
    if (backdrop) {
        backdrop.addEventListener('click', () => {
            sidebar && sidebar.classList.remove('open');
            backdrop.classList.remove('visible');
        });
    }
}

function initDetailPage() {
    window.MeetingsModule && window.MeetingsModule.initDetail();
}

function initMeetingTypesPage() {
    window.PromptEditorModule && window.PromptEditorModule.init();
}
