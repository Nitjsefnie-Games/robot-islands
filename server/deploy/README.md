# Deploying the Robot Islands server

1. Build: `npm install && npm run build -w server`
2. Create `server/.env` from `.env.example` (set DATABASE_URL, PORT, COOKIE_SECURE=1).
3. Ensure DBs exist: `su postgres -c 'createdb -O robot_islands robot_islands'`
   (pre-create `pgcrypto`+`citext` extensions if the connecting role is not superuser).
4. Install the unit: `cp server/deploy/robot-islands-server.service /etc/systemd/system/`
   then `systemctl daemon-reload && systemctl enable --now robot-islands-server`.
5. (Later slice) nginx: add `location /api/ { proxy_pass http://127.0.0.1:5180; }`
   to the islands.nitjsefni.eu vhost.

Migrations run automatically on boot. This unit does NOT replace
robot-islands-dev.service (the Vite preview on :5173).
