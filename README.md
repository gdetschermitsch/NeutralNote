# NeutralNote (HTML5)

NeutralNote is a browser-based transcription and bite-capture tool by CRUXTAIN™ for documenting public debate and discourse sessions between consenting participants.

## Recommended browser

Use **Chrome or Edge** for GitHub Pages deployment.

Speech recognition support is browser-dependent, and Firefox/Safari may load the interface while still failing to provide live transcription.

## What it does

- Captures bite audio and the input meter from a selected audio device
- Runs live browser speech recognition
- Creates transcript bites with approximate matching audio clips
- Lets the user manually assign a speaker to each bite
- Exports the session as JSON with timestamps and embedded bite audio
- Persists topic title, speakers, language, and preferred device in local storage


## Important microphone behavior

NeutralNote uses two separate browser pathways:

- The **selected audio device** is used for the bite-audio capture and the input meter.
- **Live transcription** is handled by the browser speech-recognition engine, which may still follow the browser or operating system default microphone.

Because of that browser limitation, the device selector should not be treated as a guaranteed speech-recognition routing control.






## Important limitations

NeutralNote is a pure browser app.

That means:

- Speech transcription quality depends on the browser speech engine
- Transcript-to-audio alignment is approximate, not forensic-grade
- This app exports **JSON plus embedded bite audio**, not video rendering
- Chromium-based browsers are strongly preferred for consistent behavior

## Export format

Export creates a single JSON file containing:

- topic title
- speakers present
- session start/end
- browser name used for export
- all bites
- each bite's text, speaker, range, and audio as a Data URL
