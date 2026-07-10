/**
 * VoiceNotes PM - IndexedDB persistence for in-progress / failed recordings.
 * Ensures a long meeting recording can be retried after upload failures
 * or page reloads instead of being lost forever.
 */
window.RecordingDrafts = (() => {
    const DB_NAME = 'voicenotes-drafts';
    const DB_VERSION = 1;
    const STORE = 'drafts';
    const ACTIVE_KEY = 'active';

    function openDb() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB not available'));
                return;
            }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('Failed to open drafts DB'));
        });
    }

    async function putDraft(draft) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(draft);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function getDraft(id = ACTIVE_KEY) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(id);
            req.onsuccess = () => { db.close(); resolve(req.result || null); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }

    async function deleteDraft(id = ACTIVE_KEY) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function listDrafts() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () => { db.close(); resolve(req.result || []); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }

    /** Save (or update) the active recording draft. */
    async function saveActive(fields) {
        const existing = (await getDraft(ACTIVE_KEY)) || { id: ACTIVE_KEY };
        const draft = {
            ...existing,
            ...fields,
            id: ACTIVE_KEY,
            updatedAt: Date.now(),
        };
        if (!draft.createdAt) draft.createdAt = Date.now();
        await putDraft(draft);
        return draft;
    }

    return {
        ACTIVE_KEY,
        saveActive,
        getDraft,
        deleteDraft,
        listDrafts,
        putDraft,
    };
})();
