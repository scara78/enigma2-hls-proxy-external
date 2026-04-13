# AI Development Rules

## Tech Stack

- **Node.js** with **Express.js** for the HTTP server
- **FFmpeg** for MPEG-TS to HLS stream conversion
- **Native Node.js modules**: `child_process`, `fs`, `path`, `crypto`, `os`
- **No frontend framework** - Server-side rendered HTML with vanilla JavaScript
- **HLS.js** (CDN) for browser-based HLS playback

## Project Structure

- `proxy.js` - Main server file with all routes and stream management
- `quality-presets.json` - FFmpeg encoding quality configurations
- `tmp/hls/` - Temporary directory for HLS segments and playlists (auto-cleaned)
- `package.json` - Dependencies and start script

## Core Functionality

- **Stream Management**: Multi-stream support with unique stream IDs based on source parameters
- **HLS Conversion**: Converts Enigma2 MPEG-TS streams to HLS format using FFmpeg
- **Auto Cleanup**: Removes inactive streams after 2 minutes, old segments after 30 seconds
- **Credential Encryption**: In-memory AES-256-CBC encryption for user credentials
- **Quality Presets**: Configurable encoding profiles loaded from JSON file

## Development Guidelines

- **Routes**: All routes defined in `proxy.js` using Express
- **Stream Lifecycle**: Managed by `StreamManager` class with automatic restart on crashes
- **FFmpeg Parameters**: Low-latency HLS configuration with 1-second segments
- **Error Handling**: Graceful degradation with exponential backoff for stream restarts
- **CORS**: Enabled for `/hls` endpoints to support cross-origin playback
- **No Database**: All state kept in memory (streams Map)

## Key Routes

- `/` - Server status and documentation page
- `/player` - Web-based HLS player with quality selector
- `/stream` - External player URL (redirects to HLS playlist)
- `/hls/*` - Static HLS files (playlists and segments)
- `/api/status` - JSON status of all active streams
- `/api/qualities` - Available quality presets
- `/api/stop/:streamId` - Stop specific stream
- `/api/stop-all` - Stop all streams

## Library Usage Rules

- **HTTP Server**: Use Express.js for all routes and middleware
- **Process Management**: Use `child_process.spawn()` for FFmpeg processes
- **File Operations**: Use native `fs` module (sync operations acceptable for small files)
- **Encryption**: Use native `crypto` module for credential protection
- **No External State**: Keep everything in memory, no database required
- **Static Files**: Use `express.static()` for serving HLS directory

## Important Notes

- Start script is `npm start` (runs `node proxy.js`)
- Requires FFmpeg installed on system
- Requires `quality-presets.json` file to exist
- Server listens on port 8080 by default
- All HLS files are temporary and auto-deleted
