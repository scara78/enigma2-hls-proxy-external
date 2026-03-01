# Enigma2 HLS Proxy

A lightweight HTTP proxy that converts Enigma2 MPEG-TS streams to HLS format for any HLS-compatible player (VLC, Roku, web browsers, etc.).

**Happy Streaming!** 🎉

## 🎯 Features

- **Multi-Stream Support**: Multiple users can watch different channels simultaneously
- **Quality Selection**: 4 quality presets from "Ultra" to "Low" (configurable via JSON)
- **Automatic Cleanup**: Inactive streams are automatically stopped after 5 minutes
- **Dual Access Modes**:
  - Browser player with built-in video player
  - Direct HLS URL for any external player
- **REST API**: Control streams programmatically
- **Auto IP Detection**: Works on any network, shows correct local IP

## 📋 Requirements

- Node.js (v14 or higher)
- FFmpeg installed on your system

### FFmpeg Installation

#### Windows (using winget):
```bash
winget install --id Gyan.FFmpeg -e
```

#### macOS (using Homebrew):
```bash
brew install ffmpeg
```

#### Linux (Ubuntu/Debian):
```bash
sudo apt update
sudo apt install ffmpeg -y
```

#### Linux (Raspberry Pi OS):
```bash
sudo apt update
sudo apt install ffmpeg -y
```

## 🚀 Installation

```bash
# Clone or download this repository
cd enigma2-hls-proxy

# Install dependencies
npm install

# Start the proxy
npm start
```

The proxy will start on port 8080 by default.

## 📺 Usage

### Option 1: Browser Player
Open in any web browser:
```
http://[PROXY_IP]:8080/player?host=[ENIGMA2_IP]&port=8001&user=[USERNAME]&pass=[PASSWORD]&ref=[SERVICE_REF]&quality=[QUALITY]
```

### Option 2: Direct HLS URL (for VLC, Roku, etc.)
Use this URL in any HLS-compatible player:
```
http://[PROXY_IP]:8080/stream?host=[ENIGMA2_IP]&port=8001&user=[USERNAME]&pass=[PASSWORD]&ref=[SERVICE_REF]&quality=[QUALITY]
```

## 📝 Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `host` | ✅ Yes | IP address of your Enigma2 receiver | `192.168.1.4` |
| `port` | ❌ No | HTTP port of Enigma2 (default: 8001) | `8001` |
| `user` | ❌ No | Username for HTTP authentication | `root` |
| `pass` | ❌ No | Password for HTTP authentication | `MyP@ssw0rd` |
| `ref` | ✅ Yes | Service reference of the channel | `1:0:19:283D:3FB:1:C00000:0:0:0:` |
| `quality` | ❌ No | Video quality (ultra/high/medium/low) | `high` |

## 🎚️ Quality Presets

| Quality | Bitrate | Description |
|---------|---------|-------------|
| `ultra` | 8-10 Mbit/s | Best quality, higher CPU usage |
| `high` | 4-6 Mbit/s | Recommended for Full HD |
| `medium` | 2-3 Mbit/s | Good compromise |
| `low` | 1-1.5 Mbit/s | Minimal CPU usage |

You can customize these presets in `quality-presets.json`.

## 🔐 URL Encoding

If your password contains special characters, they must be URL-encoded:

| Character | Encoded |
|-----------|---------|
| `&` | `%26` |
| `$` | `%24` |
| `#` | `%23` |
| `@` | `%40` |
| `:` | `%3A` |
| `/` | `%2F` |
| `=` | `%3D` |
| `?` | `%3F` |
| `%` | `%25` |
| `+` | `%2B` |
| Space | `%20` |

**Example:**
- Original password: `MyP@ssw0rd&123$`
- URL-encoded: `MyP%40ssw0rd%26123%24`

## 🌐 Web Interface

Access `http://[PROXY_IP]:8080/` to see:
- All active streams with their IDs
- Stream statistics (uptime, segments, access count)
- Direct links to HLS playlists
- Server information
- Example URLs with placeholders

