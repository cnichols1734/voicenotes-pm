/**
 * VoiceNotes PM - Admin panel module.
 * Loads users, renders the table, and handles enable/disable toggles.
 */

(function () {
    'use strict';

    let users = [];

    async function loadUsers() {
        try {
            const data = await window.api('/api/admin/users');
            users = data.users || [];
            renderStats();
            renderTable();
        } catch (err) {
            window.showToast('Failed to load users: ' + err.message, 'error');
        }
    }

    function renderStats() {
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.is_active).length;
        const totalMeetings = users.reduce((sum, u) => sum + (u.meeting_count || 0), 0);

        const el = (id, val) => {
            const e = document.getElementById(id);
            if (e) e.textContent = val;
        };
        el('stat-total-users', totalUsers);
        el('stat-active-users', activeUsers);
        el('stat-total-meetings', totalMeetings);
    }

    function renderTable() {
        const tbody = document.getElementById('users-tbody');
        if (!tbody) return;

        if (users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-secondary);">No users found</td></tr>`;
            return;
        }

        tbody.innerHTML = users.map(user => {
            const joined = window.formatDate ? window.formatDate(user.created_at) : new Date(user.created_at).toLocaleDateString();
            const roleClass = user.role === 'admin' ? 'badge-admin' : 'badge-user';
            const statusClass = user.is_active ? 'status-active' : 'status-disabled';
            const statusLabel = user.is_active ? 'Active' : 'Disabled';
            const isAdmin = user.role === 'admin';

            return `
                <tr class="${!user.is_active ? 'row-disabled' : ''}">
                    <td>
                        <div class="user-cell">
                            <div class="user-avatar">${user.display_name.charAt(0).toUpperCase()}</div>
                            <div>
                                <div class="user-name">${escapeHtml(user.display_name)}</div>
                                <div class="user-email">${escapeHtml(user.email)}</div>
                            </div>
                        </div>
                    </td>
                    <td><span class="badge ${roleClass}">${user.role}</span></td>
                    <td><span class="meeting-count">${user.meeting_count}</span></td>
                    <td class="text-secondary">${joined}</td>
                    <td><span class="status-dot ${statusClass}"></span> ${statusLabel}</td>
                    <td>
                        ${!isAdmin ? `
                            <button class="btn btn-sm ${user.is_active ? 'btn-danger' : 'btn-primary'}"
                                    onclick="AdminModule.toggleUser('${user.id}')">
                                ${user.is_active ? 'Disable' : 'Enable'}
                            </button>
                        ` : '<span class="text-tertiary" style="font-size:12px;">—</span>'}
                    </td>
                </tr>
            `;
        }).join('');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    async function toggleUser(userId) {
        try {
            const data = await window.api(`/api/admin/users/${userId}/toggle`, { method: 'POST' });
            window.showToast(data.message, 'success');
            await loadUsers();
        } catch (err) {
            window.showToast('Failed: ' + err.message, 'error');
        }
    }

    // Public API
    window.AdminModule = { toggleUser };

    // Init on page load
    document.addEventListener('DOMContentLoaded', () => {
        if (window.PAGE === 'admin') {
            loadUsers();
        }
    });
})();
