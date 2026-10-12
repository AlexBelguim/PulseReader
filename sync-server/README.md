# PulseReader server

The Express + SQLite server behind PulseReader. It serves the built web app,
indexes the epubs in the books folder (one folder per series), and stores
reading progress so every device can sync.

You normally don't run this directly: the Docker image in the repo root builds
the web app and this server together. See the [main README](../README.md) for
setup.

## Running from a checkout

```bash
npm install
npm run dev        # reads ../.env, restarts on change
```

Without a built app (`npm run build` in the repo root) the server runs API-only.

| Variable | Default | |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / *(required on first start)* | First admin account. |
| `API_KEY` | *(off)* | Script key; requests with it act as the first admin. Also the admin password when upgrading from before accounts. |
| `PORT` | `3000` | |
| `BOOKS_DIR` | `./data/books` | Epub library, one folder per series. |
| `DATA_DIR` | `./data` | The database is kept in `DATA_DIR/db/`. |
| `WEB_DIR` | `../dist` | Built web app to serve. |
| `TRUST_PROXY` | `loopback, uniquelocal` | Express `trust proxy` setting. |
| `CORS_ORIGIN` | *(off)* | Comma-separated origins allowed to call the API cross-origin. |

## API

Everything under `/api` needs either the session cookie from signing in or
`API_KEY` as `X-API-Key: <key>` / `Authorization: Bearer <key>` (for scripts).
Reading progress is per user. Routes marked *admin* return 403 for readers.

```
GET    /health                    # { status, app, version }, no auth

GET    /api/auth/me               # { authenticated, user }
POST   /api/auth/login            # { username, password } -> sets session cookie
POST   /api/auth/logout
PUT    /api/auth/password         # { currentPassword, newPassword }

GET    /api/users                 # admin
POST   /api/users                 # admin: { username, password, role }
PUT    /api/users/:id             # admin: { role?, password? }
DELETE /api/users/:id             # admin

GET    /api/books                 # all books with progress
GET    /api/books/:id
GET    /api/books/:id/download    # the epub
GET    /api/books/:id/cover
POST   /api/books                 # multipart: title, author, series, epub, cover
PUT    /api/books/:id             # admin: { title?, author?, series? } (series moves the file)
PUT    /api/books/:id/cover       # multipart: cover
PUT    /api/books/series/rename   # admin: { oldName, newName } (moves the folder)
DELETE /api/books/:id             # admin; ?deleteFile=true also removes it from disk

GET    /api/progress
GET    /api/progress/:bookId
PUT    /api/progress/:bookId      # { location, progress }

GET    /api/sync/status           # books + progress for the client to reconcile
POST   /api/sync/rescan           # rescan the books folder
POST   /api/sync/progress         # { progress: [...], force }
```

## Tests

```bash
npm test
```