## 📊 REST API

### Get status of all streams
```
GET /api/status
```

Response:
```json
{
  "activeStreams": 2,
  "streams": {
    "abc123": {
      "id": "abc123",
      "quality": "high",
      "qualityName": "High (Recommended)",
      "host": "192.168.1.4",
      "port": "8001",
      "ref": "1:0:19:283D:3FB:1:C00000:0:0:0:",
      "uptime": 125,
      "segments": 12,
      "accessCount": 3,
      "lastAccessed": "2024-01-01T12:00:00Z",
      "hlsUrl": "/hls/live_abc123.m3u8"
    }
  },
  "serverUptime": 3600
}
```

### Get quality presets
```
GET /api/qualities
```

### Stop a specific stream
```
GET /api/stop/[STREAM_ID]
```

### Stop all streams
```
GET /api/stop-all
```

## 🔧 Advanced Features

### Multiple Concurrent Streams

The proxy supports multiple users watching different channels simultaneously. Each stream:
- Gets a unique ID based on its parameters
- Runs in its own FFmpeg process
- Creates files with stream ID prefix: `[streamId]_segment_001.ts`
- Is automatically stopped after 5 minutes of inactivity
- Can be monitored via the web interface

### Auto Cleanup

Inactive streams are automatically terminated after 5 minutes to free up system resources. A stream is considered "active" as long as its HLS playlist is being requested.

### File Structure

```
hls/
├── live_abc123.m3u8        # Playlist for stream abc123
├── abc123_segment_001.ts   # Segments for stream abc123
├── abc123_segment_002.ts
├── live_def456.m3u8        # Playlist for stream def456
├── def456_segment_001.ts   # Segments for stream def456
└── def456_segment_002.ts
```

## 📁 Project Structure

```
enigma2-hls-proxy/
├── proxy.js                 # Main proxy application
├── quality-presets.json     # Quality presets configuration
├── package.json             # Node.js dependencies
├── README.md                # This file
├── .gitignore               # Git ignore rules
└── hls/                     # Temporary HLS segments (auto-created)
    ├── live_*.m3u8
    └── *_segment_*.ts
```

## ⚠️ Important Notes

- The `hls/` directory is automatically created and managed
- All files are automatically deleted when streams end or become inactive
- Each stream's files are prefixed with its unique ID
- Make sure port 8080 is accessible in your firewall
- System resources (CPU/RAM) should be monitored when running multiple streams

## 🔥 Firewall Configuration

### Windows:
```bash
netsh advfirewall firewall add rule name="Enigma2 HLS Proxy" dir=in action=allow protocol=TCP localport=8080
```

### Linux (UFW):
```bash
sudo ufw allow 8080/tcp
```

### Linux (firewalld):
```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

## 🐛 Troubleshooting

**"401 Unauthorized" error:**
- Check username/password
- Verify URL encoding for special characters

**Stream not starting:**
- Check if FFmpeg is installed: `ffmpeg -version`
- Verify Enigma2 box is reachable: `ping [ENIGMA2_IP]`
- Check the web interface for error messages

**Poor video quality:**
- Try a higher quality preset (`ultra` or `high`)
- Check CPU usage on the proxy server
- Adjust bitrate in `quality-presets.json`

**No video in player:**
- Wait 5-10 seconds for stream to initialize
- Check if segments are being created in the `hls/` directory
- Verify the HLS URL works in VLC or another player

## 🎮 Tested Players

- ✅ VLC Media Player
- ✅ Roku Media Player
- ✅ Safari (native HLS)
- ✅ Chrome/Edge (with hls.js)
- ✅ Firefox (with hls.js)
- ✅ Any HLS-compatible IPTV app

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


## 🤝 Contributing

Feel free to submit issues and enhancement requests!

I appreciate everyone who supports me and the project! For any requests and suggestions, feel free to provide feedback.

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/default-orange.png)](https://www.buymeacoffee.com/madoe21)
