# Host IDE-beta collaboration on Linux

**Public server status: this project does not operate a public online collaboration server.** Collaboration uses a server you run yourself. The default, option **1**, shares with PCs on your local network and does not configure internet access.

This setup supports **Ubuntu, Debian, Fedora and Linux Mint**. Windows and Linux IDE-beta clients can join the same server. The server PC does not need an Arduino attached; keep it powered on while people collaborate. The session owner can separately share an Arduino attached to their IDE PC, allowing editor uploads and live views through this server. See the [host Arduino walkthrough](../../../docs/collaboration.md#share-the-host-arduino-and-live-views).

## Set up

1. Download and extract the whole [Linux server ZIP](https://github.com/misterlikyy/Homebrew_IDE/releases/download/latest/IDE-beta-collaboration-server-linux.zip).
2. Open a terminal in the extracted folder containing `compose.yaml`, `Dockerfile` and `setup-server.sh`.
3. Run `bash setup-server.sh` and choose **1** for your local network. It installs missing dependencies, generates a private creation key, and waits for the server to respond. It asks for sudo when needed.
4. Wait for **Server is running and responding**. Setup saves public connection details in `CONNECT.txt`. Keep the creation key private.
5. In IDE-beta → **Share project**, choose **PCs on the same network** and enter the **Address for all PCs**, including on the host PC. Choose **Check server**, enter the creation key and a display name, then choose **Share this project**.
6. Send an editor or viewer invitation to the people joining. They choose **Share project → Join a project**, paste the invitation, check the displayed server address and join. They do not need the server creation key.

Both PCs must be on the same local network for option 1. Opening the server address in a guest PC’s browser shows a friendly server page on new packages. `/health` works on older packages too.

Updated servers support short guest invitations. The app shows 27-character `IDE2` codes and copies the server address with them. To enable them for an existing session, its owner chooses **Replace guest invitations** after upgrading; previous guest codes are then revoked. Full invitations remain available for older apps, and owner recovery codes stay full length.

`bash setup-mint.sh` still works as a compatibility shortcut and now runs the same cross-distribution setup. The original Mint ZIP download points to the same Linux setup package.

### Upgrade an existing Mint server

Save important projects locally in the app. Extract the new server ZIP **into your existing server folder** and replace its packaged files, while keeping `.env`. Rerun `bash setup-server.sh` and choose your current mode. Use the same folder path/name so Docker keeps the same project volumes. This adds the server homepage, menu and status helpers. Older installations can continue serving the updated apps without an immediate server upgrade.

Do not delete the Docker volumes or start in a second server folder when updating. The ZIP does not contain `.env`, so it does not replace your key. Setup keeps existing generated keys.

## Supported systems and dependencies

| System | Default engine package | Compose package |
| --- | --- | --- |
| Ubuntu / Linux Mint | `docker.io` | `docker-compose-v2` |
| Debian 13+ | `docker.io` | `docker-compose` (v2+) |
| Fedora | `moby-engine` | `docker-compose` |

The script detects `/etc/os-release`, reuses a working Docker/Compose installation, and installs Buildx and OpenSSL if missing. It also checks that the Buildx version is compatible with Compose. Existing Docker CE installations on Debian/Ubuntu can use their configured `docker-compose-plugin` package. On older Debian releases whose repositories only provide Compose v1, install Docker Engine and its Compose plugin using [Docker's Debian instructions](https://docs.docker.com/engine/install/debian/) first, then rerun setup. Podman's Docker-command wrapper is not used as a replacement for Docker Engine.

Package sources: [Ubuntu Compose v2](https://packages.ubuntu.com/search?keywords=docker-compose-v2), [Debian Compose](https://packages.debian.org/stable/docker-compose), [Fedora Docker Compose](https://developer.fedoraproject.org/tools/docker/compose.html).

Check detection without installing anything:

```sh
bash setup-server.sh --check-platform
```

CI checks dependency installation and Compose configuration in Ubuntu 24.04, Debian 13 and Fedora 45 containers, plus Mint's Ubuntu-family detection. The production server container is also built and checked. Starting the Docker system service and configuring a physical host's network still happen on your own PC.

## Local-network mode

Choose **1**. Other PCs on the same trusted network use the server PC's private address, such as `http://192.168.1.20:1234`. Use that address when creating the session too, so its invitations work on other PCs. `localhost` invitations only work on the same computer.

The host's firewall may need a rule for TCP 1234 from your local subnet. Adjust these example subnet addresses to match your network:

```sh
# Ubuntu / Mint with UFW enabled
sudo ufw allow from 192.168.1.0/24 to any port 1234 proto tcp

# Fedora with firewalld enabled
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port port="1234" protocol="tcp" accept'
sudo firewall-cmd --reload
```

This mode uses HTTP on your trusted local network. It does not create a public endpoint or connect people on unrelated internet connections.

## Check or manage the server

From the extracted setup folder:

```sh
bash server.sh
```

Choose **1** to check the server. The menu also offers start, restart, stop and show private creation key. Direct commands work too:

```sh
bash server.sh status
bash server.sh start
bash server.sh restart
bash server.sh key
```

The status check should say **Server is running and responding** and print connection addresses. It checks the container locally; also open the printed `/health` URL on the **guest PC** to verify that PC can reach it. A response with `"ok":true` confirms server access. It does not validate an invitation or guarantee a proxy allows WebSockets.

**Run it from any folder:** setup prints an absolute command and saves it in `CONNECT.txt`. You can also type `bash `, drag `server.sh` from the file manager into the terminal, and press Enter.

### Missing scripts or wrong folder

If you see **No such file or directory**, open the extracted server folder in your file manager, check that it contains `compose.yaml`, and choose **Open in Terminal** there. A folder path containing spaces needs quotes:

```sh
# Example only: use your actual extracted folder name.
cd "$HOME/Desktop/ide server"
ls
```

Older Mint packages may not contain `status-server.sh` or `server.sh`. Until you update, use these commands **in the folder containing `compose.yaml`**:

```sh
sudo docker compose ps
sudo docker compose logs --tail=50 collaboration
```

The service should be **Up / healthy**. If Docker says **no configuration file provided**, you are not in that folder. To find it:

```sh
find "$HOME" -type f -name 'compose.yaml' 2>/dev/null
```

For recent logs on either package:

```sh
sudo docker compose logs --tail=100 collaboration
```

Finally, create a session and join it from another PC to confirm that edits appear on both.

### Server reachable, but the invitation does not work

Run `hostname -I` on the host to check its LAN address. Use that address, with port 1234, in the host’s **Share project** dialog before creating invitations. Ignore Docker bridge addresses such as `172.17.0.1` when you have a normal Wi-Fi/Ethernet address.

If an existing invitation uses `localhost` or `127.0.0.1`, the guest can replace **Connect to this server** with the host LAN address in the updated app. This keeps the room and access token; it works while the original session remains available. A new invitation is needed if the owner replaced codes, the session ended or it expired.

Older servers return **404** at `/`; use `/health`. New servers show a homepage with a copyable address and next steps. Localhost checks work only on the PC making the check; a guest must test the host’s LAN address. [App sharing walkthrough and troubleshooting](../../../docs/collaboration.md).

## Optional internet hosting

Option **2** configures your own domain and HTTPS. It is an advanced self-hosting option, not a public service supplied by this project.

- Point a domain you control at your network's public IP address.
- Give the server PC a stable local address and forward **TCP 80 and 443** from your router to it. Allow those ports in its firewall.
- Caddy obtains and renews the HTTPS certificate and forwards WebSocket connections. The raw server port is bound to localhost in this mode. Its configuration mount supports Fedora SELinux labelling.
- Everyone uses `https://your-domain`. Generate invitations with that address instead of an earlier LAN address.

Carrier-grade NAT or blocked inbound ports can prevent this setup from being reachable. In that case, use a VPN/tunnel with an HTTPS endpoint or another reachable host. The scripts do not configure your router, DNS provider or a tunnel automatically.

## Stop, restart and update

```sh
# Restart without removing stored projects
sudo docker compose restart collaboration

# Stop services and keep their data
bash stop-server.sh

# Start again in local-network mode
sudo docker compose up -d

# Or start again with the internet proxy
sudo docker compose --profile internet up -d
```

Services are configured to start again after reboot. When updating, extract the new package **into your existing setup folder**, retain `.env`, and run `bash setup-server.sh` again. Using the same folder keeps the Docker Compose project name and existing volumes, including those created by the original Mint package.

## Storage and access

- Shared code and hashed access tokens are stored in the persistent `projects` volume. Keep it and `.env` when updating; `docker compose down -v` removes volumes.
- The server administrator can read stored code. Public HTTPS protects transport; this is not end-to-end encryption.
- Invitations grant their stated role to anyone holding them. Keep the owner recovery code private. Replacing guest invitations disconnects guests and invalidates old codes. Ending a session deletes its server copy.
- Inactive sessions expire after 7 days without document changes. Limits are 12 connected participants, 100 files, 256 KB per file, and 1 MB of current project text.
- The IDE saves shared workspaces as local `.ideproj` files. Invite tokens stay in app memory, so keep the owner recovery code to reopen a session after closing the app. Back up important projects before server maintenance.

## Development from the repository

With Node.js 22+, run `npm ci` inside `source/`. Use `npm run collab:server` for a localhost development server, or `npm run collab:bundle` to prepare the complete hosting folder in `source/dist/server-linux/`.

The development server defaults to `127.0.0.1:1234`. Network binding needs `HOST=0.0.0.0` and a random `COLLAB_CREATE_KEY` of at least 24 characters. Use `COLLAB_DATA_DIR` for persistent storage and a reverse proxy for public HTTPS.
