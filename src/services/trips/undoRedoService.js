/**
 * undoRedoService.js
 * IndexedDB-backed Command Stack for Undo / Redo operations.
 * Each command must supply async execute() and async undo() so persistence stays the single source of truth.
 */

export function createUndoManager(maxHistory = 30) {
    let undoStack = [];
    let redoStack = [];
    const listeners = new Set();

    const notify = () => {
        const snapshot = {
            canUndo: undoStack.length > 0,
            canRedo: redoStack.length > 0,
            undoLabel: undoStack[undoStack.length - 1]?.label || '',
            redoLabel: redoStack[redoStack.length - 1]?.label || '',
            undoCount: undoStack.length,
            redoCount: redoStack.length,
        };
        listeners.forEach((fn) => fn(snapshot));
    };

    return {
        /**
         * Push an already-executed command (or execute it first when runExecute = true).
         * @param {{ label: string, execute: () => Promise<void>, undo: () => Promise<void> }} command
         * @param {boolean} [runExecute=false]
         */
        async push(command, runExecute = false) {
            if (!command || typeof command.undo !== 'function' || typeof command.execute !== 'function') {
                throw new Error('Invalid undo command: execute() and undo() are required');
            }
            if (runExecute) {
                await command.execute();
            }
            undoStack.push(command);
            if (undoStack.length > maxHistory) {
                undoStack = undoStack.slice(undoStack.length - maxHistory);
            }
            redoStack = [];
            notify();
        },

        async undo() {
            if (undoStack.length === 0) return null;
            const cmd = undoStack.pop();
            try {
                await cmd.undo();
                redoStack.push(cmd);
                notify();
                return cmd;
            } catch (err) {
                // Restore stack if persistence failed
                undoStack.push(cmd);
                notify();
                throw err;
            }
        },

        async redo() {
            if (redoStack.length === 0) return null;
            const cmd = redoStack.pop();
            try {
                await cmd.execute();
                undoStack.push(cmd);
                notify();
                return cmd;
            } catch (err) {
                redoStack.push(cmd);
                notify();
                throw err;
            }
        },

        clear() {
            undoStack = [];
            redoStack = [];
            notify();
        },

        getState() {
            return {
                canUndo: undoStack.length > 0,
                canRedo: redoStack.length > 0,
                undoLabel: undoStack[undoStack.length - 1]?.label || '',
                redoLabel: redoStack[redoStack.length - 1]?.label || '',
                undoCount: undoStack.length,
                redoCount: redoStack.length,
            };
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
