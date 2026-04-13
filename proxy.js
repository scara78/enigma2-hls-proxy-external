const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const app = express();
app.set('trust proxy', true); // Trust Easypanel/Traefik reverse proxy headers
const PORT = 8080;
const BASE_HLS_DIR = path.join(__dirname, "tmp", "hls");
const QUALITY_PRESETS_FILE = path.join(__dirname, "quality-presets.json");

// Simple in-memory encryption for credentials
const ENCRYPTION_KEY = crypto.randomBytes(32);
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    if (!text) return null;
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = parts.join(':');
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.error("Decryption error:", e.message);
        return null;
    }
}

// Detect base URL from request (works behind reverse proxies like Easypanel/Traefik)
function getBaseUrl(req) {
    // Easypanel/Traefik set X-Forwarded-Proto and X-Forwarded-Host
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    return `${proto}://${host}`;
}

// Create base directory
if (!fs.existsSync(BASE_HLS_DIR)) {
    fs.mkdirSync(BASE_HLS_DIR, { recursive: true });
    console.log(`📁 Created HLS directory: ${BASE_HLS_DIR}`);
}

// ============================================
// Load quality presets from JSON file
// ============================================
let qualityPresets = {};
try {
    if (!fs.existsSync(QUALITY_PRESETS_FILE)) {
        console.error("❌ quality-presets.json not found!");
        console.error("   Please create this file with your quality settings.");
        process.exit(1);
    }
    
    const data = fs.readFileSync(QUALITY_PRESETS_FILE, 'utf8');
    qualityPresets = JSON.parse(data);
    
    if (Object.keys(qualityPresets).length === 0) {
        console.error("❌ quality-presets.json is empty!");
        process.exit(1);
    }
    
    console.log("✅ Quality presets loaded from quality-presets.json");
    console.log(`   Available: ${Object.keys(qualityPresets).join(', ')}`);
    
} catch (error) {
    console.error("❌ Error loading quality presets:", error.message);
    process.exit(1);
}

// ============================================
// Stream Manager for multiple concurrent streams
// ============================================
// ============================================
// Stream Manager for multiple concurrent streams
// ============================================
class StreamManager {
    constructor() {
        this.streams = new Map();
        // Run cleanup every 30 seconds (häufiger)
        this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
    }

    // Generate unique stream ID from parameters
    generateStreamId(params) {
        const { host, port, user, ref, quality } = params;
        const hasAuth = user ? 'auth' : 'noauth';
        const base = `${host}:${port}:${hasAuth}:${ref}:${quality}`;
        return crypto.createHash('md5').update(base).digest('hex').substring(0, 8);
    }

    // Main cleanup routine
    cleanup() {
        this.cleanupInactiveStreams();
        this.cleanupOldFiles();
    }

    // Strikeres Cleanup alter Dateien (älter als 30 Sekunden)
    cleanupOldFiles() {
        try {
            if (!fs.existsSync(BASE_HLS_DIR)) return;
            
            const now = Date.now();
            const files = fs.readdirSync(BASE_HLS_DIR);
            let deletedCount = 0;
            
            for (const file of files) {
                const filePath = path.join(BASE_HLS_DIR, file);
                
                // Nur .ts und .m3u8 Dateien behandeln
                if (!file.endsWith('.ts') && !file.endsWith('.m3u8')) continue;
                
                try {
                    const stats = fs.statSync(filePath);
                    const age = (now - stats.mtimeMs) / 1000; // Alter in Sekunden
                    
                    // Prüfe ob Datei zu aktivem Stream gehört
                    let belongsToActiveStream = false;
                    let streamInfo = null;
                    
                    for (const [streamId, stream] of this.streams.entries()) {
                        if (file.startsWith(streamId)) {
                            belongsToActiveStream = true;
                            streamInfo = stream;
                            break;
                        }
                    }
                    
                    // Für aktive Streams: Lösche Segmente die älter als 30 Sekunden sind
                    if (belongsToActiveStream && file.endsWith('.ts')) {
                        // FFmpeg löscht normalerweise selbst, aber zur Sicherheit
                        if (age > 30) { // 30 Sekunden
                            fs.unlinkSync(filePath);
                            deletedCount++;
                            console.log(`🧹 Deleted old segment from active stream ${file} (${age.toFixed(1)}s old)`);
                        }
                    }
                    
                    // Für inaktive Streams: Lösche alles was älter als 10 Sekunden ist
                    if (!belongsToActiveStream && age > 10) { // 10 Sekunden
                        fs.unlinkSync(filePath);
                        deletedCount++;
                        console.log(`🧹 Deleted orphaned file: ${file} (${age.toFixed(1)}s old)`);
                    }
                    
                } catch (e) {
                    // Ignore errors for individual files
                }
            }
            
            if (deletedCount > 0) {
                console.log(`🧹 Cleaned up ${deletedCount} old files`);
            }
        } catch (e) {
            console.error("Error in cleanupOldFiles:", e.message);
        }
    }

