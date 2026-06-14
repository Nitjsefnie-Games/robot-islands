# Deploying the Robot Islands auth server

The unit is named **`robot-islands-auth.service`** (HTTP on `127.0.0.1:5180`).
It is intentionally NOT `robot-islands-server.service` — that name is already
taken by the separate `/root/islands` rewrite (a websocket server on `:8090`).

1. Build: `npm install && npm run build -w server` (typecheck only — `tsc --noEmit`; the unit runs the TS directly via tsx, there is no `dist/`)
2. Create `server/.env` from `.env.example` (set DATABASE_URL, PORT, COOKIE_SECURE=1).
3. Ensure DBs exist: `su postgres -c 'createdb -O robot_islands robot_islands'`
   (pre-create `pgcrypto`+`citext` extensions if the connecting role is not superuser).
4. Install the unit:
   `cp server/deploy/robot-islands-auth.service /etc/systemd/system/`
   then `systemctl daemon-reload && systemctl enable --now robot-islands-auth`.
5. nginx: add this `location` to the islands.nitjsefni.eu vhost. The
   `X-Forwarded-For` header MUST be set to `$remote_addr` (the real peer),
   **replacing** any client-supplied value — NOT the appending
   `$proxy_add_x_forwarded_for`. The app runs with `trustProxy: 1`, so it
   reads the rightmost XFF entry as the client IP; if nginx appended instead of
   replacing, a client could inject a leftmost entry, but with `trustProxy: 1`
   (one trusted hop) the app already ignores it. Setting `$remote_addr` makes
   the chain unambiguous and is the supported config:
   ```nginx
   location /api/ {
       proxy_pass http://127.0.0.1:5180;
       proxy_set_header X-Forwarded-For $remote_addr;   # replace, do NOT append
       proxy_set_header X-Real-IP $remote_addr;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;          # WS intent channel
       proxy_set_header Connection "upgrade";
   }
   ```

Notes:
- `/usr/bin/node` on this box is v12 (too old for Fastify 5); the unit uses the
  nvm node at `/root/.nvm/versions/node/v22.22.0/bin/node`, like
  robot-islands-dev.service. It runs the TypeScript entrypoint directly via the
  tsx loader (`node --import tsx .../server/src/index.ts`) so the server can
  import the client's pure `src/` layer across the workspace boundary — there is
  no compiled `dist/` to ship; `npm run build -w server` only typechecks.
- Migrations run automatically on boot.
- This unit does NOT replace robot-islands-dev.service (the Vite preview on :5173)
  or robot-islands-server.service (the /root/islands rewrite on :8090).
