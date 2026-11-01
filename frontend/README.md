# MiniStore — Frontend

React 19 + TypeScript + Vite + Tailwind CSS v4. A single-page app to sign up, upload, browse,
download, and delete files. See the [root README](../README.md) for the big picture.

## Structure

```
frontend/
├── index.html          HTML shell; loads src/main.tsx
├── vite.config.ts      React + Tailwind plugins, and the /api → :3000 dev proxy
└── src/
    ├── main.tsx        Mounts <App /> into #root
    ├── App.tsx         Shows <Auth /> or <Files /> depending on whether a token exists; <Logo />
    ├── Auth.tsx        Sign-in / create-account form
    ├── Files.tsx       Upload zone, upload progress, search, file grid, download/delete
    ├── api.ts          Every call to the backend, token storage, error handling
    └── index.css       Tailwind import, dark-mode colours, brand gradient, entrance animation
```

## How it works

**Talking to the API.** All requests go to `/api/...`. In development, Vite's proxy forwards them
to the backend on port 3000 and strips the `/api` prefix. The browser sees one origin, so the
backend needs no CORS configuration.

**Auth state.** After login the JWT is saved in `localStorage` and `api.ts` fires an `auth-change`
event. `App.tsx` listens for it and switches between the login screen and the files screen. There
is no router — there are only two screens. If any request returns `401` (e.g. the token expired
after 1 hour), the token is cleared and the user lands back on the login screen.

**Uploads.** `api.upload` uses `XMLHttpRequest` instead of `fetch` because `fetch` can't report
upload progress. Several files upload in parallel, each with its own progress bar; each finished
upload is added to the top of the grid without reloading the list.

**Downloads.** The file is fetched with the JWT, turned into a Blob, and saved through a temporary
`<a download>` link. (Phase 4 will switch to presigned URLs so the browser downloads directly
from MinIO.)

**Errors.** The backend always responds with `{ "error": "..." }`. `api.ts` turns that into an
`ApiError`, and the UI shows the message in a dismissible banner.

## Design

- **One accent colour** (teal) for links, borders and outlined buttons; **one gradient**
  (indigo → purple → pink) reserved for the logo, the main button and the upload area.
- **Dark mode** follows the operating-system setting and uses layered near-black surfaces
  (page `#0a0a0a` → card `#141414` → input `#1c1c1c`) rather than one flat grey.
- **Motion:** cards fade/slide in with a stagger and lift on hover; buttons press down on click.
  All of it is disabled for users who enable "reduce motion".
- Text colours were checked against WCAG AA contrast in both themes.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on http://localhost:5173 (backend must be running on :3000) |
| `npm run build` | Type-check, then build static files into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

## Known limitations

- Token in `localStorage` can be read by any script injected into the page (XSS). Moving to an
  httpOnly cookie is planned for the security phase.
- The list shows the newest 100 files; there is no pagination yet.
- There is no production server config yet — `dist/` needs a web server that also proxies `/api`.
