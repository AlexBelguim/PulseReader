# PulseReader Sync Server

A lightweight, self-hosted sync server for PulseReader. Run it on your TrueNAS, Raspberry Pi, or any Docker host to sync your epub library and reading progress across devices.

## Features

- **File-based library**: Organize epubs in folders by series — the server scans and indexes them automatically
- **Custom covers**: Drop a `cover.jpg` in a series folder, or name it the same as the epub
- **Reading progress sync**: Last-write-wins conflict resolution across devices
- **Simple API key auth**: Secure your server with a single API key
- **Docker-ready**: Runs as a lightweight container (~50MB)

## Folder Structure

Place your epub files in the `books/` directory (or the mounted volume):

```
books/
  Mushoku Tensei/
    cover.jpg                              ← optional series cover
    Mushoku Tensei Vol 1.epub
    Mushoku Tensei Vol 2.epub
  That Time I Got Reincarnated as a Slime/
    That Time I Got Reincarnated as a Slime Vol 1.epub
    That Time I Got Reincarnated as a Slime Vol 1.jpg  ← optional per-book cover
    That Time I Got Reincarnated as a Slime Vol 2.epub
  Standalone Book.epub                     ← books in root go to "Uncategorized"
```

### Cover Image Priority
1. Per-book cover: `BookTitle.jpg` (same name as the epub)
2. Series cover: `cover.jpg` in the series folder
3. No cover: PulseReader will extract one from the epub metadata

Supported image formats: `.jpg`, `.jpeg`, `.png`, `.webp`

## Quick Start with Docker Compose

```yaml
version: '3.8'
services:
  pulsereader-sync:
    build: .
    container_name: pulsereader-sync
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /path/to/your/books:/data/books
      - pulsereader-db:/data/db
    environment:
      - API_KEY=your-secure-api-key-here

volumes:
  pulsereader-db:
```

```bash
docker compose up -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `API_KEY` | *(empty)* | API key for authentication. **Set this!** |
| `BOOKS_DIR` | `/data/books` | Path to the books directory |
| `DATA_DIR` | `/data` | Path to the data directory (contains db) |

## TrueNAS SCALE Setup

1. Create a dataset for your books (e.g., `tank/media/books`)
2. Create a dataset for the database (e.g., `tank/apps/pulsereader`)
3. Deploy as a custom Docker app:
   - Image: Build from this directory or push to your registry
   - Port: `3000:3000`
   - Volume: `/mnt/tank/media/books` → `/data/books`
   - Volume: `/mnt/tank/apps/pulsereader` → `/data/db`
   - Environment: `API_KEY=your-secure-key`

## API Endpoints

### Health Check
```
GET /health
```

### Books
```
GET    /api/books              # List all books
GET    /api/books/:id          # Get book metadata
GET    /api/books/:id/download # Download epub file
GET    /api/books/:id/cover    # Get cover image
POST   /api/books              # Upload new book (multipart: epub + cover)
PUT    /api/books/:id          # Update metadata
DELETE /api/books/:id          # Delete book (?deleteFile=true to remove from disk)
```

### Reading Progress
```
GET  /api/progress             # Get all progress
GET  /api/progress/:bookId     # Get progress for a book
PUT  /api/progress/:bookId     # Update progress
```

### Sync
```
GET  /api/sync/status          # Get full sync status (books + progress)
POST /api/sync/rescan          # Rescan books folder
POST /api/sync/progress        # Batch sync progress
```

### Authentication

All `/api/*` endpoints require authentication when `API_KEY` is set.

Include the key in your request:
```
X-API-Key: your-api-key
```
or
```
Authorization: Bearer your-api-key
```

## Connecting from PulseReader

1. Open PulseReader in your browser
2. Click the **Sync** button in the library
3. Enter your server URL (e.g., `http://192.168.1.50:3000`)
4. Enter your API key
5. Click **Test Connection** to verify
6. Enable sync and optionally enable auto-sync
7. Click **Sync Now** to perform the first sync

## Development

```bash
npm install
npm run dev
```

The server will start with file watching enabled for development.