    // Clean up inactive streams (no access for > 2 Minuten)
    cleanupInactiveStreams() {
        const now = Date.now();
        for (const [streamId, stream] of this.streams.entries()) {
            if (stream.isRestarting) continue;
            
            const inactiveTime = (now - stream.lastAccessed) / 1000;
            
            // Nach 2 Minuten Inaktivität: Stream beenden UND alle Dateien sofort löschen
            if (inactiveTime > 120) { // 2 Minuten
                console.log(`[${streamId}] Stream inactive for ${inactiveTime.toFixed(1)}s > 2 minutes, stopping and cleaning up...`);
                this.stopStream(streamId, true); // true = sofort löschen
            }
            // Nach 1 Minute Inaktivität: Warnung
            else if (inactiveTime > 60) {
                console.log(`[${streamId}] Stream inactive for ${inactiveTime.toFixed(1)}s, will stop in ${(120 - inactiveTime).toFixed(0)}s`);
            }
        }
    }

    // Update last accessed time for a stream
    updateAccess(streamId) {
        if (this.streams.has(streamId)) {
            this.streams.get(streamId).lastAccessed = Date.now();
        }
    }

    // Get existing stream or create new one
    getOrCreateStream(params) {
        const streamId = this.generateStreamId(params);
        
        if (this.streams.has(streamId)) {
            const stream = this.streams.get(streamId);
            stream.lastAccessed = Date.now();
            stream.accessCount++;
            console.log(`[Stream ${streamId}] Already running (accesses: ${stream.accessCount})`);
            return {
                streamId,
                hlsUrl: `/hls/live_${streamId}.m3u8`,
                isNew: false
            };
        }

        console.log(`[Stream ${streamId}] Starting new stream...`);
        
        // Alte Dateien dieses Streams komplett löschen
        this.cleanupStreamFiles(streamId, true); // true = sofort löschen
        
        const encryptedUser = params.user ? encrypt(params.user) : null;
        const encryptedPass = params.pass ? encrypt(params.pass) : null;
        
        const streamUrl = this.buildStreamUrl(params);
        
        let qualityKey = params.quality || 'high';
        if (!qualityPresets[qualityKey]) {
            qualityKey = Object.keys(qualityPresets)[0];
            console.log(`[Stream ${streamId}] Quality '${params.quality}' not found, using '${qualityKey}'`);
        }
        const quality = qualityPresets[qualityKey];
        
        const ffmpeg = this.startFFmpeg(streamUrl, quality, streamId);
        
        const streamInfo = {
            id: streamId,
            params: {
                host: params.host,
                port: params.port,
                ref: params.ref,
                quality: qualityKey
            },
            credentials: {
                user: encryptedUser,
                pass: encryptedPass
            },
            ffmpeg: ffmpeg,
            started: Date.now(),
            lastAccessed: Date.now(),
            accessCount: 1,
            quality: qualityKey,
            playlist: `live_${streamId}.m3u8`,
            crashCount: 0,
            restartTimer: null,
            isRestarting: false
        };
        
        this.streams.set(streamId, streamInfo);
        
        return {
            streamId,
            hlsUrl: `/hls/live_${streamId}.m3u8`,
            isNew: true
        };
    }

    // Clean up files for a specific stream
    cleanupStreamFiles(streamId, immediate = false) {
        try {
            if (!fs.existsSync(BASE_HLS_DIR)) return;
            
            const files = fs.readdirSync(BASE_HLS_DIR);
            const now = Date.now();
            let deletedCount = 0;
            
            for (const file of files) {
                if (file.startsWith(streamId) || file === `live_${streamId}.m3u8`) {
                    const filePath = path.join(BASE_HLS_DIR, file);
                    
                    try {
                        if (immediate) {
                            // Sofort löschen (bei Stream-Ende oder Neustart)
                            fs.unlinkSync(filePath);
                            deletedCount++;
                            console.log(`[${streamId}] Deleted file: ${file}`);
                        } else {
                            // Nur löschen wenn älter als 20 Sekunden
                            const stats = fs.statSync(filePath);
                            const age = (now - stats.mtimeMs) / 1000;
                            if (age > 20) { // 20 Sekunden
                                fs.unlinkSync(filePath);
                                deletedCount++;
                                console.log(`[${streamId}] Deleted old file: ${file} (${age.toFixed(1)}s old)`);
                            }
                        }
                    } catch (e) {
                        // Ignore errors
                    }
                }
            }
            
            if (deletedCount > 0) {
                console.log(`[${streamId}] Cleaned up ${deletedCount} files`);
            }
        } catch (e) {
            console.log(`[${streamId}] Error cleaning up files:`, e.message);
        }
    }

