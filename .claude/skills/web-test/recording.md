# Video Recording

Record browser automation sessions as MP4 video files. Uses CDP `Page.startScreencast` to capture JPEG frames and pipes them to ffmpeg for encoding.

## Prerequisites

**ffmpeg** must be installed. The binary is resolved in this order:

1. `opts.ffmpegPath` parameter in `startRecording()`
2. `FFMPEG_PATH` environment variable
3. `ffmpeg` in system PATH
4. `tools/ffmpeg/bin/ffmpeg.exe` relative to project root

### Install ffmpeg on Windows

Download from https://ffmpeg.org/download.html (Windows builds by gyan.dev or BtbN).
Extract and either:
- Add `bin/` to system PATH
- Set environment variable: `$env:FFMPEG_PATH = "C:\tools\ffmpeg\bin\ffmpeg.exe"`
- Place in project: `tools/ffmpeg/bin/ffmpeg.exe`

### Shared path via .v8-project.json

To avoid installing per-project, add `ffmpegPath` to `.v8-project.json`:

```json
{
  "v8path": "...",
  "ffmpegPath": "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
  "databases": [...]
}
```

When calling `startRecording()`, read this field and pass it:

```js
await startRecording('output.mp4', { ffmpegPath: 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe' });
```

## API

### `startRecording(outputPath, opts?)`

Start recording the browser viewport to an MP4 file.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `outputPath` | string | required | Output .mp4 file path |
| `opts.fps` | number | 25 | Target framerate |
| `opts.quality` | number | 80 | JPEG quality (1-100) |
| `opts.ffmpegPath` | string | auto | Explicit path to ffmpeg binary |

- Output directory is created automatically if it doesn't exist
- Throws if already recording or browser not connected
- Recording auto-stops when `disconnect()` is called

### `stopRecording()` → `{ file, duration, size }`

Stop recording and finalize the MP4 file.

| Return field | Type | Description |
|-------------|------|-------------|
| `file` | string | Absolute path to the MP4 file |
| `duration` | number | Recording duration in seconds |
| `size` | number | File size in bytes |

### `isRecording()` → boolean

Check if recording is active.

### `showCaption(text, opts?)`

Display a text overlay on the page (visible in recording). Calling again updates the text.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | required | Caption text |
| `opts.position` | `'top'` \| `'bottom'` | `'bottom'` | Vertical position |
| `opts.fontSize` | number | 24 | Font size in px |
| `opts.background` | string | `'rgba(0,0,0,0.7)'` | Background color |
| `opts.color` | string | `'#fff'` | Text color |

The overlay uses `pointer-events: none` — does not interfere with clicking.

### `hideCaption()`

Remove the caption overlay.

## Example: Record a workflow with captions

```js
await startRecording('recordings/create-order.mp4');

await showCaption('Step 1: Navigate to Sales');
await navigateSection('Продажи');
await wait(1);

await showCaption('Step 2: Open Customer Orders');
await openCommand('Заказы клиентов');
await wait(1);

await showCaption('Step 3: Create new order');
await clickElement('Создать');
await wait(2);

await showCaption('Step 4: Fill header fields');
await fillFields({ 'Организация': 'Конфетпром', 'Контрагент': 'Альфа' });
await wait(2);

await hideCaption();
const result = await stopRecording();
console.log(`Recorded ${result.duration}s, ${(result.size / 1024 / 1024).toFixed(1)} MB`);
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "ffmpeg not found" | Install ffmpeg and ensure it's discoverable (see Prerequisites) |
| Recording file is 0 bytes | Check that output path is writable. ffmpeg may have crashed |
| Video is choppy | Add `wait()` between steps. Reduce `quality` for faster capture |
| "Already recording" | Call `stopRecording()` before starting a new recording |
| Recording stops on disconnect | Expected — auto-stop prevents orphaned ffmpeg processes |
