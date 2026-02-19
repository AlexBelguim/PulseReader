import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Server,
    Wifi,
    WifiOff,
    RefreshCw,
    Check,
    X,
    AlertCircle,
    Settings,
    Download,
    Upload,
    Eye,
    EyeOff,
} from 'lucide-react';
import {
    getSyncConfig,
    saveSyncConfig,
    testConnection,
    performFullSync,
    triggerRescan,
} from '../services/syncService';

const SyncSettings = ({ books, onSyncComplete, onClose }) => {
    const [config, setConfig] = useState(getSyncConfig());
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState(null);
    const [showApiKey, setShowApiKey] = useState(false);

    const handleConfigChange = (field, value) => {
        setConfig((prev) => ({ ...prev, [field]: value }));
        setTestResult(null);
    };

    const handleSave = () => {
        saveSyncConfig(config);
        setTestResult({ success: true, message: 'Settings saved' });
        setTimeout(() => setTestResult(null), 2000);
    };

    const handleTestConnection = async () => {
        setTesting(true);
        setTestResult(null);

        const result = await testConnection(config.serverUrl, config.apiKey);
        setTestResult(result);
        setTesting(false);
    };

    const handleSync = async () => {
        setSyncing(true);
        setSyncResult(null);

        // Save config first
        saveSyncConfig(config);

        try {
            const result = await performFullSync(
                books,
                async (bookData) => {
                    // This will be handled by the parent component
                    return bookData;
                },
                async (id, location, progress) => {
                    // This will be handled by the parent component
                }
            );

            setSyncResult(result);
            if (result.synced && onSyncComplete) {
                onSyncComplete(result);
            }
        } catch (err) {
            setSyncResult({ synced: false, reason: err.message });
        }

        setSyncing(false);
    };

    const handleRescan = async () => {
        setSyncing(true);
        try {
            const result = await triggerRescan();
            setSyncResult({
                synced: true,
                downloaded: 0,
                uploaded: 0,
                progressSynced: 0,
                errors: [],
                message: `Server rescanned: ${result.book_count} books found`,
            });
        } catch (err) {
            setSyncResult({ synced: false, reason: err.message });
        }
        setSyncing(false);
    };

    return (
        <motion.div
            className="sync-settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
        >
            <motion.div
                className="sync-settings-panel"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            >
                <div className="sync-settings-header">
                    <h2>
                        <Server size={20} />
                        Sync Server
                    </h2>
                    <button className="btn-icon" onClick={onClose}>
                        <X size={20} />
                    </button>
                </div>

                <div className="sync-settings-content">
                    {/* Connection Settings */}
                    <div className="sync-section">
                        <h3>Connection</h3>

                        <div className="sync-field">
                            <label>Server URL</label>
                            <input
                                type="url"
                                placeholder="http://192.168.1.50:3000"
                                value={config.serverUrl}
                                onChange={(e) => handleConfigChange('serverUrl', e.target.value)}
                            />
                        </div>

                        <div className="sync-field">
                            <label>API Key</label>
                            <div className="sync-field-with-toggle">
                                <input
                                    type={showApiKey ? 'text' : 'password'}
                                    placeholder="Your API key"
                                    value={config.apiKey}
                                    onChange={(e) => handleConfigChange('apiKey', e.target.value)}
                                />
                                <button
                                    className="btn-icon-sm"
                                    onClick={() => setShowApiKey(!showApiKey)}
                                >
                                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                            </div>
                        </div>

                        <div className="sync-actions-row">
                            <button
                                className="btn btn-secondary"
                                onClick={handleTestConnection}
                                disabled={testing || !config.serverUrl}
                            >
                                {testing ? (
                                    <RefreshCw size={16} className="spinning" />
                                ) : (
                                    <Wifi size={16} />
                                )}
                                {testing ? 'Testing...' : 'Test Connection'}
                            </button>

                            <button
                                className="btn btn-primary"
                                onClick={handleSave}
                                disabled={!config.serverUrl}
                            >
                                <Check size={16} />
                                Save
                            </button>
                        </div>

                        {/* Test Result */}
                        <AnimatePresence>
                            {testResult && (
                                <motion.div
                                    className={`sync-result ${testResult.success ? 'success' : 'error'}`}
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                >
                                    {testResult.success ? (
                                        <>
                                            <Check size={16} />
                                            <span>{testResult.message || `Connected (v${testResult.version})`}</span>
                                        </>
                                    ) : (
                                        <>
                                            <AlertCircle size={16} />
                                            <span>{testResult.error}</span>
                                        </>
                                    )}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Sync Options */}
                    <div className="sync-section">
                        <h3>Sync Options</h3>

                        <label className="sync-toggle">
                            <input
                                type="checkbox"
                                checked={config.enabled}
                                onChange={(e) => handleConfigChange('enabled', e.target.checked)}
                            />
                            <span>Enable sync</span>
                        </label>

                        <label className="sync-toggle">
                            <input
                                type="checkbox"
                                checked={config.autoSync}
                                onChange={(e) => handleConfigChange('autoSync', e.target.checked)}
                            />
                            <span>Auto-sync on app open</span>
                        </label>
                    </div>

                    {/* Sync Actions */}
                    <div className="sync-section">
                        <h3>Actions</h3>

                        <div className="sync-actions-col">
                            <button
                                className="btn btn-primary btn-full"
                                onClick={handleSync}
                                disabled={syncing || !config.serverUrl}
                            >
                                {syncing ? (
                                    <RefreshCw size={16} className="spinning" />
                                ) : (
                                    <RefreshCw size={16} />
                                )}
                                {syncing ? 'Syncing...' : 'Sync Now'}
                            </button>

                            <button
                                className="btn btn-secondary btn-full"
                                onClick={handleRescan}
                                disabled={syncing || !config.serverUrl}
                            >
                                <RefreshCw size={16} />
                                Rescan Server Books Folder
                            </button>
                        </div>

                        {/* Sync Result */}
                        <AnimatePresence>
                            {syncResult && (
                                <motion.div
                                    className={`sync-result ${syncResult.synced ? 'success' : 'error'}`}
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                >
                                    {syncResult.synced ? (
                                        <div className="sync-result-details">
                                            <Check size={16} />
                                            <div>
                                                <p>Sync complete!</p>
                                                {syncResult.message && <p>{syncResult.message}</p>}
                                                {syncResult.downloaded > 0 && (
                                                    <p>
                                                        <Download size={12} /> {syncResult.downloaded} books downloaded
                                                    </p>
                                                )}
                                                {syncResult.uploaded > 0 && (
                                                    <p>
                                                        <Upload size={12} /> {syncResult.uploaded} books uploaded
                                                    </p>
                                                )}
                                                {syncResult.progressSynced > 0 && (
                                                    <p>{syncResult.progressSynced} progress updates synced</p>
                                                )}
                                                {syncResult.errors?.length > 0 && (
                                                    <div className="sync-errors">
                                                        {syncResult.errors.map((err, i) => (
                                                            <p key={i} className="sync-error-item">⚠ {err}</p>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <AlertCircle size={16} />
                                            <span>{syncResult.reason}</span>
                                        </>
                                    )}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Info */}
                    <div className="sync-section sync-info">
                        <h3>Server Setup</h3>
                        <p>
                            Run the PulseReader Sync Server on your TrueNAS or any Docker host.
                            Place your epub files in the books folder organized by series:
                        </p>
                        <pre className="sync-folder-structure">
{`books/
  Series Name/
    cover.jpg        (optional)
    Volume 1.epub
    Volume 2.epub
  Another Series/
    Book.epub
    Book.jpg         (optional cover)`}
                        </pre>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
};

export default SyncSettings;