    // Build stream URL from parameters
    buildStreamUrl(params, useEncryptedCredentials = false, encryptedCreds = null) {
        const { host, port, ref } = params;
        let user = params.user;
        let pass = params.pass;
        
        if (useEncryptedCredentials && encryptedCreds) {
            user = decrypt(encryptedCreds.user);
            pass = decrypt(encryptedCreds.pass);
        }
        
        let streamUrl = `http://`;
        if (user && pass) {
            streamUrl += `${user}:${pass}@`;
        }
        streamUrl += `${host}:${port || "8001"}/${ref}`;
        return streamUrl;
    }

    // Start FFmpeg process
	startFFmpeg(streamUrl, quality, streamId) {
		const segmentFilename = path.join(
			BASE_HLS_DIR,
			`${streamId}_segment_%03d.ts`
		);
		
		const playlistPath = path.join(
			BASE_HLS_DIR,
			`live_${streamId}.m3u8`
		);

		const args = [
			"-hide_banner",
			"-loglevel", "error",
			"-reconnect", "1",
			"-reconnect_streamed", "1",
			"-reconnect_delay_max", "5",
			"-timeout", "30000000",
			"-i", streamUrl,
			"-map", "0:v:0?",
			"-map", "0:a:0?",
			"-sn", "-dn",
			
			"-c:v", quality.videoCodec,
			"-preset", quality.preset,
			"-crf", quality.crf,
			"-maxrate", quality.maxrate,
			"-bufsize", quality.bufsize,
			"-profile:v", quality.profile,
			"-level", quality.level,
			"-pix_fmt", "yuv420p",
			"-r", quality.framerate,
			"-g", quality.framerate, // Keyframe jede Sekunde
			
			"-c:a", "aac",
			"-b:a", quality.audioBitrate,
			"-ar", "48000",
			"-ac", "2",
			
			"-f", "hls",
			"-hls_time", "1",           // 1-Sekunden-Segmente (statt 2)
			"-hls_list_size", "4",       // Nur 4 Segmente in Playlist
			"-hls_flags", "delete_segments+independent_segments+omit_endlist",
			"-hls_playlist_type", "event",
			"-hls_segment_filename", segmentFilename,
			"-start_number", "1",
			"-hls_segment_type", "mpegts",
			"-hls_segment_options", "mpegts_flags=+resend_headers", // Schnellerer Start
			
			// WICHTIG für Low-Latency:
			"-flush_packets", "1",       // Sofort schreiben
			"-fflags", "nobuffer",       // Kein Puffer
			"-flags", "low_delay",       // Low-Delay Modus
			"-tune", "zerolatency",      // Zero-Latency Tuning
			
			playlistPath
		];

		console.log(`[Stream ${streamId}] FFmpeg starting with preset: ${quality.name} (LOW LATENCY MODE)`);
		console.log(`[Stream ${streamId}] Playlist: live_${streamId}.m3u8`);
		console.log(`[Stream ${streamId}] Segments: ${streamId}_segment_%03d.ts`);
        
        const ffmpeg = spawn("ffmpeg", args);
        
        ffmpeg.stderr.on("data", (data) => {
            const msg = data.toString();
            if (msg.includes("frame=")) {
                const match = msg.match(/frame=\s*(\d+)/);
                if (match) {
                    process.stdout.write(`\r[${streamId}] Frame: ${match[1]} `);
                }
            } else if (msg.includes("Error") || msg.includes("Invalid") || msg.includes("401")) {
                if (msg.includes("401")) {
                    console.error(`\n[${streamId}] ❌ Authentication failed (401)`);
                } else if (!msg.includes("webvtt")) {
                    const cleanMsg = msg.replace(/\/\/[^@]+@/, '//****:****@');
                    console.error(`\n[${streamId}] ❌ FFmpeg error:`, cleanMsg);
                }
            }
        });
        
        ffmpeg.on("exit", (code) => {
            console.log(`\n[${streamId}] FFmpeg exited (Code: ${code})`);
            
            if (!this.streams.has(streamId)) return;
            
            const stream = this.streams.get(streamId);
            
            if (stream.isRestarting) return;
            
            if (code === 0) {
                console.log(`[${streamId}] Stream ended normally`);
                this.streams.delete(streamId);
                // Sofort alle Dateien löschen
                this.cleanupStreamFiles(streamId, true);
                return;
            }
            
            stream.crashCount++;
            
            if (stream.crashCount > 5) {
                console.log(`[${streamId}] Stream crashed ${stream.crashCount} times, giving up`);
                this.streams.delete(streamId);
                this.cleanupStreamFiles(streamId, true);
                return;
            }
            
            const restartDelay = Math.pow(2, stream.crashCount - 1) * 1000;
            console.log(`[${streamId}] Stream crashed (attempt ${stream.crashCount}/5). Restarting in ${restartDelay/1000}s...`);
            
            stream.isRestarting = true;
            
            if (stream.restartTimer) {
                clearTimeout(stream.restartTimer);
            }
            
            stream.restartTimer = setTimeout(() => {
                console.log(`[${streamId}] Restarting stream...`);
                
                const streamUrl = this.buildStreamUrl(
                    stream.params,
                    true,
                    stream.credentials
                );
                
                const quality = qualityPresets[stream.params.quality] || 
                               qualityPresets[Object.keys(qualityPresets)[0]];
                
                // Alte Dateien vor Neustart löschen
                this.cleanupStreamFiles(streamId, true);
                
                const newFfmpeg = this.startFFmpeg(streamUrl, quality, streamId);
                
                stream.ffmpeg = newFfmpeg;
                stream.isRestarting = false;
                stream.restartTimer = null;
                
            }, restartDelay);
        });
        
        return ffmpeg;
    }

