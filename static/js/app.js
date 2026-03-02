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
