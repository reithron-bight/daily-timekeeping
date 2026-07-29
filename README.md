# Daily Timekeeping

Daily Timekeeping is a lightweight, browser-based timekeeping app that creates
Excel-ready daily time sheet rows.

## Privacy

The app has no accounts, server database, analytics, or shared storage. Timers,
settings, and the ten most recent history snapshots are stored only in the
user's browser.

## Features

- Start, stop, and edit one timer at a time
- Track on-clock and off-clock breaks
- Generate and copy an Excel-ready row
- Preserve a running timer after the browser closes
- Restore one of the ten most recent generated entries
- Install as a lightweight Progressive Web App

## Run locally

Install Node.js 22 or newer, then run:

```bash
npm install
npm run dev
```

Open the address shown in the terminal.

## Publish

The included GitHub Actions workflow builds and publishes the app with GitHub
Pages whenever the `main` branch changes.