    // Stop a specific stream
    stopStream(streamId, immediateCleanup = false) {
        if (this.streams.has(streamId)) {
            const stream = this.streams.get(streamId);
            
            if (stream.restartTimer) {
                clearTimeout(stream.restartTimer);
                stream.restartTimer = null;
            }
            
            try {
                stream.ffmpeg.kill();
            } catch (e) {}
            
            this.streams.delete(streamId);
            console.log(`[${streamId}] Stream stopped`);
            
            // Dateien sofort löschen wenn gewünscht
            if (immediateCleanup) {
                this.cleanupStreamFiles(streamId, true);
            }
            
            return true;
        }
        return false;
    }

    // Stop all streams
    stopAllStreams() {
        for (const streamId of this.streams.keys()) {
            this.stopStream(streamId, true);
        }
        clearInterval(this.cleanupInterval);
        
        // Final cleanup of all HLS files
        try {
            if (fs.existsSync(BASE_HLS_DIR)) {
                const files = fs.readdirSync(BASE_HLS_DIR);
                for (const file of files) {
                    fs.unlinkSync(path.join(BASE_HLS_DIR, file));
                }
                console.log(`🧹 Final cleanup: deleted all files`);
            }
        } catch (e) {}
    }

    // Get status of all streams
    getStatus() {
        const status = {};
        for (const [streamId, stream] of this.streams.entries()) {
            const uptime = Math.floor((Date.now() - stream.started) / 1000);
            
            let segments = 0;
            try {
                if (fs.existsSync(BASE_HLS_DIR)) {
                    const files = fs.readdirSync(BASE_HLS_DIR);
                    segments = files.filter(f => 
                        f.startsWith(streamId) && f.endsWith('.ts')
                    ).length;
                }
            } catch (e) {}
            
            status[streamId] = {
                id: streamId,
                quality: stream.quality,
                qualityName: qualityPresets[stream.quality]?.name || stream.quality,
                host: stream.params.host,
                port: stream.params.port,
                ref: stream.params.ref,
                uptime: uptime,
                segments: segments,
                accessCount: stream.accessCount,
                lastAccessed: new Date(stream.lastAccessed).toISOString(),
                hlsUrl: `/hls/live_${streamId}.m3u8`,
                crashCount: stream.crashCount || 0,
                isRestarting: stream.isRestarting || false
            };
        }
        return status;
    }

    getQualityPresets() {
        return qualityPresets;
    }
}

// ============================================
// Initialize Stream Manager
// ============================================
const streamManager = new StreamManager();

// ============================================
// Routes
// ============================================

