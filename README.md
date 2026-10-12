<div align="center">
  <img src="public/logo.png" alt="PulseReader logo" width="120" />
  <h1>PulseReader</h1>
  <p><b>A self-hosted EPUB reader with RSVP speed reading, synced across your devices.</b></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![CI](https://github.com/AlexBelguim/PulseReader/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexBelguim/PulseReader/actions/workflows/ci.yml)
</div>

PulseReader is one Docker container that hosts your epub library and the reader
app that reads it. Open it on your phone, tablet and PC, install it as an app,
and pick up where you left off on any of them. Books are cached on each device,
so reading keeps working offline.

## Features

**Speed reading (RSVP)**
- One word at a time with the Optimal Recognition Point highlighted, so your eyes never move.
- Adjustable WPM, with longer pauses after sentences, clauses, hyphenated and long words (each tunable).
- Starts from the word you tap on the page, follows you across pages and chapters, and puts you back on the page where you stopped.
- Pauses at images so you don't miss them.

**Reader**
- Font, size, weight, line spacing, margins, alignment and colour themes, including OLED black.
- Paginated or scrolling, two-page spread in landscape, fullscreen.
- Kindle-style taps on mobile: left/right edge turns the page, middle or top shows the controls.
- Page X of Y for *your* screen and font, updated when you fold/unfold a foldable or rotate.
- Table of contents, progress slider, keyboard shortcuts.

**Library and sync**
- Your books live on the server as plain files, one folder per series. Drop epubs in, and they show up.
- Series view with covers, read/unread, rename series, edit authors and covers from the app.
- Accounts for everyone in the house: one shared library, separate reading progress per person.
- Reading position and read-state sync between devices: push and pull, or a full library sync.
- Installable PWA that works offline once a book is on the device.

## Self-hosting

You need Docker. Everything runs in one container on port 3000.

```bash
git clone https://github.com/AlexBelguim/PulseReader.git
cd PulseReader
cp .env.example .env
```

Edit `.env` and set `ADMIN_PASSWORD` (and `ADMIN_USERNAME` if you don't want
`admin`). That creates the first admin account on first start:

```bash
openssl rand -base64 18
```

Optionally point `BOOKS_PATH` and `DATA_PATH` at where your epubs and the
database should live (default: `./books` and `./data` next to the compose file).
Then start it:

```bash
docker compose up -d --build
```

Open `http://<your-server>:3000`, tap **Sign in**, and use **Full Sync** to pull
your library onto that device. You stay signed in on each device until you sign
out (sessions renew while you use them), and the login form works with password
managers.

### Users

As admin, open **Sync → Users** to add accounts for other people. There's no
sign-up page: you pick their username and password and pass it on.

- **Readers** have their own reading position and read/unread state, and can add books.
- **Admins** can also rename series, edit authors, delete books and manage users.

Everyone shares the same library. If two people use one device, signing in as
the other person swaps the device's reading progress for theirs.

### Organising books

```
books/
  Mushoku Tensei/
    cover.jpg                      <- optional series cover
    Mushoku Tensei Vol 1.epub
    Mushoku Tensei Vol 1.jpg       <- optional cover for one book
    Mushoku Tensei Vol 2.epub
  Standalone Book.epub             <- books in the root are "Uncategorized"
```

The folder name is the series. Renaming or moving files on disk is fine:
books are recognised by content, so reading progress follows them. Books you
add from the app are uploaded into the right folder.

### HTTPS and reaching it from outside your home

On your home network `http://<ip>:3000` works, but browsers only allow
installing the app and running it offline over **HTTPS**. Put PulseReader
behind any HTTPS reverse proxy. Some easy options:

- **Tailscale:** `tailscale serve --bg 3000` gives you `https://<machine>.<tailnet>.ts.net`, private to your devices.
- **Cloudflare Tunnel:** point a public hostname at `http://<server-ip>:3000`.
- **Caddy:** `reader.example.com { reverse_proxy localhost:3000 }`.

The server trusts proxies on private addresses, so sign-in throttling and
secure cookies work behind them. The app also works when the proxy serves it
under a sub-path.

### TrueNAS / Unraid / Portainer

Use the compose file as a custom app. Put absolute host paths (for example
`/mnt/tank/media/books`) in `BOOKS_PATH` and `DATA_PATH`, and set `API_KEY`.
The container needs read-write access to the books folder: uploads, series
renames and covers are written there.

### Configuration

| Variable | Default | |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | First admin account, created on first start only. |
| `ADMIN_PASSWORD` | *(required on first start)* | Its password. Change it later in the app. |
| `API_KEY` | *(off)* | Key for scripts (`X-API-Key` header, acts as the first admin). |
| `PORT` | `3000` | Host port. |
| `BOOKS_PATH` | `./books` | Host folder with your epubs. |
| `DATA_PATH` | `./data` | Host folder for the SQLite database. |
| `TRUST_PROXY` | `loopback, uniquelocal` | Which proxies to trust for client IP / HTTPS. |
| `CORS_ORIGIN` | *(off)* | Only if a copy of the app on another origin talks to this server. |

### Updating

```bash
git pull
docker compose up -d --build
```

Installed apps pick up the new version the next time they're opened.

## Keyboard shortcuts

| Reader | |
|---|---|
| `←` / `→`, `PgUp` / `PgDn` | Previous / next page |
| `Esc` | Back to library |

| Speed reading | |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Skip back / forward |
| `Shift` + `←` / `→` | Previous / next page |
| `↑` / `↓` | Faster / slower |
| `R` | Restart page |
| `Esc` | Close and stay on the current word |

## Development

```bash
npm install
npm --prefix sync-server install
cp .env.example .env        # set ADMIN_PASSWORD

npm run server              # API on :3000 (reads .env)
npm run dev                 # app on :5173, proxies /api to :3000
```

`npm test` runs the tokenizer, path-safety, accounts and scanner tests, and `npm run lint`
runs ESLint. `npm start` builds the app and serves it from the server, the same
way the Docker image does.

Built with React, Vite, [epub.js](https://github.com/futurepress/epub.js),
Express and SQLite.

## License

[MIT](LICENSE)
