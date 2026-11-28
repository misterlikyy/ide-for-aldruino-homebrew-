# Collaborate on code

[← Guides](README.md) · [Server setup](../server/README.md)

> No public online server is provided. Use your own server; option 1 is for your local network.

## Host: share your project

1. [Set up the server](../server/README.md) on a Linux PC. Keep it on and connect both PCs to the same local network.
2. Open **Share project → PCs on the same network** in IDE-beta.
3. Enter the **Address for all PCs** from setup or `CONNECT.txt`, for example `http://192.168.1.50:1234`. Use this address on the host PC too.
4. Choose **Check server**. When it says **Server reachable**, enter your display name and private creation key, then choose **Share this project**.
5. Copy an **editor** or **viewer** invitation and send it to your collaborator.

The creation key is checked when creating the session. Guests do not need it. To find it again on the server, run `bash server.sh key` in its folder.

## Guest: join the project

1. Open **Share project → Join a project**, enter a display name and paste the invitation under **Join a session**.
2. Check **Connect to this server**. It should show the host’s LAN address.
3. Choose **Check invitation server**, then **Join session**. The app backs up your current workspace before opening the shared code.

**Have an older localhost invitation?** Replace **Connect to this server** with the host’s LAN address, then join. The room and access code stay unchanged; this works if the session still exists on that server. You do not need to create another session just to fix its address. For future invitations, the host should create sessions using the LAN address.

## If it does not connect

On the **guest PC**, open the server address followed by `/health`, such as `http://192.168.1.50:1234/health`.

| What you see | What to do |
| --- | --- |
| `"ok":true` | The server is reachable from this PC. Check the invitation address. If the app says the invitation expired or is invalid, ask the owner for a current code. |
| Page will not load | Keep the server PC on; check its LAN IP, the shared network and the host firewall. Run the server status check in the [hosting guide](../source/hosting/linux/README.md#check-or-manage-the-server). |
| Server page opens but `/health` works only on the host | Check network/firewall access from the guest PC. A healthy Docker container alone does not prove other PCs can reach it. |
| `404` at the address without `/health` | Older server packages have no homepage. Use `/health`; updating the server adds a friendly homepage. |
| `No such file or directory` for a server script | Open a terminal in the extracted server folder. Older Mint packages may lack newer scripts; use the fallback commands in the hosting guide. |
| Health works, but the app keeps reconnecting | Check the exact app error. The invitation must be valid, and the network/proxy must allow the WebSocket connection. Update both apps if needed. |

**Why localhost caused trouble:** `localhost`, `127.0.0.1` and the `127.0.0.0` alias refer to the PC using them. They do not point guests to the host. Choose **Only on this PC** only when the app and server really run on one computer. For internet sharing, configure your own HTTPS server and choose **Over the internet with HTTPS**.

If your host’s LAN IP changes, check `CONNECT.txt` against `hostname -I` or run the server status command again. Enter the current address when joining. A DHCP reservation in your router can keep the host’s address stable.

<details>
<summary>Permissions, recovery and limits</summary>

Use **Share project** in the top bar to create a private session or join with an invitation code. Editors can work on code and files together, with coloured cursors and participant names. Viewers can read the project. Concurrent edits merge, and an open app reconnects after a temporary connection loss.

The owner gets separate editor, viewer, and private owner-recovery codes, and can replace guest invitations or end the session. Code is saved on the collaboration server; each person keeps their own open tabs, layout, visualization, and Arduino controls. The first version shares **code and files**, not circuit diagrams or serial data. It does not let another user upload to your board or send it commands.

**Public server status: there is currently no public online collaboration server operated by this project.** Collaboration uses your own server. The default setup, option **1**, is for PCs on the same local network; it does not configure internet access.

Download the [Linux server setup ZIP](https://github.com/misterlikyy/Homebrew_IDE/releases/download/latest/IDE-beta-collaboration-server-linux.zip), extract it on **Ubuntu, Debian, Fedora or Linux Mint**, and run `bash setup-server.sh`. See the [Linux hosting guide](../source/hosting/linux/README.md) for setup, status checks, firewall instructions and optional internet hosting. The old Mint ZIP link and `setup-mint.sh` remain compatibility shortcuts.

Invitations grant access to anyone who has them. Credentials stay in app memory and are not included in `.ideproj` files; keep your owner recovery code if you want to reopen the same session later. Local drafts are backed up before joining, and **Open recovered local draft** can restore a draft after leaving. Project limits are 100 files, 256 KB per file, 1 MB of current text, and 12 connected participants. Server storage is readable by its administrator; transport uses HTTPS for public servers.


</details>
