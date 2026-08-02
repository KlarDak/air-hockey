# Air Hockey

A fast neon browser air hockey game with a computer opponent and direct peer-to-peer multiplayer over WebRTC.

Test the game here: [https://wwbt-blog.ru/sandbox/air-hockey/](https://wwbt-blog.ru/sandbox/air-hockey/).

## Multiplayer

Challenge a friend in a direct online match without registration or accounts. One player creates a room and shares its six-character code; the second player enters the code, and the game establishes a peer-to-peer WebRTC connection between their browsers.

The host runs the authoritative simulation while the guest sends striker input and receives synchronized puck, score, and sound events. The included server is only responsible for creating temporary rooms and exchanging connection data — gameplay traffic travels directly between the two players.

## Preview

<img src="assets/setup.png" alt="Air Hockey match setup screen" width="640">

### Gameplay

<img src="assets/gameplay.png" alt="Air Hockey gameplay screenshot" width="640">

## Running the Game

```powershell
npm install
npm run dev
```

After starting the server, open `http://127.0.0.1:5173`.

To play from another device on the same network, open the `Network` address printed by the server.

## Changing the Port

The server listens on every network interface and uses port `5173` by default. To select another port:

```powershell
$env:PORT=5174
npm run dev
```

## Mechanics

- Move the mint striker with a mouse, pen, or touch input;
- Choose between classic 1 VS 1 and a shared-field 3 VS 3 team mode;
- In 3 VS 3, every striker can cross the center line and play anywhere on the shared field;
- The player acts as the forward, supported by an AI goalkeeper and midfielder;
- The player striker is blue in 3 VS 3, while AI teammates remain mint for quick identification;
- The opposing team uses its own goalkeeper, midfielder, and forward roles;
- Allied bots look for passes toward the player instead of simply chasing the puck together;
- The first player to score seven goals wins;
- Rookie, Pro, and Legend computer difficulty levels are available;
- The puck reacts to striker velocity and loses speed gradually;
- Synthesized Web Audio effects play on striker, rail, and goal contacts;
- A contact-based release system prevents the puck from becoming trapped against rails;
- The computer briefly retreats only after a real puck overlap in a top corner;
- The match can be paused, restarted, or returned to the main menu;
- Mobile devices use a lighter half-resolution canvas while rendering at up to 60 FPS.

## Direct Match

Direct Match connects two browsers through a WebRTC DataChannel:

Direct Match uses the classic 1 VS 1 ruleset. The multiplayer control is disabled while 3 VS 3 is selected, because the team mode is currently available only in single-player.

1. One player selects **Create match** and copies the six-character room code.
2. The other player selects **Join match** and enters that code.
3. The host simulates the authoritative game state, while the guest sends striker input.

The included Node.js server is used only to serve the game and exchange the WebRTC offer and answer. Game input, snapshots, and sound events travel directly between the browsers after the connection opens. Rooms are stored in memory and expire after ten minutes.

Some networks may block direct peer-to-peer connections. A TURN relay would be required for guaranteed internet connectivity through strict or symmetric NAT configurations.

## Building

```powershell
npm run build
```

The source is split into focused TypeScript modules:

- `audio.ts` — synthesized sound effects;
- `config.ts` — board constants and device settings;
- `game.ts` — simulation, physics, AI, rendering, and game state;
- `network.ts` — rooms, WebRTC, input, and snapshots;
- `types.ts` — shared TypeScript types;
- `ui.ts` — DOM element references;
- `main.ts` — application wiring and event handlers.

Despite the module structure, esbuild bundles the browser code into a single `dist/air-hockey.js` file. The server is built separately as `dist/server.js`.

## Deploying on a VPS

Multiplayer requires the Node.js server: uploading only the static files is not enough because `server.ts` provides the temporary room API used to exchange WebRTC connection data.

The production templates in `deploy/` assume that the project is uploaded to `/var/www/air-hockey`, Node.js listens on `127.0.0.1:5174`, and Nginx exposes it at `https://wwbt-blog.ru/sandbox/air-hockey/`.

```bash
cd /var/www/air-hockey
npm ci
npm run build

sudo cp deploy/air-hockey.service /etc/systemd/system/air-hockey.service
sudo systemctl daemon-reload
sudo systemctl enable --now air-hockey
```

Copy the two `location` blocks from `deploy/nginx-air-hockey.conf` into the existing HTTPS `server` block for the domain, then validate and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Verify the room API:

```bash
curl -i -X POST https://wwbt-blog.ru/sandbox/air-hockey/api/rooms \
  -H 'Content-Type: application/json' \
  --data '{"offer":{"type":"offer","sdp":"test"}}'
```

The response should have status `201` and contain a six-character room code.

## Using the Game in Another Project

Another developer can integrate the game without using the included Node.js server for solo play:

1. Run `npm run build` and copy `dist/air-hockey.js` into the target project.
2. Copy `index.html`, `styles.css`, and `favicon.svg` or move the required game markup into an existing page.
3. Load the bundle after the required HTML elements are available: `<script defer src="./air-hockey.js"></script>`.

The script expects a `720 × 1120` canvas with the ID `game` and the controls defined in `index.html`. The canvas scales responsively through CSS. Audio is generated with Web Audio and requires no external sound files.

Direct Match additionally requires the room API implemented in `server.ts`, or a compatible signaling service exposing the same endpoints.
