# Deploying the Robot Islands auth server

The unit is named **`robot-islands-auth.service`** (HTTP on `127.0.0.1:5180`).
It is intentionally NOT `robot-islands-server.service` — that name is already
taken by the separate `/root/islands` rewrite (a websocket server on `:8090`).

1. Build: `npm install && npm run build -w server`
2. Create `server/.env` from `.env.example` (set DATABASE_URL, PORT, COOKIE_SECURE=1).
3. Ensure DBs exist: `su postgres -c 'createdb -O robot_islands robot_islands'`
   (pre-create `pgcrypto`+`citext` extensions if the connecting role is not superuser).
4. Install the unit:
   `cp server/deploy/robot-islands-auth.service /etc/systemd/system/`
   then `systemctl daemon-reload && systemctl enable --now robot-islands-auth`.
5. (Later slice) nginx: add `location /api/ { proxy_pass http://127.0.0.1:5180; }`
   to the islands.nitjsefni.eu vhost.

Notes:
- `/usr/bin/node` on this box is v12 (too old for Fastify 5); the unit uses the
  nvm node at `/root/.nvm/versions/node/v22.22.0/bin/node`, like
  robot-islands-dev.service.
- Migrations run automatically on boot.
- This unit does NOT replace robot-islands-dev.service (the Vite preview on :5173)
  or robot-islands-server.service (the /root/islands rewrite on :8090).