// Web Player URL
app.get("/player", (req, res) => {
    try {
        const { host, port, user, pass, ref, quality } = req.query;
        
        if (!host || !ref) {
            return res.status(400).send("Missing required parameters: host and ref");
        }
        
        const params = {
            host,
            port: port || "8001",
            user: user ? decodeURIComponent(user) : null,
            pass: pass ? decodeURIComponent(pass) : null,
            ref: decodeURIComponent(ref),
            quality: quality || Object.keys(qualityPresets)[0]
        };
        
        if (!qualityPresets[params.quality]) {
            params.quality = Object.keys(qualityPresets)[0];
        }
        
        const { streamId, hlsUrl } = streamManager.getOrCreateStream(params);
        
        // Get base URL (works with Easypanel/reverse proxy)
        const baseUrl = getBaseUrl(req);
        
        // Externe Stream-URL für VLC
        const externalStreamUrl = `${baseUrl}/stream?host=${encodeURIComponent(host)}&port=${port || "8001"}&user=${user ? encodeURIComponent(user) : ''}&pass=${pass ? encodeURIComponent(pass) : ''}&ref=${encodeURIComponent(ref)}&quality=${params.quality}`;
        
        // Quality Options für das Dropdown
        let qualityOptions = '';
        for (const [key, value] of Object.entries(qualityPresets)) {
            const selected = key === params.quality ? 'selected' : '';
            qualityOptions += `<option value="${key}" ${selected}>${value.name}</option>`;
        }
        
        // Description Mapping
        const descriptionMap = {};
        for (const [key, value] of Object.entries(qualityPresets)) {
            descriptionMap[key] = value.description;
        }
        const descriptionJson = JSON.stringify(descriptionMap);
        
        const fullHlsUrl = `${baseUrl}${hlsUrl}`;
        
        res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Enigma2 HLS Web Player</title>
    <style>
        body { background: #1a1a1a; color: #fff; font-family: Arial, sans-serif; padding: 20px; margin: 0; }
        .container { max-width: 1000px; margin: 0 auto; }
        video { width: 100%; background: #000; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .info { background: #333; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .stream-id { color: #4CAF50; font-family: monospace; font-size: 18px; font-weight: bold; }
        code { background: #444; padding: 15px; display: block; border-radius: 8px; margin: 10px 0; word-break: break-all; border-left: 4px solid #4CAF50; font-family: monospace; }
        .copy-btn { background: #4CAF50; color: white; border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; font-size: 16px; margin: 10px 0; transition: background 0.3s; }
        .copy-btn:hover { background: #45a049; }
        .copy-btn.copied { background: #2196F3; }
        select, button { padding: 10px 16px; font-size: 16px; border-radius: 4px; margin: 5px; border: none; }
        select { background: #444; color: #fff; cursor: pointer; }
        button { background: #4CAF50; color: white; cursor: pointer; transition: background 0.3s; }
        button:hover { background: #45a049; }
        .quality-info { color: #888; font-size: 14px; margin: 5px 0; }
        .external-box { background: #1e3a1e; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #2a5a2a; }
        .success { color: #4CAF50; font-weight: bold; }
        .note { color: #ff9800; font-style: italic; }
        .status { padding: 10px; border-radius: 4px; margin: 10px 0; font-weight: bold; }
        .status.initializing { background: #2a2a2a; color: #ff9800; }
        .status.ready { background: #1e3a1e; color: #4CAF50; }
        .status.error { background: #3a1e1e; color: #f44336; }
        .copy-feedback { opacity: 0; transition: opacity 0.3s; color: #4CAF50; margin-left: 10px; }
        .copy-feedback.show { opacity: 1; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Enigma2 HLS Web Player</h1>
        
        <div class="info">
            <h3>📊 Stream Information</h3>
            <p><strong>Stream ID:</strong> <span class="stream-id">${streamId}</span></p>
            <p><strong>Host:</strong> ${host}:${port || "8001"}</p>
            <p><strong>Service Ref:</strong> <code style="display: inline; padding: 3px 8px; background: #555;">${params.ref}</code></p>
            <p><strong>Authentication:</strong> ${user ? 'Yes' : 'No'}</p>
        </div>
        
        <div class="external-box">
            <h3>📺 External Player URL (VLC, Roku, etc.)</h3>
            <p class="note">⚠️ Copy this URL and use it in VLC (Media → Open Network Stream):</p>
            <code id="externalUrl">${externalStreamUrl}</code>
            <div style="display: flex; align-items: center;">
                <button class="copy-btn" onclick="copyExternalUrl()">📋 Copy URL</button>
                <span id="copyFeedback" class="copy-feedback">✓ Copied!</span>
            </div>
            <p><small>This URL uses the <strong>/stream</strong> endpoint - perfect for external players!</small></p>
        </div>
        
        <div class="info">
            <h3>⚙️ Quality Settings</h3>
            <select id="qualitySelect">
                ${qualityOptions}
            </select>
            <button onclick="changeQuality()">Change Quality</button>
            <div class="quality-info" id="qualityInfo">${qualityPresets[params.quality].description}</div>
        </div>
        
        <h3>🎥 Browser Preview</h3>
		<p> Note: If you get an error, please wait a second. Site will refresh automatically. It is possible that the hls conversion takes some time.</p> 
        <div id="status" class="status initializing">⏳ Initializing player...</div>
        <video id="video" controls style="width:100%;"></video>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <script>
        // Description mapping
        const descriptions = ${descriptionJson};
        
        // Elements
        const video = document.getElementById('video');
        const qualityInfo = document.getElementById('qualityInfo');
        const statusDiv = document.getElementById('status');
        const copyFeedback = document.getElementById('copyFeedback');
        const hlsUrl = '${fullHlsUrl}';
        
        // Copy to clipboard function (silent)
        function copyExternalUrl() {
            const url = document.getElementById('externalUrl').textContent;
            
            // Moderner Ansatz mit Clipboard API
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => {
                    // Zeige Feedback kurz an
                    copyFeedback.classList.add('show');
                    setTimeout(() => copyFeedback.classList.remove('show'), 2000);
                }).catch(() => {
                    fallbackCopy(url);
                });
            } else {
                fallbackCopy(url);
            }
        }
        
        function fallbackCopy(text) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            
            try {
                document.execCommand('copy');
                copyFeedback.classList.add('show');
                setTimeout(() => copyFeedback.classList.remove('show'), 2000);
            } catch (err) {
                // Still fail silently - just show the URL
                console.warn('Copy failed:', err);
            }
            
            document.body.removeChild(textarea);
        }
        
        // Quality change handler
        document.getElementById('qualitySelect').addEventListener('change', function(e) {
            qualityInfo.textContent = descriptions[e.target.value];
        });
        
        function changeQuality() {
            const quality = document.getElementById('qualitySelect').value;
            const url = new URL(window.location.href);
            url.searchParams.set('quality', quality);
            window.location.href = url.toString();
        }
        
        // Initialize player with delay
        function initPlayer() {
            statusDiv.textContent = '⏳ Loading playlist...';
            statusDiv.className = 'status initializing';
            
            fetch(hlsUrl)
                .then(response => {
                    if (response.ok) {
                        statusDiv.textContent = '✅ Playlist loaded, starting player...';
                        return response.text();
                    } else {
                        throw new Error('Playlist not found (HTTP ' + response.status + ')');
                    }
                })
                .then(text => {
                    console.log('Playlist loaded, length:', text.length);
                    
                    if (Hls.isSupported()) {
                        const hls = new Hls({
							debug: false,
							enableWorker: true,
							lowLatencyMode: true,        // Low-Latency Mode aktivieren
							backBufferLength: 10,         // Nur 10 Sekunden Rückwärtspuffer
							liveSyncDurationCount: 2,     // 2 Segmente live-synchron
							liveMaxLatencyDurationCount: 4, // Max 4 Segmente Latenz
							maxBufferLength: 10,          // Maximal 10 Sekunden puffern
							maxMaxBufferLength: 20,       // Absolutes Maximum
							manifestLoadingTimeOut: 2000,  // Schnelleres Laden
							manifestLoadingMaxRetry: 2,
							levelLoadingTimeOut: 2000,
							levelLoadingMaxRetry: 2
						});
                        
                        hls.on(Hls.Events.MANIFEST_PARSED, () => {
                            statusDiv.textContent = '✅ Ready to play';
                            statusDiv.className = 'status ready';
                            // Verzögerter Autoplay
                            setTimeout(() => {
                                video.play().catch(e => {
                                    console.log('Autoplay prevented - waiting for user interaction');
                                    statusDiv.textContent = '▶️ Click play to start';
                                });
                            }, 500);
                        });
                        
                        hls.on(Hls.Events.ERROR, (event, data) => {
                            console.error('HLS Error:', data);
                            statusDiv.textContent = '⚠️ Error: ' + (data.details || 'unknown');
                            statusDiv.className = 'status error';
                        });
                        
                        hls.loadSource(hlsUrl);
                        hls.attachMedia(video);
                        
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = hlsUrl;
                        video.addEventListener('loadedmetadata', () => {
                            statusDiv.textContent = '✅ Ready to play';
                            statusDiv.className = 'status ready';
                            setTimeout(() => {
                                video.play().catch(e => {
                                    console.log('Autoplay prevented');
                                    statusDiv.textContent = '▶️ Click play to start';
                                });
                            }, 500);
                        });
                    } else {
                        statusDiv.textContent = '❌ HLS not supported in this browser';
                        statusDiv.className = 'status error';
                    }
                })
                .catch(error => {
                    console.error('Error loading playlist:', error);
                    statusDiv.textContent = '❌ ' + error.message;
                    statusDiv.className = 'status error';
                    
                    // Retry after 3 seconds
                    setTimeout(initPlayer, 3000);
                });
        }
        
        // Start initialization with delay
        setTimeout(initPlayer, 1000);
    </script>
</body>
</html>`);
        
    } catch (err) {
        console.error("Error in /player:", err);
        res.status(500).send("Error: " + err.message);
    }
});

// External Stream URL
app.get("/stream", (req, res) => {
    try {
        const { host, port, user, pass, ref, quality } = req.query;
        
        if (!host || !ref) {
            return res.status(400).send("Missing required parameters: host and ref");
        }
        
        const params = {
            host,
            port: port || "8001",
            user: user ? decodeURIComponent(user) : null,
            pass: pass ? decodeURIComponent(pass) : null,
            ref: decodeURIComponent(ref),
            quality: quality || Object.keys(qualityPresets)[0]
        };
        
        if (!qualityPresets[params.quality]) {
            params.quality = Object.keys(qualityPresets)[0];
        }
        
        const { hlsUrl } = streamManager.getOrCreateStream(params);
        
        res.redirect(`${hlsUrl}?t=${Date.now()}`);
        
    } catch (err) {
        console.error("Error in /stream:", err);
        res.status(500).send("Error: " + err.message);
    }
});

// API endpoint to get quality presets
app.get("/api/qualities", (req, res) => {
    res.json(qualityPresets);
});

// HLS files with access tracking und CORS
app.use("/hls", (req, res, next) => {
    // CORS Header für alle HLS Anfragen
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');
    res.header('Expires', '0');
    
    const pathParts = req.path.split('/');
    if (pathParts.length >= 2) {
        const possibleStreamId = pathParts[1];
        if (possibleStreamId.match(/^[0-9a-f]{8}$/)) {
            streamManager.updateAccess(possibleStreamId);
        }
    }
    next();
}, express.static(BASE_HLS_DIR));

// Status of all streams
app.get("/api/status", (req, res) => {
    const status = streamManager.getStatus();
    res.json({
        activeStreams: streamManager.streams.size,
        streams: status,
        serverUptime: process.uptime()
    });
});

// Stop specific stream
app.get("/api/stop/:streamId", (req, res) => {
    const { streamId } = req.params;
    const stopped = streamManager.stopStream(streamId);
    res.json({ 
        stopped, 
        message: stopped ? `Stream ${streamId} stopped` : `Stream ${streamId} not found`
    });
});

// Stop all streams
app.get("/api/stop-all", (req, res) => {
    streamManager.stopAllStreams();
    res.json({ message: "All streams stopped" });
});

// Root / Home page
app.get("/", (req, res) => {
    const status = streamManager.getStatus();
    const streamsList = Object.entries(status).map(([id, info]) => `
        <tr>
            <td><code>${id}</code></td>
            <td>${info.qualityName}</td>
            <td>${Math.floor(info.uptime / 60)}:${(info.uptime % 60).toString().padStart(2, '0')}</td>
            <td>${info.segments}</td>
            <td>${info.accessCount}</td>
            <td>${info.crashCount > 0 ? `⚠️ ${info.crashCount}` : '✓'}</td>
            <td><a href="/hls/live_${id}.m3u8">Playlist</a></td>
        </tr>
    `).join('');
    
    const baseUrl = getBaseUrl(req);
    const exampleWebPlayer = `${baseUrl}/player?host=<enigma2_ip>&port=8001&user=<username>&pass=<password>&ref=<service_ref>&quality=high`;
    const exampleStreamUrl = `${baseUrl}/stream?host=<enigma2_ip>&port=8001&user=<username>&pass=<password>&ref=<service_ref>&quality=high`;
    
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Enigma2 HLS Proxy</title>
    <style>
        body { background: #1a1a1a; color: #fff; font-family: Arial; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #444; }
        th { background: #333; }
        tr:hover { background: #2a2a2a; }
        code { background: #444; padding: 2px 5px; border-radius: 3px; }
        a { color: #4CAF50; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .box { background: #333; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .example { background: #1e3a1e; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .example code { background: #2a5a2a; display: block; margin: 10px 0; padding: 10px; word-break: break-all; }
        .quality-list { background: #2a2a2a; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .quality-item { display: inline-block; background: #444; padding: 5px 10px; margin: 5px; border-radius: 4px; }
        .url-type { color: #4CAF50; font-weight: bold; }
        .tmp-note { background: #332b00; padding: 10px; border-radius: 4px; margin: 10px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Enigma2 HLS Proxy</h1>
        <p>Converts Enigma2 MPEG-TS streams to HLS for any compatible player</p>
        
        <div class="box">
            <h3>📊 Server Information</h3>
            <p>Server URL: ${baseUrl}</p>
            <p>Active Streams: ${streamManager.streams.size}</p>
            <p>Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
            <p>Temporary HLS directory: <code>${BASE_HLS_DIR}</code></p>
            <div class="tmp-note">
                <small>📁 Files are temporary and automatically cleaned up after 5 minutes of inactivity.</small>
            </div>
        </div>
        
        <div class="example">
            <h3>🔗 Available URLs</h3>
            
            <p><span class="url-type">🌐 Web Player URL</span> - For browsers with video player:</p>
            <code>${exampleWebPlayer}</code>
            
            <p><span class="url-type">📺 External Stream URL</span> - For VLC, Roku, any HLS player:</p>
            <code>${exampleStreamUrl}</code>
            
            <p><small>🔐 Replace &lt;enigma2_ip&gt;, &lt;username&gt;, &lt;password&gt;, and &lt;service_ref&gt; with your values</small></p>
            <p><small>URL-encode special characters: & → %26, $ → %24, @ → %40, : → %3A, / → %2F</small></p>
        </div>
        
        <div class="quality-list">
            <h3>⚙️ Available Quality Presets</h3>
            ${Object.entries(qualityPresets).map(([key, q]) => 
                `<span class="quality-item" title="${q.description}">${key}: ${q.name}</span>`
            ).join('')}
        </div>
        
        <h3>📡 Active Streams</h3>
        <table>
            <tr>
                <th>Stream ID</th>
                <th>Quality</th>
                <th>Uptime</th>
                <th>Segments</th>
                <th>Accesses</th>
                <th>Status</th>
                <th>HLS</th>
            </tr>
            ${streamsList || '<tr><td colspan="7">No active streams</td></tr>'}
        </table>
        
        <p>
            <a href="/api/status">📊 API Status</a> | 
            <a href="/api/qualities">⚙️ Quality Presets</a> | 
            <a href="/api/stop-all">⏹️ Stop all streams</a>
        </p>
    </div>
</body>
</html>`);
});

// Cleanup on proxy exit
process.on('SIGINT', () => {
    console.log("\nProxy shutting down...");
    streamManager.stopAllStreams();
    process.exit();
});

process.on('SIGTERM', () => {
    streamManager.stopAllStreams();
    process.exit();
});

app.listen(PORT, '0.0.0.0', () => {
    console.log("\n" + "=".repeat(70));
    console.log("🎬 Enigma2 HLS Proxy started!");
    console.log("=".repeat(70));
    console.log(`🌐 Listening on port: ${PORT}`);
    console.log(`📁 HLS directory: ${BASE_HLS_DIR}`);
    console.log("\n📁 Quality presets loaded from: quality-presets.json");
    console.log("\n🎯 Available quality presets:");
    Object.entries(qualityPresets).forEach(([key, q]) => {
        console.log(`   ${key}: ${q.name} (${q.maxrate})`);
    });
    console.log("\n🔗 URL format (replace with your domain):");
    console.log(`   🌐 Web Player:  https://<your-domain>/player?host=<enigma2_ip>&port=8001&user=<username>&pass=<password>&ref=<service_ref>&quality=<preset>`);
    console.log(`   📺 External:    https://<your-domain>/stream?host=<enigma2_ip>&port=8001&user=<username>&pass=<password>&ref=<service_ref>&quality=<preset>`);
    console.log("\n🔐 Note: Replace values and URL-encode special characters");
    console.log("   & → %26, $ → %24, @ → %40, : → %3A, / → %2F");
    console.log("\n🧹 Cleanup:");
    console.log("   - Inactive streams stopped after 2 minutes");
    console.log("   - Old segments deleted after 30 seconds");
    console.log("=".repeat(70) + "\n");
});